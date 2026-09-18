// Shipped as a string (scripts/embed-runtime.mjs), so it may import only Node's own modules
import http from 'node:http';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import type { PyodideInterface } from 'pyodide';
import type { LambdaError } from '../core.ts';
import type { Invoker, PythonRuntime } from './pool.ts';

const [host, apiPort] = (process.env.AWS_LAMBDA_RUNTIME_API ?? '').split(':');
if (!host || !apiPort) throw new Error('AWS_LAMBDA_RUNTIME_API is not set');

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

function request(method: string, route: string, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port: Number(apiPort),
        path: `/2018-06-01/runtime/${route}`,
        method,
        headers: {
          'content-type': 'application/json',
          ...(body !== undefined && { 'content-length': Buffer.byteLength(body) }),
        },
      },
      async (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: await text(res) }),
    );
    req.on('error', reject);
    req.end(body);
  });
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

// Lambda's handler setting: a file path without its extension, a dot, an export name
function locateHandler(setting: string) {
  const dot = setting.lastIndexOf('.');
  if (dot < 1) throw new Error(`"${setting}" is not a file.export handler`);
  const file = setting.slice(0, dot);
  const found = ['.mjs', '.js', '.cjs']
    .map((extension) => path.resolve(file + extension))
    .find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`There is no ${file}.mjs, ${file}.js or ${file}.cjs`);
  return { file: found, name: setting.slice(dot + 1) };
}

type Handler = (event: unknown, context: object) => unknown;

async function loadNodeHandler(): Promise<Invoker> {
  const { file, name } = locateHandler(process.env._HANDLER || 'index.handler');
  const module = await import(pathToFileURL(file).href);
  // A CommonJS handler's exports arrive under default
  const handler: Handler = module[name] ?? module.default?.[name];
  if (typeof handler !== 'function') {
    throw new Error(`${path.basename(file)} does not export a function named "${name}"`);
  }
  return async (event, requestId, deadline, arn) => {
    const context = {
      awsRequestId: requestId,
      functionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION,
      memoryLimitInMB: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE,
      invokedFunctionArn: arn,
      logStreamName: process.env.AWS_LAMBDA_LOG_STREAM_NAME,
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

// A Python handler runs under an interpreter of its own, its errors reported by the runtime's Python.
// The host wrote the runtime beside this script
async function loadPythonHandler(runtimeFile: string): Promise<Loaded> {
  const { indexURL, wheels, source }: PythonRuntime = JSON.parse(readFileSync(runtimeFile, 'utf8'));
  const { loadPyodide }: typeof import('pyodide') = await import(pathToFileURL(path.join(indexURL, 'pyodide.mjs')).href);
  const py: PyodideInterface = await loadPyodide({
    indexURL,
    env: { ...(process.env as Record<string, string>), LAMBDA_TASK_ROOT: TASK_ROOT },
    stdout: console.log,
    stderr: console.error,
  });
  py.mountNodeFS(TASK_ROOT, process.env.LAMBDA_TASK_ROOT!);
  await py.loadPackage(wheels, { messageCallback() {} });
  py.runPython(source);
  const failure: LambdaError | undefined = await py.globals.get('load')(process.env._HANDLER || 'lambda_function.lambda_handler');
  return failure ? { error: failure } : py.globals.get('invoke');
}

let loaded: Loaded;
try {
  loaded = await (process.argv[2] ? loadPythonHandler(process.argv[2]) : loadNodeHandler());
} catch (error) {
  console.error(`Could not load the handler: ${(error as Error)?.stack ?? error}`);
  loaded = { error: errorPayload(error) };
}
if ('error' in loaded) {
  await request('POST', 'init/error', JSON.stringify(loaded.error));
  process.exit(1);
}
const invoke = loaded;

for (;;) {
  const next = await request('GET', 'invocation/next');
  // The pool is the only reason to be running
  if (next.status !== 200) process.exit(0);

  const requestId = String(next.headers['lambda-runtime-aws-request-id']);
  const deadline = Number(next.headers['lambda-runtime-deadline-ms']);
  const arn = String(next.headers['lambda-runtime-invoked-function-arn']);
  const outcome = await invoke(next.body, requestId, deadline, arn);
  if ('error' in outcome) await request('POST', `invocation/${requestId}/error`, JSON.stringify(outcome.error));
  else await request('POST', `invocation/${requestId}/response`, outcome.result);
}
