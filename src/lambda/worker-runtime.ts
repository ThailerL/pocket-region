// Bundled into a string (scripts/embed.mjs) and run as a module worker from a Blob URL,
// so what it imports must need only web globals
import { withClientConfig } from '../client-classes.ts';
import { promiseCache } from '../promise-cache.ts';
import { loadHandler, loadPythonHandler, nodeInvoker, TASK_ROOT, type Module } from './handlers.ts';
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

const { env, runtime } = await receive('init');
// What a handler reads its configuration from, as it does on Lambda
(globalThis as { process?: unknown }).process = { env };
interceptFetch(env.AWS_ENDPOINT_URL!);

async function loadNodeHandler({ files, importer, file, exportName, preload, defaults, xmldom }: NodeInit): Promise<Invoker> {
  const modules = promiseCache<Module>();

  async function polyfillDom() {
    if ('DOMParser' in globalThis) return;
    const { DOMParser, Node } = await import(xmldom);
    Object.assign(globalThis, { DOMParser, Node });
  }

  // An SDK client package comes with what its browser build expects of a page, and the
  // configuration its browser build reads from no environment
  async function fromUrl(url: string) {
    const module: Module = await import(url);
    if (typeof module.__Client !== 'function') return module;
    await polyfillDom();
    return withClientConfig(module, (config) => ({ ...defaults, ...config }));
  }

  // Answers the calls the host rewrote imports into: a path in the package, or a URL
  function loadModule(specifier: string): Promise<Module> {
    return modules(specifier, () => {
      const source = files.get(specifier);
      if (source) return importModule(source);
      if (URL.canParse(specifier)) return fromUrl(specifier);
      return Promise.reject(new Error(`The package has no ${specifier}`));
    });
  }
  (globalThis as Record<string, unknown>)[importer] = loadModule;

  // Rejections are seen where the handler imports them
  for (const url of preload) loadModule(url).catch(() => {});

  return nodeInvoker(await loadModule(file), { file, exportName }, env);
}

// The package's files are copied in, as the worker has no disk to mount
async function loadPython(runtime: PythonInit) {
  return loadPythonHandler(`${runtime.indexURL}pyodide.mjs`, runtime, env, (py) => {
    for (const [file, contents] of runtime.files) {
      const target = `${TASK_ROOT}/${file}`;
      py.FS.mkdirTree(target.slice(0, target.lastIndexOf('/')));
      py.FS.writeFile(target, contents);
    }
    // Pyodide holds its own copy now
    runtime.files.clear();
  });
}

const loaded = await loadHandler(runtime.family === 'python' ? loadPython(runtime) : loadNodeHandler(runtime));

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
