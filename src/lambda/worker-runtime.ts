// Shipped as a string (scripts/embed-runtime.mjs) and run as a module worker from a Blob URL,
// so it may import nothing but types: web globals only
import type { PyodideInterface } from 'pyodide';
import type { LambdaError } from '../core.ts';
import type { Invoker } from './pool.ts';
import type { FetchReply, FromWorker, NodeInit, PythonInit, ToWorker } from './worker-protocol.ts';

// DedicatedWorkerGlobalScope, without the lib that names it
const port = self as unknown as {
  postMessage(message: FromWorker): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  close(): void;
};

// Region replies are keyed; the rest arrive one at a time, each awaited before it is sent
const fetches = new Map<number, (reply: FetchReply) => void>();
let deliver: ((message: ToWorker) => void) | undefined;
port.onmessage = ({ data }) => {
  if (data.type === 'fetched') fetches.get(data.id)?.(data);
  else deliver?.(data);
};
const receive = <T extends ToWorker['type']>(type: T) =>
  new Promise<Extract<ToWorker, { type: T }>>((resolve, reject) => {
    deliver = (message) => {
      if (message.type === type) resolve(message as Extract<ToWorker, { type: T }>);
      else reject(new Error(`Expected ${type}, got ${message.type}`));
    };
  });

const format = (value: unknown) => {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? String(value);
  return JSON.stringify(value) ?? String(value);
};
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    port.postMessage({ type: 'output', line: args.map(format).join(' ') });
  };
}

const errorPayload = (error: unknown): LambdaError => {
  const { name, message, stack } = (error ?? {}) as Partial<Error>;
  return {
    errorType: name ?? 'Error',
    errorMessage: message ?? String(error),
    stackTrace: typeof stack === 'string' ? stack.split('\n') : [],
  };
};

// A handler ready to invoke, or the init error its runtime already logged
type Loaded = Invoker | { error: LambdaError };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// Requests to the region cross to the host, which dispatches them; the rest go out
function interceptFetch(endpoint: string) {
  const regionPort = new URL(endpoint).port;
  const realFetch = globalThis.fetch;
  let nextId = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.port !== regionPort || !LOOPBACK.has(url.hostname)) return realFetch(input, init);
    const request = new Request(input, init);
    const id = nextId++;
    const headers = Object.fromEntries(request.headers);
    // A forbidden header, which Request drops, and what the emulator routes on
    headers.host = url.host;
    const body = new Uint8Array(await request.arrayBuffer());
    const reply = await new Promise<FetchReply>((resolve) => {
      fetches.set(id, resolve);
      port.postMessage({ type: 'fetch', id, method: request.method, path: url.pathname + url.search, headers, body });
    });
    fetches.delete(id);
    const bodiless = [204, 205, 304].includes(reply.status);
    // A Uint8Array over a SharedArrayBuffer is not a BodyInit; a copy over a plain one is
    return new Response(bodiless ? null : new Uint8Array(reply.body) as Uint8Array<ArrayBuffer>, {
      status: reply.status,
      headers: reply.headers,
    });
  };
}

type Module = Record<string, unknown>;

// A Blob URL keeps stack traces short; a host that cannot import one gets the source inline
async function importModule(source: Uint8Array): Promise<Module> {
  const blob = new Blob([source as Uint8Array<ArrayBuffer>], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    return await import(url);
  } catch {
    return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(await blob.text())}`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

type ClientClass = new (config?: object) => object;

// with-region.ts's loop, for a client package whose browser build reads no environment
function defaulted(module: Module, Base: ClientClass, defaults: object): Module {
  const entries = Object.entries(module).map(([name, value]) => {
    if (typeof value !== 'function' || !(value.prototype instanceof Base)) return [name, value];
    const Client = value as ClientClass;
    const Defaulted = class extends Client {
      constructor(config: object = {}) {
        super({ ...defaults, ...config });
      }
    };
    Object.defineProperty(Defaulted, 'name', { value: name });
    return [name, Defaulted];
  });
  return Object.fromEntries(entries);
}

type Handler = (event: unknown, context: object) => unknown;

const { env, runtime } = await receive('init');
// What a handler reads its configuration from, as it does on Lambda
(globalThis as { process?: unknown }).process = { env };
interceptFetch(env.AWS_ENDPOINT_URL!);

async function loadNodeHandler({ files, importer, handler: handlerPath, exportName, preload, defaults, xmldom }: NodeInit): Promise<Invoker> {
  const modules = new Map<string, Promise<Module>>();

  async function polyfillDom() {
    if ('DOMParser' in globalThis) return;
    const { DOMParser, Node } = await import(xmldom);
    Object.assign(globalThis, { DOMParser, Node });
  }

  // An SDK client package comes with what its browser build expects of a page
  async function fromUrl(url: string) {
    const module: Module = await import(url);
    if (typeof module.__Client !== 'function') return module;
    await polyfillDom();
    return defaulted(module, module.__Client as ClientClass, defaults);
  }

  // Answers the calls the host rewrote imports into: a path in the package, or a URL
  function loadModule(specifier: string): Promise<Module> {
    let loading = modules.get(specifier);
    if (!loading) {
      const source = files.get(specifier);
      if (source) loading = importModule(source);
      else if (URL.canParse(specifier)) loading = fromUrl(specifier);
      else loading = Promise.reject(new Error(`The package has no ${specifier}`));
      modules.set(specifier, loading);
      // A failure is not the answer for the rest of the environment
      loading.catch(() => modules.delete(specifier));
    }
    return loading;
  }
  (globalThis as Record<string, unknown>)[importer] = loadModule;

  // Rejections are seen where the handler imports them
  for (const url of preload) loadModule(url).catch(() => {});

  const handler = (await loadModule(handlerPath))[exportName] as Handler;
  if (typeof handler !== 'function') {
    throw new Error(`The handler module does not export a function named "${exportName}"`);
  }
  return async (event, requestId, deadline, arn) => {
    const context = {
      awsRequestId: requestId,
      functionName: env.AWS_LAMBDA_FUNCTION_NAME,
      functionVersion: env.AWS_LAMBDA_FUNCTION_VERSION,
      memoryLimitInMB: env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE,
      invokedFunctionArn: arn,
      logStreamName: env.AWS_LAMBDA_LOG_STREAM_NAME,
      getRemainingTimeInMillis: () => Math.max(0, deadline - Date.now()),
    };
    try {
      return { result: JSON.stringify((await handler(JSON.parse(event), context)) ?? null) };
    } catch (error) {
      console.error(`${requestId}\tERROR\tInvoke Error\t${(error as Error)?.stack ?? error}`);
      return { error: errorPayload(error) };
    }
  };
}

// Where Lambda keeps the package, so a handler's paths hold
const TASK_ROOT = '/var/task';

// A Python handler runs under an interpreter of its own, its errors reported by the runtime's Python
async function loadPythonHandler({ files, indexURL, wheels, source }: PythonInit): Promise<Loaded> {
  const { loadPyodide }: typeof import('pyodide') = await import(`${indexURL}pyodide.mjs`);
  const py: PyodideInterface = await loadPyodide({
    indexURL,
    env: { ...env, LAMBDA_TASK_ROOT: TASK_ROOT },
    stdout: console.log,
    stderr: console.error,
  });
  for (const [file, contents] of files) {
    const target = `${TASK_ROOT}/${file}`;
    py.FS.mkdirTree(target.slice(0, target.lastIndexOf('/')));
    py.FS.writeFile(target, contents);
  }
  // Pyodide holds its own copy now
  files.clear();
  await py.loadPackage(wheels, { messageCallback() {} });
  py.runPython(source);
  const failure: LambdaError | undefined = await py.globals.get('load')(env._HANDLER || 'lambda_function.lambda_handler');
  return failure ? { error: failure } : py.globals.get('invoke');
}

let loaded: Loaded;
try {
  loaded = await (runtime.family === 'python' ? loadPythonHandler(runtime) : loadNodeHandler(runtime));
} catch (error) {
  console.error(`Could not load the handler: ${(error as Error)?.stack ?? error}`);
  loaded = { error: errorPayload(error) };
}

if ('error' in loaded) {
  port.postMessage({ type: 'init-error', error: loaded.error });
  port.close();
} else {
  for (;;) {
    port.postMessage({ type: 'next' });
    const { requestId, deadline, arn, event } = await receive('invocation');
    const outcome = await loaded(event, requestId, deadline, arn);
    if ('error' in outcome) port.postMessage({ type: 'error', requestId, error: outcome.error });
    else port.postMessage({ type: 'response', requestId, result: outcome.result });
  }
}
