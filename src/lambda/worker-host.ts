import type { CodeEntry, Dispatch, LambdaExecutor } from '../core.ts';
import { createLambdaHost, type RegionHostOptions } from './host.ts';
import type { LambdaError, SandboxFactory } from './pool.ts';
import type { FetchRequest, FromWorker, ToWorker } from './worker-protocol.ts';
import { WORKER_RUNTIME_SOURCE } from './worker-runtime.generated.ts';

type Package = CodeEntry[];

let runtimeUrl: string | undefined;

// Lambda's handler setting: a file path without its extension, a dot, an export name. The
// file is one ES module, since a module loaded from memory cannot import its neighbours
function locateHandler(setting: string, files: Package) {
  const dot = setting.lastIndexOf('.');
  if (dot < 1) throw new Error(`"${setting}" is not a file.export handler`);
  const file = setting.slice(0, dot);
  const found = ['.mjs', '.js'].map((extension) => file + extension).map((name) => files.find(([path]) => path === name)).find(Boolean);
  if (!found) throw new Error(`There is no ${file}.mjs or ${file}.js`);
  return { source: found[1], exportName: setting.slice(dot + 1) };
}

// Each environment is a module worker, the Runtime API a message channel
function workerSandbox(files: Package, dispatch: Dispatch): SandboxFactory {
  return (env, events) => {
    let handler: ReturnType<typeof locateHandler>;
    try {
      handler = locateHandler(env._HANDLER || 'index.handler', files);
    } catch (error) {
      // No worker to start: the failure is reported once the pool has recorded the environment
      queueMicrotask(() => events.exited('failed to initialize', initError(error as Error)));
      return { invoke() {}, kill() {} };
    }

    runtimeUrl ??= URL.createObjectURL(new Blob([WORKER_RUNTIME_SOURCE], { type: 'text/javascript' }));
    const worker = new Worker(runtimeUrl, { type: 'module', name: env.AWS_LAMBDA_LOG_STREAM_NAME });
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
        const body = new TextEncoder().encode((error as Error).message);
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
    post({ type: 'init', env, ...handler });

    return {
      invoke({ requestId, config, event }, deadline) {
        post({ type: 'invocation', requestId, deadline, arn: config.FunctionArn, event });
      },
      kill: () => exited('terminated'),
    };
  };
}

const initError = (error: Error): LambdaError => ({ errorType: 'Runtime.InitError', errorMessage: error.message });

// Packages stay in memory; each environment gets a copy of its handler file
export function createWorkerHost({ port, dispatch, lambda }: RegionHostOptions): LambdaExecutor {
  return createLambdaHost<Package>(
    {
      pack: async (_codeSha256, entries) => entries,
      spawn: (files) => workerSandbox(files, dispatch),
      dispose: async () => {},
    },
    // The host ministack mints queue URLs on, so a handler following one is answered too
    { endpoint: `http://localhost:${port}`, lambda },
  );
}
