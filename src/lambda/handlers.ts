// What both runtimes do with a handler, bundled into each: nothing here may need Node or a DOM
import type { LambdaError } from '../core.ts';
import type { Invoker, PythonRuntime } from './pool.ts';
import type { PyodideInterface } from 'pyodide';

export type Module = Record<string, unknown>;
type Environment = Record<string, string>;
// The handler's file in the package and the name it exports the handler under
type HandlerLocation = { file: string; exportName: string };

// A handler ready to invoke, or the init error its runtime already logged
type Loaded = Invoker | { error: LambdaError };

// Where Lambda keeps the package, so a handler's paths hold
export const TASK_ROOT = '/var/task';

const errorPayload = (error: unknown): LambdaError => {
  const { name, message, stack } = (error ?? {}) as Partial<Error>;
  return {
    errorType: name ?? 'Error',
    errorMessage: message ?? String(error),
    stackTrace: typeof stack === 'string' ? stack.split('\n') : [],
  };
};

// Lambda's handler setting: a file path without its extension, a dot, an export name
export function locateHandler(setting: string, extensions: string[], exists: (file: string) => boolean): HandlerLocation {
  const dot = setting.lastIndexOf('.');
  if (dot < 1) throw new Error(`"${setting}" is not a file.export handler`);
  const candidates = extensions.map((extension) => setting.slice(0, dot) + extension);
  const file = candidates.find(exists);
  if (!file) throw new Error(`There is no ${new Intl.ListFormat('en', { type: 'disjunction' }).format(candidates)}`);
  return { file, exportName: setting.slice(dot + 1) };
}

// The handler a Node module exports, invoked as Lambda's Node runtime does
export function nodeInvoker(module: Module, { file, exportName }: HandlerLocation, env: Environment): Invoker {
  // A CommonJS handler's exports arrive under default
  const handler = module[exportName] ?? (module.default as Module | undefined)?.[exportName];
  if (typeof handler !== 'function') {
    throw new Error(`${file} does not export a function named "${exportName}"`);
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

// A Python handler runs under an interpreter of its own, its errors reported by the runtime's Python.
// install puts the package at TASK_ROOT
export async function loadPythonHandler(
  pyodideUrl: string,
  { indexURL, wheels, source }: PythonRuntime,
  env: Environment,
  install: (py: PyodideInterface) => void,
): Promise<Loaded> {
  const { loadPyodide }: typeof import('pyodide') = await import(pyodideUrl);
  const py = await loadPyodide({ indexURL, env: { ...env, LAMBDA_TASK_ROOT: TASK_ROOT }, stdout: console.log, stderr: console.error });
  install(py);
  await py.loadPackage(wheels, { messageCallback() {} });
  py.runPython(source);
  const failure: LambdaError | undefined = await py.globals.get('load')(env._HANDLER || 'lambda_function.lambda_handler');
  return failure ? { error: failure } : py.globals.get('invoke');
}

// A load that fails is logged and reported as the init error
export async function loadHandler(loading: Promise<Loaded>): Promise<Loaded> {
  try {
    return await loading;
  } catch (error) {
    console.error(`Could not load the handler: ${(error as Error)?.stack ?? error}`);
    return { error: errorPayload(error) };
  }
}
