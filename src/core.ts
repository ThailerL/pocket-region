import type { loadPyodide, PyodideAPI } from 'pyodide';
import { PYTHON_SOURCES } from './python.generated.ts';

export type OutputStream = 'stdout' | 'stderr';
export type RegionOutput = { text: string; stream: OutputStream };

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

export type Dispatch = (request: RegionRequest) => Promise<RegionResponse>;

// What anything built over a region needs: a page's region fits, and so does a stub
export type Dispatcher = { dispatch: Dispatch };

export type Region = Dispatcher & {
  // The port its queue URLs name, which an HTTP server over it has to answer on
  port: number;
  // Back to empty in milliseconds; a region with a store keeps its saved state until the next save
  reset(): Promise<void>;
  save(): Promise<void>;
  stop(): Promise<void>;
};

// Where each asset is, already resolved: file paths from Node, URLs from a page. Pyodide
// takes either, so nothing below knows which host it is running on
export type RegionAssets = {
  // The runtime itself: Node's dependency, or a page's fetch from indexURL, so no bare import here
  loadPyodide: typeof loadPyodide;
  indexURL?: string;
  packageCacheDir?: string;
  stdLib: string;
  wheels: string[];
};

// Every saved file, keyed by its path under the state root, such as state/sqs.json
export type StateFiles = Map<string, Uint8Array>;

export type StateStore = {
  // Rejects while another region holds the store
  load(): Promise<StateFiles>;
  // Everything absent from files was deleted since the last save
  replace(files: StateFiles): Promise<void>;
  close?(): Promise<void>;
};

// load and close around a lock; a refused acquire leaves the holder's release in place
export function lockedLoad(acquire: () => Promise<() => void | Promise<void>>, read: () => Promise<StateFiles>) {
  let release: (() => void | Promise<void>) | undefined;
  return {
    async load() {
      release = await acquire();
      try {
        return await read();
      } catch (error) {
        await release();
        release = undefined;
        throw error;
      }
    },
    async close() {
      await release?.();
      release = undefined;
    },
  };
}

// Python file IO stays in MEMFS: under Vivari, writes through a node mount are corrupt
function writeStateFiles(py: PyodideAPI, files: StateFiles) {
  for (const [key, contents] of files) {
    const mem = `${STATE_ROOT}/${key}`;
    py.FS.mkdirTree(mem.slice(0, mem.lastIndexOf('/')));
    py.FS.writeFile(mem, contents);
  }
}

// Synchronous, so no request lands between the emulator writing its state and this snapshot
function readStateFiles(py: PyodideAPI, prefix = '', files: StateFiles = new Map()): StateFiles {
  for (const name of py.FS.readdir(`${STATE_ROOT}/${prefix}`)) {
    if (name === '.' || name === '..') continue;
    const key = `${prefix}${name}`;
    const mem = `${STATE_ROOT}/${key}`;
    if (py.FS.isDir(py.FS.stat(mem).mode)) readStateFiles(py, `${key}/`, files);
    else files.set(key, py.FS.readFile(mem));
  }
  return files;
}

// One file of a function's deployment package, as the emulator read it out of the zip
export type CodeEntry = [path: string, contents: Uint8Array, mode: number];

// The function's configuration as the emulator holds it: the API's own names, with its
// defaults already applied
export type FunctionConfig = {
  FunctionName: string;
  FunctionArn: string;
  Version: string;
  Runtime: string;
  Handler: string;
  Timeout: number;
  MemorySize: number;
  CodeSha256: string;
  // A new one on every code and configuration change
  RevisionId: string;
  Environment?: { Variables?: Record<string, string> };
};

// What the emulator hands the host for one run of a function's code
export type Invocation = {
  requestId: string;
  config: FunctionConfig;
  // The event as JSON text, handed to the runtime verbatim
  event: string;
  // Present only when the host answered needsCode(CodeSha256) with true
  code?: CodeEntry[];
};

// A function error as Lambda's Invoke answers it
export type LambdaError = { errorType: string; errorMessage: string; stackTrace?: string[] };

// payload is the handler's result as JSON text
export type InvocationOutcome = (
  | { status: 'ok'; payload: string | null }
  | { status: 'error'; error: LambdaError }
) & {
  // What the function wrote, which the emulator frames for CloudWatch Logs
  log: string;
};

// Supplied by the entry point: child processes in Node, workers in a page
export type LambdaExecutor = {
  needsCode(codeSha256: string): boolean;
  execute(invocation: Invocation): Promise<InvocationOutcome>;
  // Stops every environment and fails what they were running, and keeps the host usable
  reset(): Promise<void>;
  stop(): Promise<void>;
};

// An environment is named by its log stream
export type LambdaEnvironment = { functionName: string; environment: string };
export type LambdaOutput = LambdaEnvironment & { text: string };

export type LambdaEvent = LambdaEnvironment &
  (
    | { kind: 'environment'; phase: 'started' | 'stopped'; reason?: string }
    | { kind: 'invocation'; requestId: string; phase: 'started'; event: string; coldStart: boolean }
    | { kind: 'invocation'; requestId: string; phase: 'completed'; durationMs: number; initMs?: number; failed: boolean }
  );

export type LambdaObserver = {
  onOutput?(output: LambdaOutput): void;
  onEvent?(event: LambdaEvent): void;
};

// Built during boot, around the dispatch a handler's own calls come back through
export type LambdaHostFactory = (region: Dispatcher & { port: number }) => LambdaExecutor;

// A wheel a Python function's environment preinstalls, as Lambda's runtime preinstalls boto3
export type PythonWheel = { file: string; url: string; sha256: string };

// What scripts/vendor.mjs writes beside the wheels
export type VendorManifest = { wheels: string[]; stdlib: string; pyodideVersion: string; pythonRuntime: PythonWheel[] };

export type RegionSettings = {
  // The port minted queue URLs name, since the AWS SDK dials the URL it is given
  port?: number;
  onOutput?: (output: RegionOutput) => void;
  lambda?: LambdaObserver;
  // In memory only when absent
  store?: StateStore;
};

type PythonDispatch = (
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Uint8Array,
) => Promise<RegionResponse>;

const STATE_ROOT = '/state';
export const DEFAULT_PORT = 4566;

// Internal, for the garbage test: every region bootRegion returns has one
const garbageCollectors = new WeakMap<Region, () => number>();
export const collectGarbage = (region: Region) => garbageCollectors.get(region)!();

// A host reports to the observer alone; the region's untagged onOutput hears each line too
export const hostObserver = ({ onOutput, lambda }: RegionSettings): LambdaObserver => ({
  onEvent: (event) => lambda?.onEvent?.(event),
  onOutput: (output) => {
    lambda?.onOutput?.(output);
    onOutput?.({ text: output.text, stream: 'stdout' });
  },
});

// Timers must not hold Node open; a page has no such thing
export const unref = (timer: ReturnType<typeof setTimeout>) => {
  (timer as { unref?: () => void }).unref?.();
  return timer;
};

export const jspiSupported = () => 'Suspending' in WebAssembly;

export function requireJspi() {
  if (!jspiSupported()) {
    throw new Error(
      'Pocket Region needs WebAssembly JSPI (WebAssembly.Suspending), which Node has from 24.20 and some browsers lack',
    );
  }
}

export async function bootRegion(
  assets: RegionAssets,
  settings: RegionSettings,
  lambda?: LambdaHostFactory,
): Promise<Region> {
  requireJspi();
  const { store } = settings;
  // Before Pyodide loads, so a store in use fails fast
  const files = await store?.load();
  let region: Region;
  try {
    region = await startRegion(assets, settings, files, lambda);
  } catch (error) {
    await store?.close?.();
    throw error;
  }
  const stored: Region = {
    ...region,
    async stop() {
      try {
        await region.stop();
      } finally {
        await store?.close?.();
      }
    },
  };
  garbageCollectors.set(stored, garbageCollectors.get(region)!);
  return stored;
}

async function startRegion(
  assets: RegionAssets,
  settings: RegionSettings,
  files: StateFiles | undefined,
  lambda?: LambdaHostFactory,
): Promise<Region> {
  const { store } = settings;
  const onOutput = settings.onOutput ?? (() => {});

  const py = await assets.loadPyodide({
    packageCacheDir: assets.packageCacheDir,
    indexURL: assets.indexURL,
    // The vendored copy carries bytecode; the runtime's own would compile on every boot
    stdLibURL: assets.stdLib,
  });
  // Before any Python runs: print throws EBADF without these
  const stdout = (text: string) => onOutput({ text, stream: 'stdout' });
  const stderr = (text: string) => onOutput({ text, stream: 'stderr' });
  py.setStdout({ batched: stdout });
  py.setStderr({ batched: stderr });
  await py.loadPackage(assets.wheels, { messageCallback: stdout, errorCallback: stderr });

  const port = settings.port ?? DEFAULT_PORT;
  // Bound once the sources have run; nothing dispatches before boot resolves
  let dispatchPython: PythonDispatch;
  const dispatch: Dispatch = ({ method, path, headers, body = new Uint8Array() }) =>
    dispatchPython(
      method,
      path,
      headers,
      // A plain view: Pyodide's to_bytes rejects Buffer and other subclasses
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    );
  const executor = lambda?.({ port, dispatch });

  py.globals.set('STATE_ROOT', STATE_ROOT);
  py.globals.set('REGION_PORT', port);
  py.globals.set('LAMBDA_EXECUTOR', executor ?? null);
  // A worker's sleeps, owned here: a cancelled Pyodide timer would hold Node for its full delay
  const wakes = new Set<() => void>();
  let stopped = false;
  py.globals.set('REGION_SLEEP', (seconds: number) =>
    new Promise<void>((resolve) => {
      if (stopped) return resolve();
      const wake = () => {
        clearTimeout(timer);
        wakes.delete(wake);
        resolve();
      };
      const timer = unref(setTimeout(wake, seconds * 1000));
      wakes.add(wake);
    }),
  );
  // Before the emulator imports, since each service reads its own state file then
  if (files !== undefined) writeStateFiles(py, files);
  // One shared namespace, in the generated order
  for (const source of PYTHON_SOURCES) {
    await py.runPythonAsync(source);
  }
  const lifespan: (phase: 'startup' | 'shutdown') => Promise<void> = py.globals.get('lifespan');
  await lifespan('startup');
  dispatchPython = py.globals.get('region_dispatch');
  const savePython: () => void = py.globals.get('region_save');
  const endWorkers: () => void = py.globals.get('end_workers');

  const region: Region = {
    port,
    dispatch,
    async reset() {
      // Awaited so no killed handler writes after this resolves; a reset over HTTP can't wait
      await executor?.reset();
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
      if (store === undefined) return;
      savePython();
      await store.replace(readStateFiles(py));
    },
    async stop() {
      endWorkers();
      stopped = true;
      for (const wake of [...wakes]) wake();
      // Lifespan shutdown writes the state files; the store gets them after
      await lifespan('shutdown');
      await store?.replace(readStateFiles(py));
      await executor?.stop();
    },
  };
  garbageCollectors.set(region, py.globals.get('collect_garbage'));
  return region;
}
