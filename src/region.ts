import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPyodide, type PyodideAPI } from 'pyodide';
import { PYTHON_SOURCES } from './python.generated.ts';

export type OutputStream = 'stdout' | 'stderr';

export type RegionOptions = {
  // Only for hosts where Pyodide cannot locate itself from import.meta.url
  indexURL?: string;
  packageCacheDir?: string;
  // Where save() writes and a new region restores from; in memory only when absent
  stateDir?: string;
  // The port minted queue URLs name, since the AWS SDK dials the URL it is given
  port?: number;
  onOutput?: (line: string, stream: OutputStream) => void;
};

export type RegionRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Uint8Array;
};

export type RegionResponse = {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
};

export type Region = {
  dispatch(request: RegionRequest): Promise<RegionResponse>;
  save(): Promise<void>;
  stop(): Promise<void>;
};

type VendorManifest = { wheels: string[]; stdlib: string };

type PythonDispatch = (
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Uint8Array,
) => Promise<RegionResponse>;

const STATE_ROOT = '/state';
const DEFAULT_PORT = 4566;

// Python file IO stays in MEMFS: under Vivari, writes through a node mount are corrupt
function copyDiskToMemfs(py: PyodideAPI, diskDir: string, memDir: string) {
  py.FS.mkdirTree(memDir);
  for (const entry of fs.readdirSync(diskDir, { withFileTypes: true })) {
    const disk = path.join(diskDir, entry.name);
    const mem = `${memDir}/${entry.name}`;
    if (entry.isDirectory()) copyDiskToMemfs(py, disk, mem);
    else py.FS.writeFile(mem, fs.readFileSync(disk));
  }
}

function listMemfsFiles(py: PyodideAPI, memDir: string, found: string[] = []) {
  for (const name of py.FS.readdir(memDir)) {
    if (name === '.' || name === '..') continue;
    const mem = `${memDir}/${name}`;
    if (py.FS.isDir(py.FS.stat(mem).mode)) listMemfsFiles(py, mem, found);
    else found.push(mem);
  }
  return found;
}

// Deletions count as much as writes: a deleted object whose file survived on disk would
// come back at the next boot
function mirrorToDisk(py: PyodideAPI, stateDir: string) {
  const written = new Set<string>();
  for (const mem of listMemfsFiles(py, STATE_ROOT)) {
    const disk = path.join(stateDir, mem.slice(STATE_ROOT.length + 1));
    written.add(disk);
    fs.mkdirSync(path.dirname(disk), { recursive: true });
    fs.writeFileSync(disk, py.FS.readFile(mem));
  }
  for (const entry of fs.readdirSync(stateDir, { recursive: true, withFileTypes: true })) {
    const disk = path.join(entry.parentPath, entry.name);
    if (entry.isFile() && !written.has(disk)) fs.rmSync(disk);
  }
}

export async function createRegion(options: RegionOptions = {}): Promise<Region> {
  const packageCacheDir =
    options.packageCacheDir ?? fileURLToPath(new URL('../vendor', import.meta.url));
  const manifest: VendorManifest = JSON.parse(
    fs.readFileSync(path.join(packageCacheDir, 'meta.json'), 'utf8'),
  );
  const onOutput = options.onOutput ?? (() => {});

  const py = await loadPyodide({
    packageCacheDir,
    indexURL: options.indexURL,
    // The vendored copy carries bytecode; the runtime's own would compile on every boot
    stdLibURL: path.join(packageCacheDir, manifest.stdlib),
  });
  // Before any Python runs: print throws EBADF without these
  py.setStdout({ batched: (line) => onOutput(line, 'stdout') });
  py.setStderr({ batched: (line) => onOutput(line, 'stderr') });
  await py.loadPackage(
    manifest.wheels.map((file) => path.join(packageCacheDir, file)),
    {
      messageCallback: (line) => onOutput(line, 'stdout'),
      errorCallback: (line) => onOutput(line, 'stderr'),
    },
  );

  py.globals.set('STATE_ROOT', STATE_ROOT);
  py.globals.set('REGION_PORT', options.port ?? DEFAULT_PORT);
  const { stateDir } = options;
  if (stateDir !== undefined) {
    // Before helpers.py, where each service restores its own state file as it imports
    fs.mkdirSync(stateDir, { recursive: true });
    copyDiskToMemfs(py, stateDir, STATE_ROOT);
  }
  // One shared namespace, in the generated order
  for (const source of PYTHON_SOURCES) {
    await py.runPythonAsync(source);
  }
  const lifespan: (phase: 'startup' | 'shutdown') => Promise<void> = py.globals.get('lifespan');
  await lifespan('startup');
  const dispatchPython: PythonDispatch = py.globals.get('region_dispatch');
  const savePython: () => void = py.globals.get('region_save');

  return {
    dispatch({ method, path, headers, body = new Uint8Array() }) {
      return dispatchPython(
        method,
        path,
        headers,
        // A plain view: Pyodide's to_bytes rejects Buffer and other subclasses
        new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      );
    },
    async save() {
      if (stateDir === undefined) return;
      savePython();
      mirrorToDisk(py, stateDir);
    },
    async stop() {
      // Lifespan shutdown writes the state files; the mirror follows
      await lifespan('shutdown');
      if (stateDir !== undefined) mirrorToDisk(py, stateDir);
    },
  };
}
