// Bundled into a string (scripts/embed.mjs) and run by a child Node, which resolves only
// Node's own modules
import http from 'node:http';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import { loadHandler, loadPythonHandler, locateHandler, nodeInvoker, TASK_ROOT } from './handlers.ts';
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

// The host spawned this process with exactly the function's environment
const env = process.env as Record<string, string>;

async function loadNodeHandler(): Promise<Invoker> {
  const handler = locateHandler(env._HANDLER || 'index.handler', ['.mjs', '.js', '.cjs'], existsSync);
  const module = await import(pathToFileURL(path.resolve(handler.file)).href);
  return nodeInvoker(module, handler, env);
}

// The package is mounted from the host's directory. The host wrote the runtime beside this script
async function loadPython(runtimeFile: string) {
  const runtime: PythonRuntime = JSON.parse(readFileSync(runtimeFile, 'utf8'));
  const pyodideUrl = pathToFileURL(path.join(runtime.indexURL, 'pyodide.mjs')).href;
  return loadPythonHandler(pyodideUrl, runtime, env, (py) => py.mountNodeFS(TASK_ROOT, env.LAMBDA_TASK_ROOT));
}

const loaded = await loadHandler(process.argv[2] ? loadPython(process.argv[2]) : loadNodeHandler());
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
