import { clientConfigFrom } from '../client-config.ts';
import type { CodeEntry, Dispatch, LambdaExecutor } from '../core.ts';
import { IMPORT, rewriteImports } from '../runner/imports.ts';
import { startWorker } from '../start-worker.ts';
import { createLambdaHost, type RegionHostOptions } from './host.ts';
import type { LambdaError, PythonRuntime, RuntimeFamily, SandboxFactory } from './pool.ts';
import { PYTHON_RUNTIME_SOURCE } from './python-runtime.generated.ts';
import type { FetchRequest, FromWorker, Init, ToWorker } from './worker-protocol.ts';
import { WORKER_RUNTIME_SOURCE } from './worker-runtime.generated.ts';

// The URL each bare specifier loads from
type ResolveAll = (specifiers: string[]) => Promise<Record<string, string>>;

export type PythonHost = Omit<PythonRuntime, 'source'>;

// Every file as written, for a Python environment; the modules rewritten, and the URLs their imports load from, for a Node one
type Package = { files: Map<string, Uint8Array>; modules: Map<string, Uint8Array>; preload: string[]; xmldom: string };

const MODULE = /\.m?js$/;
const RELATIVE = /^\.\.?\//;
const XMLDOM = '@xmldom/xmldom';
const decoder = new TextDecoder();
const encoder = new TextEncoder();

const isBare = (specifier: string) => !RELATIVE.test(specifier) && !URL.canParse(specifier);

// A file the rewrite cannot read names nothing to resolve
function importsOf(source: string) {
  try {
    return rewriteImports(source).specifiers;
  } catch {
    return [];
  }
}

// What a file's import names: a neighbour by its path in the package, anything else by URL
const resolverFrom = (path: string, urls: Record<string, string>) => (specifier: string) => {
  if (RELATIVE.test(specifier)) return decodeURIComponent(new URL(specifier, `http://package/${path}`).pathname.slice(1));
  return urls[specifier] ?? specifier;
};

// A module loaded from memory cannot import its neighbours, so imports become calls the runtime
// answers. A file the rewrite cannot read is kept as written: only loading it is the failure
async function rewritePackage(entries: CodeEntry[], resolveAll: ResolveAll): Promise<Package> {
  const sources = entries.filter(([path]) => MODULE.test(path)).map(([path, contents]) => ({ path, contents, source: decoder.decode(contents) }));
  const bare = [...new Set([XMLDOM, ...sources.flatMap(({ source }) => importsOf(source)).filter(isBare)])];
  const urls = await resolveAll(bare);

  const modules = new Map<string, Uint8Array>();
  const preload = new Set<string>();
  for (const { path, contents, source } of sources) {
    try {
      const resolve = resolverFrom(path, urls);
      const { code, specifiers } = rewriteImports(source, resolve);
      for (const url of specifiers.map(resolve).filter((resolved) => URL.canParse(resolved))) preload.add(url);
      modules.set(path, specifiers.length === 0 ? contents : encoder.encode(code));
    } catch {
      modules.set(path, contents);
    }
  }
  const files = new Map(entries.map(([path, contents]) => [path, contents]));
  return { files, modules, preload: [...preload], xmldom: urls[XMLDOM] };
}

// Lambda's handler setting: a file path without its extension, a dot, an export name
function locateHandler(setting: string, files: Map<string, Uint8Array>) {
  const dot = setting.lastIndexOf('.');
  if (dot < 1) throw new Error(`"${setting}" is not a file.export handler`);
  const file = setting.slice(0, dot);
  const found = ['.mjs', '.js'].map((extension) => file + extension).find((name) => files.has(name));
  if (!found) throw new Error(`There is no ${file}.mjs or ${file}.js`);
  return { handler: found, exportName: setting.slice(dot + 1) };
}

// What a worker is told to run the function with
function runtimeFor(family: RuntimeFamily, { files, modules, preload, xmldom }: Package, env: Record<string, string>, python: PythonHost): Init['runtime'] {
  if (family === 'python') return { family, files, ...python, source: PYTHON_RUNTIME_SOURCE };
  const handler = locateHandler(env._HANDLER || 'index.handler', modules);
  return { family, files: modules, importer: IMPORT, ...handler, preload, defaults: clientConfigFrom(env), xmldom };
}

// Each environment is a module worker, the Runtime API a message channel
function workerSandbox(pkg: Package, family: RuntimeFamily, dispatch: Dispatch, python: PythonHost): SandboxFactory {
  return (env, events) => {
    let runtime: Init['runtime'];
    try {
      runtime = runtimeFor(family, pkg, env, python);
    } catch (error) {
      // No worker to start: the failure is reported once the pool has recorded the environment
      queueMicrotask(() => events.exited('failed to initialize', initError(error as Error)));
      return { invoke() {}, kill() {} };
    }

    const worker = startWorker(WORKER_RUNTIME_SOURCE, env.AWS_LAMBDA_LOG_STREAM_NAME);
    const post = (message: ToWorker) => worker.postMessage(message);
    let gone = false;

    // A worker has no exit of its own, so the host ends it and says so
    const exited = (reason: string, error?: LambdaError) => {
      if (gone) return;
      gone = true;
      worker.terminate();
      events.exited(reason, error);
    };

    const relay = async ({ id, method, path, headers, body }: FetchRequest) => {
      try {
        const reply = await dispatch({ method, path, headers, body });
        post({ type: 'fetched', id, status: reply.status, headers: reply.headers, body: reply.body });
      } catch (error) {
        const body = encoder.encode((error as Error).message);
        post({ type: 'fetched', id, status: 500, headers: {}, body });
      }
    };

    worker.onmessage = ({ data }: { data: FromWorker }) => {
      switch (data.type) {
        case 'next':
          return events.ready();
        case 'response':
          return events.responded(data.requestId, data.result);
        case 'error':
          return events.failed(data.requestId, data.error);
        case 'init-error':
          return exited('failed to initialize', data.error);
        case 'output':
          for (const line of data.line.split('\n')) if (line) events.output(line);
          return;
        case 'fetch':
          relay(data);
          return;
      }
    };
    // An error nothing caught: the process analogue is a crash
    worker.onerror = (event) => {
      event.preventDefault?.();
      exited(`uncaught ${event.message}`);
    };
    post({ type: 'init', env, runtime });

    return {
      invoke({ requestId, config, event }, deadline) {
        post({ type: 'invocation', requestId, deadline, arn: config.FunctionArn, event });
      },
      kill: () => exited('terminated'),
    };
  };
}

const initError = (error: Error): LambdaError => ({ errorType: 'Runtime.InitError', errorMessage: error.message });

// Packages stay in memory, rewritten once; each environment gets a copy
export function createWorkerHost({ port, dispatch, lambda, resolveAll, python }: RegionHostOptions & { resolveAll: ResolveAll; python: PythonHost }): LambdaExecutor {
  return createLambdaHost<Package>(
    {
      pack: (_codeSha256, entries) => rewritePackage(entries, resolveAll),
      spawn: (pkg, family) => workerSandbox(pkg, family, dispatch, python),
      dispose: async () => {},
    },
    // The host ministack mints queue URLs on, so a handler following one is answered too
    { endpoint: `http://localhost:${port}`, lambda },
  );
}
