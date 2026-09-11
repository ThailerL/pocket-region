import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPyodide } from 'pyodide';

export type OutputStream = 'stdout' | 'stderr';

export type RegionOptions = {
  // Only for hosts where Pyodide cannot locate itself from import.meta.url
  indexURL?: string;
  packageCacheDir?: string;
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
  for (const file of PYTHON_FILES) {
    await py.runPythonAsync(fs.readFileSync(new URL(file, PYTHON_DIRECTORY), 'utf8'));
  }
  await py.runPythonAsync('await region_start()');
  const dispatchPython: PythonDispatch = py.globals.get('region_dispatch');
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
    async stop() {
      await stopPython();
    },
  };
}
