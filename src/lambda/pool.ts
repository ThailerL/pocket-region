import type { FunctionConfig, Invocation, InvocationOutcome } from '../core.ts';

// ministack's account cap is bypassed, so this is the only bound on environments
const DEFAULT_CONCURRENCY = 10;
const IDLE_MS = 60_000;
const INIT_TIMEOUT_MS = 30_000;

export type LambdaError = { errorType: string; errorMessage: string; stackTrace?: string[] };

// One execution environment as the pool sees it, whichever host runs it
export type Sandbox = {
  // Only while the environment is idle: it asked for work and has not been given any
  invoke(invocation: Invocation, deadline: number): void;
  kill(): void;
};

export type SandboxEvents = {
  // The runtime asked for its next invocation
  ready(): void;
  responded(requestId: string, result: string): void;
  failed(requestId: string, error: LambdaError): void;
  // The environment is gone, with the runtime's own init error when it reported one. Never
  // called synchronously from inside kill(), so the pool's own bookkeeping is done first
  exited(reason: string, initError?: LambdaError): void;
  output(line: string): void;
};

export type SandboxFactory = (env: Record<string, string>, events: SandboxEvents) => Sandbox;

export type PoolSettings = {
  spawn: SandboxFactory;
  // What a handler's AWS_ENDPOINT_URL names
  endpoint: string;
  onOutput?: (line: string) => void;
};

type Pending = {
  invocation: Invocation;
  resolve(outcome: InvocationOutcome): void;
};

type Running = Pending & {
  environment: Environment;
  timer: ReturnType<typeof setTimeout>;
  log: string[];
};

type Environment = {
  id: string;
  sandbox: Sandbox;
  state: 'starting' | 'idle' | 'busy';
  running?: Running;
  // Init output, handed to the first invocation
  log: string[];
  idleTimer?: ReturnType<typeof setTimeout>;
  initTimer: ReturnType<typeof setTimeout>;
  startupFailed?: boolean;
  onExit?: () => void;
};

export const failure = (error: LambdaError, log = ''): InvocationOutcome => ({
  status: 'error',
  payload: JSON.stringify(error),
  log,
});

// The runtime's error payload; anything else is a runtime that died mid-sentence
export function parseError(text: string): LambdaError {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.errorMessage === 'string') return parsed;
  } catch {
    // not JSON
  }
  return { errorType: 'Runtime.Error', errorMessage: text };
}

// Lambda's environment as a handler sees it; a host adds what only it can name
const environmentVariables = (config: FunctionConfig, logStream: string, endpoint: string) => ({
  AWS_LAMBDA_FUNCTION_NAME: config.FunctionName,
  AWS_LAMBDA_FUNCTION_VERSION: config.Version,
  AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(config.MemorySize),
  AWS_LAMBDA_LOG_STREAM_NAME: logStream,
  _HANDLER: config.Handler,
  AWS_REGION: 'us-east-1',
  AWS_DEFAULT_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  AWS_ENDPOINT_URL: endpoint,
  ...config.Environment?.Variables,
});

// Timers must not hold Node open; a page has no such thing
const unref = (timer: ReturnType<typeof setTimeout>) => {
  (timer as { unref?: () => void }).unref?.();
  return timer;
};

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

  private count(state: Environment['state']) {
    return [...this.environments.values()].filter((env) => env.state === state).length;
  }

  private capacity() {
    const coming = this.environments.size - this.count('busy');
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
      if (env.state === 'idle') this.assign(env, this.pending.shift()!);
    }
    let uncovered = this.pending.length - this.count('starting');
    while (uncovered > 0 && this.environments.size < this.cap) {
      this.spawn(this.pending[0]!.invocation.config);
      uncovered--;
    }
  }

  private spawn(config: FunctionConfig) {
    const id = crypto.randomUUID().slice(0, 8);
    // Every event arrives after env is assigned
    const env: Environment = {
      id,
      state: 'starting',
      log: [],
      initTimer: unref(setTimeout(() => this.reap(env, 'never asked for work'), INIT_TIMEOUT_MS)),
      sandbox: this.settings.spawn(environmentVariables(config, id, this.settings.endpoint), {
        ready: () => this.ready(env),
        responded: (requestId, result) => this.complete(this.owned(env, requestId), undefined, result),
        failed: (requestId, error) => this.complete(this.owned(env, requestId), error),
        exited: (reason, initError) => this.exited(env, reason, initError),
        output: (line) => this.output(env, line),
      }),
    };
    this.environments.set(id, env);
  }

  private owned(env: Environment, requestId: string) {
    const running = this.inFlight.get(requestId);
    return running?.environment === env ? running : undefined;
  }

  private ready(env: Environment) {
    clearTimeout(env.initTimer);
    env.state = 'idle';
    env.idleTimer = unref(setTimeout(() => this.reap(env, `idle for ${IDLE_MS / 1000} s`), IDLE_MS));
    this.dispatch();
  }

  private output(env: Environment, line: string) {
    (env.running?.log ?? env.log).push(line);
    this.settings.onOutput?.(line);
  }

  private exited(env: Environment, reason: string, initError?: LambdaError) {
    clearTimeout(env.initTimer);
    clearTimeout(env.idleTimer);
    if (!this.environments.delete(env.id)) return;
    if (env.state === 'starting') {
      this.failStartup(
        env,
        initError ?? {
          errorType: 'Runtime.InitError',
          errorMessage: 'The execution environment stopped before it asked for an invocation',
        },
      );
    }
    if (env.running) {
      this.complete(env.running, { errorType: 'Runtime.ExitError', errorMessage: `Runtime exited with error: ${reason}` });
    }
    env.onExit?.();
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
    env.sandbox.kill();
  }

  private assign(env: Environment, { invocation, resolve }: Pending) {
    clearTimeout(env.idleTimer);
    env.state = 'busy';
    const budget = invocation.config.Timeout * 1000;
    const running: Running = {
      invocation,
      resolve,
      environment: env,
      timer: unref(setTimeout(() => this.timeOut(running), budget)),
      log: env.log.splice(0),
    };
    env.running = running;
    this.inFlight.set(invocation.requestId, running);
    env.sandbox.invoke(invocation, Date.now() + budget);
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

  private complete(running: Running | undefined, error?: LambdaError, result?: string) {
    if (!running || !this.inFlight.delete(running.invocation.requestId)) return;
    clearTimeout(running.timer);
    running.environment.running = undefined;
    const log = running.log.join('\n');
    running.resolve(error ? failure(error, log) : { status: 'ok', payload: result ?? null, log });
  }

  async stop() {
    this.stopped = true;
    for (const { resolve } of this.pending.splice(0)) {
      resolve(failure({ errorType: 'Runtime.ExitError', errorMessage: 'The region stopped' }));
    }
    const exits = [...this.environments.values()].map(
      (env) =>
        new Promise<void>((done) => {
          env.onExit = done;
          this.reap(env, 'the region stopped');
        }),
    );
    await Promise.all(exits);
  }
}
