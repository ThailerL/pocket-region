// Generates vendor/: every wheel the emulator needs, beside meta.json. The runtime itself is
// the pyodide dependency. The set is resolved by really installing it under the pinned
// Pyodide and freezing the environment.
//
// Bumping the pyodide dependency or EMULATOR_SPEC is a deliberate release act: ministack
// stamps a format version on each service's state file and starts that service empty when
// the stamps disagree, so a bump can cost user data. Never let these pins drift.
//
// PYTHON_RUNTIME_SPEC is what a Python function's environment preinstalls, as Lambda's runtime
// does. Its set is resolved the same way but only named in meta.json, by URL and checksum:
// botocore alone is 16 MB, so a host fetches it the first time a Python function runs.
//
// Requires network and an up-to-date npm install. Idempotent - a no-op unless the pins
// changed or --force is passed.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPyodide } from 'pyodide';

const require = createRequire(import.meta.url);
const PYODIDE_VERSION = require('../package.json').dependencies.pyodide;
const PYODIDE_DIRECTORY = path.dirname(require.resolve('pyodide/package.json'));
const EMULATOR_SPEC = 'ministack==1.5.12';
const EMULATOR_NAME = EMULATOR_SPEC.split('==')[0];
const PYTHON_RUNTIME_SPEC = 'boto3==1.43.97';
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

// Resolved as the emulator's dependency but left out of the tree. botocore is half the
// payload and the slowest wheel to install, and nothing we serve imports it: it is lazy,
// reached only from the glue, lambda-runtime and IAM paths. Verified by booting the region
// and exercising S3, SQS and DynamoDB without it
// micropip only resolves the set here; the region loads the wheels without it
const EXCLUDED_PACKAGES = ['botocore', 'micropip'];

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const OUTPUT_DIRECTORY = path.join(ROOT, 'vendor');
const METADATA_FILE = path.join(OUTPUT_DIRECTORY, 'meta.json');
// The runtime's own stdlib zip, with bytecode added beside what the region imports
const STDLIB_FILE = 'python_stdlib.zip';

const force = process.argv.includes('--force');
const log = (message) => process.stderr.write(`[vendor] ${message}\n`);

function fail(message) {
	log(message);
	process.exit(1);
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

// PEP 503: micropip and the lockfiles disagree on dashes vs underscores
function canonical(name) {
	return name.toLowerCase().replace(/[-_.]+/g, '-');
}

if (!force && fs.existsSync(METADATA_FILE)) {
	const metadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
	if (
		metadata.pyodideVersion === PYODIDE_VERSION &&
		metadata.emulatorSpec === EMULATOR_SPEC &&
		metadata.pythonRuntimeSpec === PYTHON_RUNTIME_SPEC &&
		metadata.stdlib === STDLIB_FILE
	) {
		log(`up to date - pyodide ${PYODIDE_VERSION}, ${EMULATOR_SPEC}, ${PYTHON_RUNTIME_SPEC} (--force to rebuild)`);
		process.exit(0);
	}
	log(`pins changed: regenerating`);
}

const installedVersion = require('pyodide/package.json').version;
if (installedVersion !== PYODIDE_VERSION) {
	fail(`pyodide ${installedVersion} is installed but ${PYODIDE_VERSION} is pinned: run npm install`);
}

// Pyodide compiles every module it imports from source on each boot and never caches the
// bytecode, so an unchecked-hash pyc beside each source it touched takes that off the boot.
// Only what the boot, a first request and a first reset import, to keep the payload down; a
// service's other lazy imports compile once on its first request. The pycs are tied to the
// pinned CPython, and the installer
// keeping them is measured, not documented: after a Pyodide bump, a boot over 0.6 s means
// they are ignored
const PRECOMPILE = `
import importlib.util, os, sys, zipfile
from importlib._bootstrap_external import _code_to_hash_pyc

SITE = next(p for p in sys.path if p.endswith("site-packages")) + "/"
STDLIB = next(p for p in sys.path if p.endswith(".zip")) + "/"
used = {m.__file__ for m in list(sys.modules.values()) if getattr(m, "__file__", None)}

def precompile(source, target, root, cache_path):
    count = 0
    with zipfile.ZipFile(source) as src, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as dst:
        for info in src.infolist():
            data = src.read(info)
            dst.writestr(info, data)
            if info.filename.endswith(".py") and root + info.filename in used:
                code = compile(data, root + info.filename, "exec", dont_inherit=True)
                pyc = _code_to_hash_pyc(code, importlib.util.source_hash(data), checked=False)
                dst.writestr(cache_path(info.filename), pyc)
                count += 1
    return count

count = 0
for name in os.listdir("/in/wheels"):
    count += precompile(f"/in/wheels/{name}", f"/out/wheels/{name}", SITE, importlib.util.cache_from_source)
# zipimport takes a pyc beside its source, with no __pycache__ directory
count += precompile("/in/stdlib.zip", "/out/stdlib.zip", STDLIB, lambda name: name[:-3] + ".pyc")
count
`;

// Boots the region as createRegion does, from the wheels just written, and rewrites them and
// the stdlib zip with bytecode for what that boot imported
async function precompile(wheels) {
	const py = await loadPyodide({ packageCacheDir: OUTPUT_DIRECTORY });
	py.setStdout({ batched() {} });
	py.setStderr({ batched() {} });
	await py.loadPackage(
		wheels.map((file) => path.join(OUTPUT_DIRECTORY, file)),
		{ messageCallback() {} }
	);
	py.globals.set('STATE_ROOT', '/state');
	py.globals.set('REGION_PORT', 4566);
	for (const file of ['threads.py', 'helpers.py']) {
		await py.runPythonAsync(fs.readFileSync(path.join(ROOT, 'python', file), 'utf8'));
	}
	await py.runPythonAsync('await lifespan("startup")');
	// ministack imports CloudFormation on every service's first request and GraphQL on the first
	// reset: from source, that took 1.4 s on a desktop and timed tests out in CI
	await py.runPythonAsync(`
await asgi_request("PUT", "/precompile", {"host": "localhost:4566", "authorization": "AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=test"}, b"")
await asgi_request("POST", "/_ministack/reset", {"host": "localhost:4566"}, b"")
`);

	py.FS.mkdirTree('/in/wheels');
	py.FS.mkdirTree('/out/wheels');
	for (const file of wheels) {
		py.FS.writeFile(`/in/wheels/${file}`, fs.readFileSync(path.join(OUTPUT_DIRECTORY, file)));
	}
	py.FS.writeFile('/in/stdlib.zip', fs.readFileSync(path.join(PYODIDE_DIRECTORY, 'python_stdlib.zip')));
	const count = await py.runPythonAsync(PRECOMPILE);
	for (const file of wheels) {
		fs.writeFileSync(path.join(OUTPUT_DIRECTORY, file), py.FS.readFile(`/out/wheels/${file}`));
	}
	fs.writeFileSync(path.join(OUTPUT_DIRECTORY, STDLIB_FILE), py.FS.readFile('/out/stdlib.zip'));
	await py.runPythonAsync('await lifespan("shutdown")');
	return count;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-region-vendor-'));

// Installs a spec under the pinned Pyodide in a child, since wheel-loading noise goes to
// stdout. list() names what is actually installed; freeze() knows each PyPI wheel's URL
function resolve(spec) {
	const listScript = path.join(work, 'list.mjs');
	const listFile = path.join(work, 'installed.json');
	fs.writeFileSync(
		listScript,
		`import fs from 'node:fs';
import { loadPyodide } from ${JSON.stringify(pathToFileURL(path.join(PYODIDE_DIRECTORY, 'pyodide.mjs')).href)};
const py = await loadPyodide({ packageCacheDir: ${JSON.stringify(work)} });
await py.loadPackage('micropip');
const result = await py.runPythonAsync(\`
import json, micropip
await micropip.install(${JSON.stringify(spec)})
json.dumps({
    "installed": [{"name": p.name, "version": p.version, "source": p.source}
                  for p in micropip.list().values()],
    "lock": json.loads(micropip.freeze()),
})
\`);
fs.writeFileSync(${JSON.stringify(listFile)}, result);
`
	);
	log(`resolving the wheel set for ${spec}`);
	execFileSync(process.execPath, [listScript], {
		cwd: work,
		stdio: ['ignore', 'ignore', 'inherit']
	});
	return JSON.parse(fs.readFileSync(listFile, 'utf8'));
}

const indexByName = (entries) =>
	new Map(Object.values(entries ?? {}).map((entry) => [canonical(entry.name), entry]));

try {
	const { installed: packages, lock } = resolve(EMULATOR_SPEC);
	const emulator = packages.find((entry) => entry.name === EMULATOR_NAME);
	if (!emulator) fail(`install did not include ${EMULATOR_NAME}`);
	const frozenEntries = indexByName(lock.packages);

	// Distribution packages report source 'pyodide'; their wheel names and checksums come
	// from the runtime's own lockfile, and the freeze run left the wheels cached
	const distributionLock = JSON.parse(
		fs.readFileSync(path.join(PYODIDE_DIRECTORY, 'pyodide-lock.json'), 'utf8')
	);
	const distEntries = indexByName(distributionLock.packages);

	// Where each of the Python runtime's wheels is served from: Pyodide's CDN for a
	// distribution package, PyPI for the rest, with the checksum a host verifies
	const { installed: runtimePackages, lock: runtimeLock } = resolve(PYTHON_RUNTIME_SPEC);
	const runtimeFrozen = indexByName(runtimeLock.packages);
	const pythonRuntime = runtimePackages
		.filter((entry) => canonical(entry.name) !== 'micropip')
		.map((entry) => {
			if (entry.source === 'pyodide') {
				const dist = distEntries.get(canonical(entry.name));
				if (!dist?.sha256) fail(`${entry.name} is not in the distribution lockfile with a checksum`);
				const file = path.basename(dist.file_name);
				return { file, url: PYODIDE_CDN + file, sha256: dist.sha256 };
			}
			const frozen = runtimeFrozen.get(canonical(entry.name));
			if (!frozen?.sha256 || !/^https?:/.test(frozen.file_name)) {
				fail(`no download URL with a checksum for ${entry.name} (source: ${entry.source})`);
			}
			return { file: decodeURIComponent(frozen.file_name.split('/').pop()), url: frozen.file_name, sha256: frozen.sha256 };
		})
		.sort((a, b) => a.file.localeCompare(b.file));

	fs.rmSync(OUTPUT_DIRECTORY, { recursive: true, force: true });
	fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });

	const wheels = [];
	const downloads = [];
	const writeWheel = (file, bytes) => fs.writeFileSync(path.join(OUTPUT_DIRECTORY, file), bytes);
	const excluded = new Set(EXCLUDED_PACKAGES.map(canonical));
	for (const entry of packages) {
		if (excluded.has(canonical(entry.name))) continue;
		if (entry.source === 'pyodide') {
			const dist = distEntries.get(canonical(entry.name));
			if (!dist) fail(`${entry.name} is not in the distribution lockfile`);
			const file = path.basename(dist.file_name);
			const cached = path.join(work, file);
			if (!fs.existsSync(cached)) fail(`cached wheel missing: ${file}`);
			const bytes = fs.readFileSync(cached);
			if (dist.sha256 && sha256(bytes) !== dist.sha256) fail(`checksum mismatch: ${file}`);
			wheels.push(file);
			writeWheel(file, bytes);
		} else {
			const frozen = frozenEntries.get(canonical(entry.name));
			if (!frozen || !/^https?:/.test(frozen.file_name)) {
				fail(`no download URL for ${entry.name} (source: ${entry.source})`);
			}
			const file = decodeURIComponent(frozen.file_name.split('/').pop());
			wheels.push(file);
			downloads.push(async () => {
				log(`downloading ${file}`);
				const response = await fetch(frozen.file_name);
				if (!response.ok) fail(`download failed (${response.status}): ${frozen.file_name}`);
				const bytes = Buffer.from(await response.arrayBuffer());
				if (frozen.sha256 && sha256(bytes) !== frozen.sha256) fail(`checksum mismatch: ${file}`);
				writeWheel(file, bytes);
			});
		}
	}
	await Promise.all(downloads.map((download) => download()));
	wheels.sort();

	log(`precompiling what the region imports`);
	const compiled = await precompile(wheels);

	const totalBytes = [...wheels, STDLIB_FILE]
		.map((file) => fs.statSync(path.join(OUTPUT_DIRECTORY, file)).size)
		.reduce((sum, size) => sum + size, 0);
	const megabytes = (totalBytes / 1e6).toFixed(1);
	fs.writeFileSync(
		METADATA_FILE,
		`${JSON.stringify(
			{
				pyodideVersion: PYODIDE_VERSION,
				emulatorSpec: EMULATOR_SPEC,
				wheels,
				stdlib: STDLIB_FILE,
				pythonRuntimeSpec: PYTHON_RUNTIME_SPEC,
				pythonRuntime
			},
			null,
			2
		)}\n`
	);
	log(
		`wrote ${wheels.length} wheels and the stdlib zip - ${megabytes} MB, ${EMULATOR_NAME} ${emulator.version}, ` +
			`${compiled} modules precompiled` +
			(wheels.length < packages.length ? ` (excluded ${EXCLUDED_PACKAGES.join(', ')})` : '') +
			`; named ${pythonRuntime.length} wheels for ${PYTHON_RUNTIME_SPEC}`
	);
} finally {
	fs.rmSync(work, { recursive: true, force: true });
}
