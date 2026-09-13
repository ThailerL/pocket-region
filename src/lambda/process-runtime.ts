// Shipped as a string (scripts/embed-runtime.mjs), so it may import only Node's own modules
import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';

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

const errorPayload = (error: unknown) => {
  const { name, message, stack } = (error ?? {}) as Partial<Error>;
  return {
    errorType: name ?? 'Error',
    errorMessage: message ?? String(error),
    stackTrace: typeof stack === 'string' ? stack.split('\n') : [],
  };
};

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

let handler: Handler;
try {
  const { file, name } = locateHandler(process.env._HANDLER || 'index.handler');
  const module = await import(pathToFileURL(file).href);
  // A CommonJS handler's exports arrive under default
  handler = module[name] ?? module.default?.[name];
  if (typeof handler !== 'function') {
    throw new Error(`${path.basename(file)} does not export a function named "${name}"`);
  }
} catch (error) {
  console.error(`Could not load the handler: ${(error as Error)?.stack ?? error}`);
  await request('POST', 'init/error', JSON.stringify(errorPayload(error)));
  process.exit(1);
}

for (;;) {
  const next = await request('GET', 'invocation/next');
  // The pool is the only reason to be running
  if (next.status !== 200) process.exit(0);

  const requestId = String(next.headers['lambda-runtime-aws-request-id']);
  const deadline = Number(next.headers['lambda-runtime-deadline-ms']);
  const context = {
    awsRequestId: requestId,
    functionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
    functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION,
    memoryLimitInMB: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE,
    invokedFunctionArn: next.headers['lambda-runtime-invoked-function-arn'],
    logStreamName: process.env.AWS_LAMBDA_LOG_STREAM_NAME,
    getRemainingTimeInMillis: () => Math.max(0, deadline - Date.now()),
  };

  try {
    const result = await handler(JSON.parse(next.body), context);
    await request('POST', `invocation/${requestId}/response`, JSON.stringify(result ?? null));
  } catch (error) {
    console.error(`${requestId}\tERROR\tInvoke Error\t${(error as Error)?.stack ?? error}`);
    await request('POST', `invocation/${requestId}/error`, JSON.stringify(errorPayload(error)));
  }
}
