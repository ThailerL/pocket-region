import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { buffer } from 'node:stream/consumers';
import type { FunctionConfig, Invocation, InvocationOutcome } from '../core.ts';

const RUNTIME_API_PREFIX = '/2018-06-01/runtime/';
// ministack's account cap is bypassed, so this is the only bound on processes
const DEFAULT_CONCURRENCY = 10;
const IDLE_MS = 60_000;
const INIT_TIMEOUT_MS = 30_000;

export type PoolSettings = {
  runtimeScript: string;
  taskRoot: string;
  endpoint: string;
  onOutput?: (line: string) => void;
};

export type LambdaError = { errorType: string; errorMessage: string; stackTrace?: string[] };

type Pending = {
  invocation: Invocation;
  resolve(outcome: InvocationOutcome): void;
};

type Running = Pending & {
  environment: Environment;
  startedAt: number;
  timer: NodeJS.Timeout;
  log: string[];
};

type Environment = {
  id: string;
  child?: ChildProcess;
  server: http.Server;
  ready?: boolean;
  // Present exactly while the environment is idle
  waiting?: http.ServerResponse;
  running?: Running;
  // Init output, handed to the first invocation
  log: string[];
  idleTimer?: NodeJS.Timeout;
  initTimer: NodeJS.Timeout;
  startupFailed?: boolean;
};

export const failure = (error: LambdaError, log = ''): InvocationOutcome => ({
  status: 'error',
  payload: JSON.stringify(error),
  log,
});

const EMPTY = Buffer.alloc(0);

export class FunctionPool {
  private readonly environments = new Map<string, Environment>();
  private readonly pending: Pending[] = [];
  private readonly inFlight = new Map<string, Running>();
  private stopped = false;
  // PutFunctionConcurrency can change it between invocations
  private cap = DEFAULT_CONCURRENCY;
  private readonly settings: PoolSettings;

  // An explicit field: parameter properties are not erasable syntax, and plain Node runs this
  constructor(settings: PoolSettings) {
    this.settings = settings;
  }

  private count(test: (env: Environment) => unknown) {
    return [...this.environments.values()].filter(test).length;
  }

  private capacity() {
    const coming = this.count((env) => env.waiting || !env.ready);
    return coming + this.cap - this.environments.size - this.pending.length;
  }

  // Lambda throttles past the cap rather than queueing
  invoke(invocation: Invocation): Promise<InvocationOutcome> {
    return new Promise((resolve) => {
      this.cap = invocation.reservedConcurrency ?? DEFAULT_CONCURRENCY;
      if (this.stopped || this.capacity() < 1) return resolve({ status: 'throttled', payload: null, log: '' });
      this.pending.push({ invocation, resolve });
      this.dispatch();
    });
  }

  // A starting environment takes work when ready, so spawn only for what none will cover
  private dispatch() {
    for (const env of this.environments.values()) {
      if (this.pending.length === 0) break;
      if (env.waiting) this.assign(env, this.pending.shift()!);
    }
    let uncovered = this.pending.length - this.count((env) => !env.ready);
    while (uncovered > 0 && this.environments.size < this.cap) {
      this.spawn(this.pending[0]!.invocation.config);
      uncovered--;
    }
  }

  private spawn(config: FunctionConfig) {
    const id = randomUUID().slice(0, 8);
    const server = http.createServer(async (req, res) => {
      try {
        const body = req.method === 'POST' ? await buffer(req) : EMPTY;
        this.handleRuntimeApi(env, req, res, body);
      } catch (error) {
        respondJson(res, 500, { errorMessage: (error as Error).message });
      }
    });
    const env: Environment = {
      id,
      server,
      log: [],
      initTimer: setTimeout(() => this.reap(env, 'never asked for work'), INIT_TIMEOUT_MS).unref(),
    };
    this.environments.set(id, env);

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      const child = spawn(process.execPath, [this.settings.runtimeScript], {
        cwd: this.settings.taskRoot,
        // Not the parent's environment: a handler sees only what Lambda would give it
        env: {
          PATH: process.env.PATH ?? '',
          AWS_LAMBDA_FUNCTION_NAME: config.FunctionName,
          AWS_LAMBDA_FUNCTION_VERSION: config.Version,
          AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(config.MemorySize),
          AWS_LAMBDA_LOG_STREAM_NAME: id,
          AWS_LAMBDA_RUNTIME_API: `127.0.0.1:${port}`,
          LAMBDA_TASK_ROOT: this.settings.taskRoot,
          _HANDLER: config.Handler,
          AWS_REGION: 'us-east-1',
          AWS_DEFAULT_REGION: 'us-east-1',
          AWS_ACCESS_KEY_ID: 'test',
          AWS_SECRET_ACCESS_KEY: 'test',
          AWS_ENDPOINT_URL: this.settings.endpoint,
          ...config.Environment?.Variables,
        },
      });
      env.child = child;
      const forward = (stream: NodeJS.ReadableStream | null) => {
        let carry = '';
        stream?.on('data', (chunk: Buffer) => {
          const lines = (carry + chunk).split('\n');
          carry = lines.pop() ?? '';
          for (const line of lines) if (line) this.output(env, line);
        });
        stream?.on('end', () => {
          if (carry) this.output(env, carry);
        });
      };
      forward(child.stdout);
      forward(child.stderr);
      child.on('error', (error) =>
        this.failStartup(env, { errorType: 'Runtime.InitError', errorMessage: error.message }),
      );
      child.on('exit', (code, signal) => this.exited(env, code, signal));
    });
  }

  // Starting or busy environments keep Node running, so every invocation is answered; idle ones must not
  private hold(env: Environment, held: boolean) {
    for (const handle of [env.server, env.child]) {
      if (held) handle?.ref();
      else handle?.unref();
    }
  }

  private output(env: Environment, line: string) {
    (env.running?.log ?? env.log).push(line);
    this.settings.onOutput?.(line);
  }

  private exited(env: Environment, code: number | null, signal: NodeJS.Signals | null) {
    clearTimeout(env.initTimer);
    clearTimeout(env.idleTimer);
    env.server.close();
    if (!this.environments.delete(env.id)) return;
    if (!env.ready) {
      this.failStartup(env, {
        errorType: 'Runtime.InitError',
        errorMessage: 'The execution environment stopped before it asked for an invocation',
      });
    }
    if (env.running) {
      this.complete(env.running, {
        errorType: 'Runtime.ExitError',
        errorMessage: `Runtime exited with error: ${signal ? `signal ${signal}` : `exit status ${code}`}`,
      });
    }
    this.dispatch();
  }

  // One invocation fails per broken environment, rather than waiting on a respawn loop
  private failStartup(env: Environment, error: LambdaError) {
    if (env.startupFailed) return;
    env.startupFailed = true;
    this.pending.shift()?.resolve(failure(error, env.log.join('\n')));
  }

  private reap(env: Environment, reason: string) {
    if (!this.environments.has(env.id)) return;
    this.settings.onOutput?.(`Stopping execution environment ${env.id}: ${reason}`);
    env.child?.kill();
  }

  private assign(env: Environment, { invocation, resolve }: Pending) {
    clearTimeout(env.idleTimer);
    this.hold(env, true);
    const res = env.waiting!;
    env.waiting = undefined;
    const { requestId, config, event } = invocation;
    const startedAt = Date.now();
    const budget = config.Timeout * 1000;
    const running: Running = {
      invocation,
      resolve,
      environment: env,
      startedAt,
      timer: setTimeout(() => this.timeOut(running), budget).unref(),
      log: env.log.splice(0),
    };
    env.running = running;
    this.inFlight.set(requestId, running);
    res.writeHead(200, {
      'content-type': 'application/json',
      'lambda-runtime-aws-request-id': requestId,
      'lambda-runtime-deadline-ms': String(startedAt + budget),
      'lambda-runtime-invoked-function-arn': config.FunctionArn,
    });
    res.end(event);
  }

  // Never reused: the handler may still be running in it
  private timeOut(running: Running) {
    const seconds = running.invocation.config.Timeout.toFixed(2);
    this.complete(running, {
      errorType: 'Sandbox.Timedout',
      errorMessage: `Task timed out after ${seconds} seconds`,
    });
    this.reap(running.environment, `timed out after ${seconds} seconds`);
  }

  private complete(running: Running, error?: LambdaError, result?: string) {
    if (!this.inFlight.delete(running.invocation.requestId)) return;
    clearTimeout(running.timer);
    running.environment.running = undefined;
    const log = running.log.join('\n');
    running.resolve(error ? failure(error, log) : { status: 'ok', payload: result ?? null, log });
  }

  private handleRuntimeApi(env: Environment, req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) {
    const path = req.url ?? '';
    if (!path.startsWith(RUNTIME_API_PREFIX)) {
      return respondJson(res, 404, { errorMessage: 'Not a runtime route' });
    }
    const route = path.slice(RUNTIME_API_PREFIX.length);

    if (req.method === 'GET' && route === 'invocation/next') {
      clearTimeout(env.initTimer);
      env.ready = true;
      env.waiting = res;
      this.hold(env, false);
      req.on('close', () => {
        if (env.waiting === res) env.waiting = undefined;
      });
      env.idleTimer = setTimeout(() => this.reap(env, `idle for ${IDLE_MS / 1000} s`), IDLE_MS).unref();
      this.dispatch();
      return;
    }

    const outcome = /^invocation\/([^/]+)\/(response|error)$/.exec(route);
    if (req.method === 'POST' && outcome) {
      const running = this.inFlight.get(outcome[1]!);
      if (!running || running.environment !== env) {
        return respondJson(res, 400, { errorMessage: 'Not this environment’s invocation' });
      }
      const text = body.toString('utf8');
      if (outcome[2] === 'error') this.complete(running, parseError(text));
      else this.complete(running, undefined, text.length > 0 ? text : undefined);
      return respondJson(res, 202, { status: 'OK' });
    }

    if (req.method === 'POST' && route === 'init/error') {
      this.failStartup(env, parseError(body.toString('utf8')));
      this.reap(env, 'failed to initialize');
      return respondJson(res, 202, { status: 'OK' });
    }

    respondJson(res, 404, { errorMessage: `No such runtime route: ${req.method} ${route}` });
  }

  async stop() {
    this.stopped = true;
    for (const { resolve } of this.pending.splice(0)) {
      resolve(failure({ errorType: 'Runtime.ExitError', errorMessage: 'The region stopped' }));
    }
    const exits = [...this.environments.values()].map(
      (env) =>
        new Promise<void>((done) => {
          if (!env.child) return done();
          this.hold(env, true);
          env.child.once('exit', () => done());
          this.reap(env, 'the region stopped');
        }),
    );
    await Promise.all(exits);
  }
}

const respondJson = (res: http.ServerResponse, status: number, value: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));

function parseError(text: string): LambdaError {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.errorMessage === 'string') return parsed;
  } catch {
    // not JSON
  }
  return { errorType: 'Runtime.Error', errorMessage: text };
}
