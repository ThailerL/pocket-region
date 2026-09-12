import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPyodide, type PyodideAPI } from 'pyodide';

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

type VendorManifest = { wheels: string[] };

type PythonDispatch = (
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Uint8Array,
) => Promise<RegionResponse>;

const PYTHON_DIRECTORY = new URL('../python/', import.meta.url);
// One shared namespace, in this order: threads.py must land before helpers.py imports the emulator
const PYTHON_FILES = ['threads.py', 'helpers.py', 'api.py'];
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

function listDiskFiles(diskDir: string, found: string[] = []) {
  for (const entry of fs.readdirSync(diskDir, { withFileTypes: true })) {
    const disk = path.join(diskDir, entry.name);
    if (entry.isDirectory()) listDiskFiles(disk, found);
    else found.push(disk);
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
  for (const disk of listDiskFiles(stateDir)) {
    if (!written.has(disk)) fs.rmSync(disk);
  }
}

export async function createRegion(options: RegionOptions = {}): Promise<Region> {
  const packageCacheDir =
    options.packageCacheDir ?? fileURLToPath(new URL('../vendor', import.meta.url));
  const manifest: VendorManifest = JSON.parse(
    fs.readFileSync(path.join(packageCacheDir, 'meta.json'), 'utf8'),
  );
  const onOutput = options.onOutput ?? (() => {});

  const py = await loadPyodide({ packageCacheDir, indexURL: options.indexURL });
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
  for (const file of PYTHON_FILES) {
    await py.runPythonAsync(fs.readFileSync(new URL(file, PYTHON_DIRECTORY), 'utf8'));
  }
  await py.runPythonAsync('await region_start()');
  const dispatchPython: PythonDispatch = py.globals.get('region_dispatch');
  const savePython: () => void = py.globals.get('region_save');
  const stopPython: () => Promise<void> = py.globals.get('region_stop');

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
      // Without a state directory the emulator's files would only reach MEMFS, where
      // nothing can read them
      if (stateDir === undefined) return;
      savePython();
      mirrorToDisk(py, stateDir);
    },
    async stop() {
      // Lifespan shutdown writes the state files; the mirror follows
      await stopPython();
      if (stateDir !== undefined) mirrorToDisk(py, stateDir);
    },
  };
}
