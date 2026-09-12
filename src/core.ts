import { loadPyodide, type PyodideAPI } from 'pyodide';
import { PYTHON_SOURCES } from './python.generated.ts';

export type OutputStream = 'stdout' | 'stderr';

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
  // The port its queue URLs name, which an HTTP server over it has to answer on
  port: number;
  dispatch(request: RegionRequest): Promise<RegionResponse>;
  // Back to empty in milliseconds; a region with a stateDir keeps its disk until the next save
  reset(): Promise<void>;
  save(): Promise<void>;
  stop(): Promise<void>;
};

// What anything built over a region needs: a page's region fits, and so does a stub
export type Dispatcher = Pick<Region, 'dispatch'>;

// Where each asset is, already resolved: file paths from Node, URLs from a page. Pyodide
// takes either, so nothing below knows which host it is running on
export type RegionAssets = {
  indexURL?: string;
  packageCacheDir?: string;
  stdLib: string;
  wheels: string[];
};

// Supplied only by a host that can persist. restore runs before the emulator imports, since
// each service reads its own state file then; mirror runs after a save or shutdown wrote them.
// Both may be async: a page's IndexedDB is, where Node's fs is not
export type RegionPersistence = {
  restore(py: PyodideAPI, stateRoot: string): Promise<void> | void;
  mirror(py: PyodideAPI, stateRoot: string): Promise<void> | void;
};

// What scripts/vendor.mjs writes beside the wheels
export type VendorManifest = { wheels: string[]; stdlib: string; pyodideVersion: string };

export type RegionSettings = {
  // The port minted queue URLs name, since the AWS SDK dials the URL it is given
  port?: number;
  onOutput?: (line: string, stream: OutputStream) => void;
};

type PythonDispatch = (
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Uint8Array,
) => Promise<RegionResponse>;

const STATE_ROOT = '/state';
const DEFAULT_PORT = 4566;

export async function bootRegion(
  assets: RegionAssets,
  settings: RegionSettings,
  persistence?: RegionPersistence,
): Promise<Region> {
  const onOutput = settings.onOutput ?? (() => {});

  const py = await loadPyodide({
    packageCacheDir: assets.packageCacheDir,
    indexURL: assets.indexURL,
    // The vendored copy carries bytecode; the runtime's own would compile on every boot
    stdLibURL: assets.stdLib,
  });
  // Before any Python runs: print throws EBADF without these
  py.setStdout({ batched: (line) => onOutput(line, 'stdout') });
  py.setStderr({ batched: (line) => onOutput(line, 'stderr') });
  await py.loadPackage(assets.wheels, {
    messageCallback: (line) => onOutput(line, 'stdout'),
    errorCallback: (line) => onOutput(line, 'stderr'),
  });

  const port = settings.port ?? DEFAULT_PORT;
  py.globals.set('STATE_ROOT', STATE_ROOT);
  py.globals.set('REGION_PORT', port);
  await persistence?.restore(py, STATE_ROOT);
  // One shared namespace, in the generated order
  for (const source of PYTHON_SOURCES) {
    await py.runPythonAsync(source);
  }
  const lifespan: (phase: 'startup' | 'shutdown') => Promise<void> = py.globals.get('lifespan');
  await lifespan('startup');
  const dispatchPython: PythonDispatch = py.globals.get('region_dispatch');
  const savePython: () => void = py.globals.get('region_save');

  const dispatch: Region['dispatch'] = ({ method, path, headers, body = new Uint8Array() }) =>
    dispatchPython(
      method,
      path,
      headers,
      // A plain view: Pyodide's to_bytes rejects Buffer and other subclasses
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    );

  return {
    port,
    dispatch,
    async reset() {
      const response = await dispatch({
        method: 'POST',
        path: '/_ministack/reset',
        headers: { host: `localhost:${port}` },
      });
      if (response.status !== 200) {
        throw new Error(`reset answered ${response.status}: ${new TextDecoder().decode(response.body)}`);
      }
    },
    async save() {
      if (persistence === undefined) return;
      savePython();
      await persistence.mirror(py, STATE_ROOT);
    },
    async stop() {
      // Lifespan shutdown writes the state files; the mirror follows
      await lifespan('shutdown');
      await persistence?.mirror(py, STATE_ROOT);
    },
  };
}
