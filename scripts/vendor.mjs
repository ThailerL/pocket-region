// Generates vendor/: every wheel the emulator needs, beside meta.json. The runtime itself is
// the pyodide dependency. The set is resolved by really installing it under the pinned
// Pyodide and freezing the environment.
//
// Bumping the pyodide dependency or EMULATOR_SPEC is a deliberate release act: ministack
// stamps a format version on each service's state file and starts that service empty when
// the stamps disagree, so a bump can cost user data. Never let these pins drift.
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

const require = createRequire(import.meta.url);
const PYODIDE_VERSION = require('../package.json').dependencies.pyodide;
const PYODIDE_DIRECTORY = path.dirname(require.resolve('pyodide/package.json'));
const EMULATOR_SPEC = 'ministack==1.5.5';
const EMULATOR_NAME = EMULATOR_SPEC.split('==')[0];

// Resolved as the emulator's dependency but left out of the tree. botocore is half the
// payload and the slowest wheel to install, and nothing we serve imports it: it is lazy,
// reached only from the glue, lambda-runtime and IAM paths. Verified by booting the region
// and exercising S3, SQS and DynamoDB without it
// micropip only resolves the set here; the region loads the wheels without it
const EXCLUDED_PACKAGES = ['botocore', 'micropip'];

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const OUTPUT_DIRECTORY = path.join(ROOT, 'vendor');
const METADATA_FILE = path.join(OUTPUT_DIRECTORY, 'meta.json');

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
	if (metadata.pyodideVersion === PYODIDE_VERSION && metadata.emulatorSpec === EMULATOR_SPEC) {
		log(`up to date - pyodide ${PYODIDE_VERSION}, ${EMULATOR_SPEC} (--force to rebuild)`);
		process.exit(0);
	}
	log(`pins changed: regenerating`);
}

const installedVersion = require('pyodide/package.json').version;
if (installedVersion !== PYODIDE_VERSION) {
	fail(`pyodide ${installedVersion} is installed but ${PYODIDE_VERSION} is pinned: run npm install`);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-region-vendor-'));
try {

	// Wheel-loading noise goes to stdout, so the child writes its result to a file instead
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
await micropip.install(${JSON.stringify(EMULATOR_SPEC)})
json.dumps({
    "installed": [{"name": p.name, "version": p.version, "source": p.source}
                  for p in micropip.list().values()],
    "lock": json.loads(micropip.freeze()),
})
\`);
fs.writeFileSync(${JSON.stringify(listFile)}, result);
`
	);
	log(`resolving the wheel set for ${EMULATOR_SPEC}`);
	execFileSync(process.execPath, [listScript], {
		cwd: work,
		stdio: ['ignore', 'ignore', 'inherit']
	});
	// list() names what is actually installed; freeze() knows each PyPI wheel's URL
	const { installed: packages, lock } = JSON.parse(fs.readFileSync(listFile, 'utf8'));
	const emulator = packages.find((entry) => entry.name === EMULATOR_NAME);
	if (!emulator) fail(`install did not include ${EMULATOR_NAME}`);
	const indexByName = (entries) =>
		new Map(Object.values(entries ?? {}).map((entry) => [canonical(entry.name), entry]));
	const frozenEntries = indexByName(lock.packages);

	// Distribution packages report source 'pyodide'; their wheel names and checksums come
	// from the runtime's own lockfile, and the freeze run left the wheels cached
	const distributionLock = JSON.parse(
		fs.readFileSync(path.join(PYODIDE_DIRECTORY, 'pyodide-lock.json'), 'utf8')
	);
	const distEntries = indexByName(distributionLock.packages);

	fs.rmSync(OUTPUT_DIRECTORY, { recursive: true, force: true });
	fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });

	const wheels = [];
	const downloads = [];
	let totalBytes = 0;
	const writeWheel = (file, bytes) => {
		fs.writeFileSync(path.join(OUTPUT_DIRECTORY, file), bytes);
		totalBytes += bytes.length;
	};
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

	const megabytes = (totalBytes / 1e6).toFixed(1);
	fs.writeFileSync(
		METADATA_FILE,
		`${JSON.stringify(
			{
				pyodideVersion: PYODIDE_VERSION,
				emulatorSpec: EMULATOR_SPEC,
				wheels: wheels.sort()
			},
			null,
			2
		)}\n`
	);
	log(
		`wrote ${wheels.length} wheels - ${megabytes} MB, ${EMULATOR_NAME} ${emulator.version}` +
			(wheels.length < packages.length ? ` (excluded ${EXCLUDED_PACKAGES.join(', ')})` : '')
	);
} finally {
	fs.rmSync(work, { recursive: true, force: true });
}
