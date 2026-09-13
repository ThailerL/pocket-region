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
  // Reserved through PutFunctionConcurrency, or the emulator's default
  concurrency: number;
  // The event as JSON text, handed to the runtime verbatim
  event: string;
  // Present only when the host answered needsCode(CodeSha256) with true
  code?: CodeEntry[];
};

// payload is JSON text: the handler's result, or Lambda's { errorType, errorMessage } shape
export type InvocationOutcome = {
  status: 'ok' | 'error' | 'throttled';
  payload: string | null;
  // Framed with Lambda's START, END, and REPORT lines; output is what the function wrote
  log: string;
  output: string;
};

// Supplied by the entry point: child processes in Node, workers in a page
export type LambdaExecutor = {
  needsCode(codeSha256: string): boolean;
  execute(invocation: Invocation): Promise<InvocationOutcome>;
  stop(): Promise<void>;
};

// What the host saw of a function's environments, named by the environment's log stream
export type LambdaEvent =
  | { kind: 'environment'; functionName: string; environment: string; phase: 'started' | 'stopped'; reason?: string }
  | {
      kind: 'invocation';
      functionName: string;
      environment: string;
      requestId: string;
      phase: 'started';
      event: string;
      coldStart: boolean;
    }
  | {
      kind: 'invocation';
      functionName: string;
      environment: string;
      requestId: string;
      phase: 'completed';
      durationMs: number;
      initMs?: number;
      failed: boolean;
    }
  | { kind: 'throttled'; functionName: string };

export type LambdaObserver = {
  onOutput?(line: string, source: { functionName: string; environment: string }): void;
  onEvent?(event: LambdaEvent): void;
};

// Built during boot, around the dispatch a handler's own calls come back through
export type LambdaHostFactory = (region: Pick<Region, 'port' | 'dispatch'>) => LambdaExecutor;

// What scripts/vendor.mjs writes beside the wheels
export type VendorManifest = { wheels: string[]; stdlib: string; pyodideVersion: string };

export type RegionSettings = {
  // The port minted queue URLs name, since the AWS SDK dials the URL it is given
  port?: number;
  onOutput?: (line: string, stream: OutputStream) => void;
  lambda?: LambdaObserver;
};

type PythonDispatch = (
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Uint8Array,
) => Promise<RegionResponse>;

const STATE_ROOT = '/state';
export const DEFAULT_PORT = 4566;
// A pass measured 0.03 ms empty and 57 ms over 100,000 TTL items, 2026-09-12
const TICK_INTERVAL_MS = 1000;

// A host reports to the observer alone; the region's untagged onOutput hears each line too
export const hostObserver = ({ onOutput, lambda }: RegionSettings): LambdaObserver => ({
  onEvent: (event) => lambda?.onEvent?.(event),
  onOutput: (line, source) => {
    lambda?.onOutput?.(line, source);
    onOutput?.(line, 'stdout');
  },
});

// Timers must not hold Node open; a page has no such thing
export const unref = (timer: ReturnType<typeof setTimeout>) => {
  (timer as { unref?: () => void }).unref?.();
  return timer;
};

export async function bootRegion(
  assets: RegionAssets,
  settings: RegionSettings,
  persistence?: RegionPersistence,
  lambda?: LambdaHostFactory,
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
  // Bound once the sources have run; nothing dispatches before boot resolves
  let dispatchPython: PythonDispatch;
  const dispatch: Region['dispatch'] = ({ method, path, headers, body = new Uint8Array() }) =>
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
  await persistence?.restore(py, STATE_ROOT);
  // One shared namespace, in the generated order
  for (const source of PYTHON_SOURCES) {
    await py.runPythonAsync(source);
  }
  const lifespan: (phase: 'startup' | 'shutdown') => Promise<void> = py.globals.get('lifespan');
  await lifespan('startup');
  dispatchPython = py.globals.get('region_dispatch');
  const savePython: () => void = py.globals.get('region_save');
  const tickPython: () => Promise<void> = py.globals.get('region_tick');
  // A pass can wait on a Lambda handler, so a slow one must not overlap the next
  let ticking: Promise<void> | undefined;
  const ticker = unref(
    setInterval(() => {
      ticking ??= tickPython().finally(() => (ticking = undefined));
    }, TICK_INTERVAL_MS),
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
      clearInterval(ticker);
      await ticking;
      // Lifespan shutdown writes the state files; the mirror follows
      await lifespan('shutdown');
      await persistence?.mirror(py, STATE_ROOT);
      await executor?.stop();
    },
  };
}
