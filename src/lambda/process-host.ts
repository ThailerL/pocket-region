import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buffer } from 'node:stream/consumers';
import type { CodeEntry, Invocation, LambdaExecutor, PythonWheel } from '../core.ts';
import { serve, type RegionServer } from '../server.ts';
import { createLambdaHost, type RegionHostOptions } from './host.ts';
import { parseError, type LambdaError, type PythonRuntime, type SandboxFactory } from './pool.ts';
import { PROCESS_RUNTIME_SOURCE } from './process-runtime.generated.ts';
import { PYTHON_RUNTIME_SOURCE } from './python-runtime.generated.ts';

const RUNTIME_API_PREFIX = '/2018-06-01/runtime/';
const EMPTY = Buffer.alloc(0);

// Where a Python environment's Pyodide is, and the wheels it preinstalls, cached in cacheDir once fetched
export type PythonInstall = { indexURL: string; wheels: PythonWheel[]; cacheDir: string };

type Package = { taskRoot: string; runtimeScript: string };

// Each environment is a child process with its own Runtime API listener. A Python one is handed
// the file its runtime is described in, once the host has it ready
function processSandbox({ taskRoot, runtimeScript }: Package, pythonRuntime?: () => Promise<string>): SandboxFactory {
  return (env, events) => {
    let child: ChildProcess | undefined;
    // Present exactly while the environment is idle
    let waiting: http.ServerResponse | undefined;
    let initError: LambdaError | undefined;
    let killed = false;
    let gone = false;

    // Starting or busy environments keep Node running, so every invocation is answered; idle
    // ones must not
    const hold = (held: boolean) => {
      for (const handle of [server, child]) {
        if (held) handle?.ref();
        else handle?.unref();
      }
    };

    const exited = (reason: string) => {
      if (gone) return;
      gone = true;
      server.close();
      events.exited(reason, initError);
    };

    const server = http.createServer(async (req, res) => {
      try {
        const body = req.method === 'POST' ? await buffer(req) : EMPTY;
        handle(req, res, body);
      } catch (error) {
        respondJson(res, 500, { errorMessage: (error as Error).message });
      }
    });

    function handle(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) {
      const url = req.url ?? '';
      if (!url.startsWith(RUNTIME_API_PREFIX)) {
        return respondJson(res, 404, { errorMessage: 'Not a runtime route' });
      }
      const route = url.slice(RUNTIME_API_PREFIX.length);

      if (req.method === 'GET' && route === 'invocation/next') {
        waiting = res;
        req.on('close', () => {
          if (waiting === res) waiting = undefined;
        });
        hold(false);
        events.ready();
        return;
      }

      const outcome = /^invocation\/([^/]+)\/(response|error)$/.exec(route);
      if (req.method === 'POST' && outcome) {
        const text = body.toString('utf8');
        if (outcome[2] === 'error') events.failed(outcome[1]!, parseError(text));
        else events.responded(outcome[1]!, text);
        return respondJson(res, 202, { status: 'OK' });
      }

      if (req.method === 'POST' && route === 'init/error') {
        initError = parseError(body.toString('utf8'));
        respondJson(res, 202, { status: 'OK' });
        // The runtime exits itself after this; a custom one might not
        child?.kill();
        return;
      }

      respondJson(res, 404, { errorMessage: `No such runtime route: ${req.method} ${route}` });
    }

    server.listen(0, '127.0.0.1', async () => {
      const args = [runtimeScript];
      try {
        if (pythonRuntime) args.push(await pythonRuntime());
      } catch (error) {
        initError = { errorType: 'Runtime.InitError', errorMessage: (error as Error).message };
        return exited((error as Error).message);
      }
      if (killed) return exited('killed before it started');
      const { port } = server.address() as { port: number };
      child = spawn(process.execPath, args, {
        cwd: taskRoot,
        // Not the parent's environment: a handler sees only what Lambda would give it
        env: {
          PATH: process.env.PATH ?? '',
          ...env,
          AWS_LAMBDA_RUNTIME_API: `127.0.0.1:${port}`,
          LAMBDA_TASK_ROOT: taskRoot,
        },
      });
      forwardLines(child.stdout, events.output);
      forwardLines(child.stderr, events.output);
      child.on('error', (error) => {
        initError = { errorType: 'Runtime.InitError', errorMessage: error.message };
        exited(error.message);
      });
      child.on('exit', (code, signal) => exited(signal ? `signal ${signal}` : `exit status ${code}`));
    });

    return {
      invoke({ requestId, config, event }: Invocation, deadline: number) {
        const res = waiting!;
        waiting = undefined;
        hold(true);
        res.writeHead(200, {
          'content-type': 'application/json',
          'lambda-runtime-aws-request-id': requestId,
          'lambda-runtime-deadline-ms': String(deadline),
          'lambda-runtime-invoked-function-arn': config.FunctionArn,
        });
        res.end(event);
      },
      kill() {
        killed = true;
        // An idle child is unref'd, and Node would exit before its exit is seen
        hold(true);
        child?.kill();
      },
    };
  };
}

function forwardLines(stream: NodeJS.ReadableStream | null, output: (line: string) => void) {
  let carry = '';
  stream?.on('data', (chunk: Buffer) => {
    const lines = (carry + chunk).split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) if (line) output(line);
  });
  stream?.on('end', () => {
    if (carry) output(carry);
  });
}

const respondJson = (res: http.ServerResponse, status: number, value: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));

async function nearestNodeModules() {
  for (let directory = process.cwd(); ; ) {
    const candidate = path.join(directory, 'node_modules');
    if (await stat(candidate).then((entry) => entry.isDirectory(), () => false)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

// A wheel is fetched once per machine and checked against the manifest's checksum
async function cachedWheel({ file, url, sha256 }: PythonWheel, cacheDir: string) {
  const target = path.join(cacheDir, file);
  if (await stat(target).then(() => true, () => false)) return target;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url}: ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== sha256) throw new Error(`${file} from ${url} has SHA-256 ${digest}, not ${sha256}`);
  // Renamed into place whole: another region fetching the same wheel never reads half of it
  const pending = `${target}.${process.pid}.part`;
  await writeFile(pending, bytes);
  await rename(pending, target);
  return target;
}

// Packages are unpacked into a temp directory by code hash, the runtime beside them. The
// region is served on its port from the first environment on, since a handler's SDK calls
// arrive from another process, and queue URLs name that port
export function createProcessHost({ port, dispatch, lambda, python }: RegionHostOptions & { python: PythonInstall }): LambdaExecutor {
  let root: Promise<string> | undefined;
  let served: Promise<RegionServer | undefined> | undefined;
  let pythonReady: Promise<string> | undefined;

  async function serveRegion() {
    try {
      const server = await serve({ dispatch, port });
      server.unref();
      return server;
    } catch (error) {
      // A port already taken is the caller's own serve(region), which answers just as well
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      return undefined;
    }
  }

  const workspace = () =>
    (root ??= mkdtemp(path.join(tmpdir(), 'pocket-region-lambda-')).then(async (directory) => {
      const nodeModules = await nearestNodeModules();
      await Promise.all([
        writeFile(path.join(directory, 'runtime.mjs'), PROCESS_RUNTIME_SOURCE),
        // A handler's bare imports reach the project's packages, as Lambda's reach its SDK
        nodeModules && symlink(nodeModules, path.join(directory, 'node_modules'), 'junction'),
      ]);
      return directory;
    }));

  // Once per host, on the first Python environment; a failed fetch is tried again by the next one
  const pythonRuntime = () =>
    (pythonReady ??= (async () => {
      await mkdir(python.cacheDir, { recursive: true });
      const [directory, wheels] = await Promise.all([
        workspace(),
        Promise.all(python.wheels.map((wheel) => cachedWheel(wheel, python.cacheDir))),
      ]);
      const runtime: PythonRuntime = { indexURL: python.indexURL, wheels, source: PYTHON_RUNTIME_SOURCE };
      const runtimeFile = path.join(directory, 'python.json');
      await writeFile(runtimeFile, JSON.stringify(runtime));
      return runtimeFile;
    })().catch((error) => {
      pythonReady = undefined;
      throw error;
    }));

  return createLambdaHost<Package>(
    {
      async pack(codeSha256: string, entries: CodeEntry[]) {
        // Before any environment: a handler's first SDK call may come during init
        await (served ??= serveRegion());
        const directory = await workspace();
        // The hash is base64, which is not a directory name
        const taskRoot = path.join(directory, Buffer.from(codeSha256, 'base64').toString('hex'));
        const files = entries
          .map(([file, contents, mode]) => ({ target: path.join(taskRoot, file), contents, mode }))
          .filter(({ target }) => target.startsWith(taskRoot + path.sep));
        const directories = new Set(files.map(({ target }) => path.dirname(target)));
        await Promise.all([...directories].map((dir) => mkdir(dir, { recursive: true })));
        await Promise.all(
          files.map(({ target, contents, mode }) => writeFile(target, contents, { mode: mode || undefined })),
        );
        return { taskRoot, runtimeScript: path.join(directory, 'runtime.mjs') };
      },
      spawn: (pkg, family) => processSandbox(pkg, family === 'python' ? pythonRuntime : undefined),
      async dispose() {
        await (await served)?.close();
        if (root) await rm(await root, { recursive: true, force: true });
      },
    },
    { endpoint: `http://127.0.0.1:${port}`, lambda },
  );
}
