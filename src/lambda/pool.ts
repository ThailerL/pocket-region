import { awsEnvironment } from '../client-defaults.ts';
import {
  unref,
  type FunctionConfig,
  type Invocation,
  type InvocationOutcome,
  type LambdaEvent,
  type LambdaObserver,
} from '../core.ts';

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
  // The environment is gone, with the runtime's own init error when it reported one
  exited(reason: string, initError?: LambdaError): void;
  output(line: string): void;
};

export type SandboxFactory = (env: Record<string, string>, events: SandboxEvents) => Sandbox;

export type PoolSettings = {
  spawn: SandboxFactory;
  // What a handler's AWS_ENDPOINT_URL names
  endpoint: string;
  lambda: LambdaObserver;
};

type Pending = {
  invocation: Invocation;
  resolve(outcome: InvocationOutcome): void;
};

type Running = Pending & {
  environment: Environment;
  timer: ReturnType<typeof setTimeout>;
  // The environment's init output, then the invocation's own
  init: string[];
  log: string[];
  startedAt: number;
  // Only on an environment's first invocation
  initMs?: number;
};

type Environment = {
  id: string;
  functionName: string;
  sandbox: Sandbox;
  state: 'starting' | 'idle' | 'busy';
  running?: Running;
  spawnedAt: number;
  // Set when the runtime first asks for work, and handed to the first invocation with log
  initMs?: number;
  log: string[];
  idleTimer?: ReturnType<typeof setTimeout>;
  initTimer: ReturnType<typeof setTimeout>;
  startupFailed?: boolean;
  // Why the pool killed it, which the sandbox's own exit reason can't say
  reapedFor?: string;
  onExit?: () => void;
};

export const failure = (message: string, log = ''): InvocationOutcome => ({ status: 'error', message, log });

// Eight hex characters; not randomUUID, which a page served over plain http lacks
const environmentId = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, '0')).join('');

const exitMessage = (reason: string) => `Runtime exited with error: ${reason}`;

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
  ...awsEnvironment({ region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } }),
  AWS_ENDPOINT_URL: endpoint,
  ...config.Environment?.Variables,
});

export class FunctionPool {
  private readonly environments = new Map<string, Environment>();
  private readonly pending: Pending[] = [];
  private readonly inFlight = new Map<string, Running>();
  private stoppedBy: string | undefined;
  private readonly settings: PoolSettings;

  // An explicit field: parameter properties are not erasable syntax, and plain Node runs this
  constructor(settings: PoolSettings) {
    this.settings = settings;
  }

  private count(state: Environment['state']) {
    return [...this.environments.values()].filter((env) => env.state === state).length;
  }

  // The emulator has already counted the invocation against its concurrency
  invoke(invocation: Invocation): Promise<InvocationOutcome> {
    return new Promise((resolve) => {
      if (this.stoppedBy !== undefined) return resolve(failure(exitMessage(this.stoppedBy)));
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
    while (uncovered > 0) {
      this.spawn(this.pending[0]!.invocation.config);
      uncovered--;
    }
  }

  private spawn(config: FunctionConfig) {
    const id = environmentId();
    // Every event arrives after env is assigned
    const env: Environment = {
      id,
      functionName: config.FunctionName,
      state: 'starting',
      log: [],
      spawnedAt: performance.now(),
      initTimer: unref(setTimeout(() => this.reap(env, 'never asked for work'), INIT_TIMEOUT_MS)),
      sandbox: this.settings.spawn(environmentVariables(config, id, this.settings.endpoint), {
        ready: () => this.ready(env),
        responded: (requestId, result) => this.complete(this.owned(env, requestId), undefined, result),
        failed: (requestId, error) => this.complete(this.owned(env, requestId), error.errorMessage),
        exited: (reason, initError) => this.exited(env, reason, initError),
        output: (line) => this.output(env, line),
      }),
    };
    this.environments.set(id, env);
    this.emit({ kind: 'environment', functionName: env.functionName, environment: id, phase: 'started' });
  }

  private emit(event: LambdaEvent) {
    this.settings.lambda.onEvent?.(event);
  }

  private tell(env: Environment, text: string) {
    this.settings.lambda.onOutput?.({ text, functionName: env.functionName, environment: env.id });
  }

  private owned(env: Environment, requestId: string) {
    const running = this.inFlight.get(requestId);
    return running?.environment === env ? running : undefined;
  }

  private ready(env: Environment) {
    clearTimeout(env.initTimer);
    if (env.state === 'starting') env.initMs = performance.now() - env.spawnedAt;
    env.state = 'idle';
    env.idleTimer = unref(setTimeout(() => this.reap(env, `idle for ${IDLE_MS / 1000} s`), IDLE_MS));
    this.dispatch();
  }

  private output(env: Environment, line: string) {
    (env.running?.log ?? env.log).push(line);
    this.tell(env, line);
  }

  private exited(env: Environment, exitReason: string, initError?: LambdaError) {
    const reason = env.reapedFor ?? exitReason;
    clearTimeout(env.initTimer);
    clearTimeout(env.idleTimer);
    if (!this.environments.delete(env.id)) return;
    this.emit({ kind: 'environment', functionName: env.functionName, environment: env.id, phase: 'stopped', reason });
    if (env.state === 'starting') {
      this.failStartup(
        env,
        initError?.errorMessage ?? 'The execution environment stopped before it asked for an invocation',
      );
    }
    if (env.running) {
      this.complete(env.running, exitMessage(reason));
    }
    env.onExit?.();
    this.dispatch();
  }

  // One invocation fails per broken environment, rather than waiting on a respawn loop
  private failStartup(env: Environment, message: string) {
    if (env.startupFailed) return;
    env.startupFailed = true;
    this.pending.shift()?.resolve(failure(message, env.log.join('\n')));
  }

  private reap(env: Environment, reason: string) {
    if (!this.environments.has(env.id)) return;
    this.tell(env, `Stopping execution environment ${env.id}: ${reason}`);
    env.reapedFor = reason;
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
      init: env.log.splice(0),
      log: [],
      startedAt: performance.now(),
      initMs: env.initMs,
    };
    env.initMs = undefined;
    env.running = running;
    this.inFlight.set(invocation.requestId, running);
    this.emit({
      kind: 'invocation',
      functionName: env.functionName,
      environment: env.id,
      requestId: invocation.requestId,
      phase: 'started',
      event: invocation.event,
      coldStart: running.initMs !== undefined,
    });
    this.tell(env, `START RequestId: ${invocation.requestId} Version: ${invocation.config.Version}`);
    env.sandbox.invoke(invocation, Date.now() + budget);
  }

  // Never reused: the handler may still be running in it
  private timeOut(running: Running) {
    const seconds = running.invocation.config.Timeout.toFixed(2);
    this.complete(running, `Task timed out after ${seconds} seconds`);
    this.reap(running.environment, `timed out after ${seconds} seconds`);
  }

  private complete(running: Running | undefined, error?: string, result?: string) {
    if (!running || !this.inFlight.delete(running.invocation.requestId)) return;
    clearTimeout(running.timer);
    const env = running.environment;
    const { invocation, initMs, init, log } = running;
    const { requestId, config } = invocation;
    const durationMs = performance.now() - running.startedAt;
    const report = [
      `REPORT RequestId: ${requestId}`,
      `Duration: ${durationMs.toFixed(2)} ms`,
      `Billed Duration: ${Math.ceil(durationMs)} ms`,
      `Memory Size: ${config.MemorySize} MB`,
      ...(initMs === undefined ? [] : [`Init Duration: ${initMs.toFixed(2)} ms`]),
    ].join('\t');
    this.tell(env, `END RequestId: ${requestId}`);
    this.tell(env, report);
    env.running = undefined;
    this.emit({
      kind: 'invocation',
      functionName: env.functionName,
      environment: env.id,
      requestId,
      phase: 'completed',
      durationMs,
      initMs,
      failed: error !== undefined,
    });
    const output = [...init, ...log].join('\n');
    running.resolve(error ? failure(error, output) : { status: 'ok', payload: result ?? null, log: output });
  }

  async stop(reason: string) {
    this.stoppedBy = reason;
    for (const { resolve } of this.pending.splice(0)) resolve(failure(exitMessage(reason)));
    const exits = [...this.environments.values()].map(
      (env) =>
        new Promise<void>((done) => {
          env.onExit = done;
          this.reap(env, reason);
        }),
    );
    await Promise.all(exits);
  }
}
