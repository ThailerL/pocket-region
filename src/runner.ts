import { createRegion, type BrowserRegionOptions } from './browser.ts';
import { jspiSupported, type Region } from './core.ts';
import { fromImportMap } from './import-map.ts';
import { answer, pendingCalls, toWire } from './region/protocol.ts';
import { portFor } from './region/proxy.ts';
import type { FromRunnerWorker, RunnerOutput, ToRunnerWorker } from './runner/protocol.ts';
import { importing, onFailure, siblingUrl, startWorker } from './start-worker.ts';

export type { ConsoleMethod, RunnerOutput } from './runner/protocol.ts';
export type RunnerStatus = 'booting' | 'resetting' | 'setting-up' | 'running';
export type RunResult = { ok: true; durationMs: number } | { ok: false; durationMs: number; error: unknown };

export type RunOptions = {
  onOutput?: (output: RunnerOutput) => void;
  onStatus?: (status: RunnerStatus) => void;
};

export type RunnerOptions = {
  // Where a snippet's import of anything but pocket-region loads from
  resolve?: (specifier: string) => string;
} & (
  // A region to run against, left as it is
  | { region: Region; boot?: never; reset?: never; setup?: never }
  // Options for the region the runner boots and empties between runs, and code run on it while empty
  | { region?: never; boot?: BrowserRegionOptions; reset?: RunnerReset; setup?: string }
);

// 'never' keeps what earlier runs made, for examples that build on each other
export type RunnerReset = 'each-run' | 'never';

export type Runner = {
  readonly supported: boolean;
  run(code: string, options?: RunOptions): Promise<RunResult>;
  stop(): Promise<void>;
};

const fromCdn = (specifier: string) => fromImportMap(specifier, () => `https://cdn.jsdelivr.net/npm/${specifier}/+esm`);

export function createRunner(options: RunnerOptions = {}): Runner {
  const resolve = options.resolve ?? fromCdn;
  let own: Promise<Region> | undefined;
  // The runner's region, once it was last emptied and set up in full
  let prepared: Promise<Region> | undefined;
  let worker: Worker | undefined;
  let current: RunOptions | undefined;
  const runs = pendingCalls<void>();
  // One snippet at a time: they share the region
  let queue: Promise<unknown> = Promise.resolve();

  // Fresh when just booted or emptied, and so due for setup
  function regionFor(onStatus: (status: RunnerStatus) => void): { region: Promise<Region>; fresh: boolean } {
    if (options.region) return { region: Promise.resolve(options.region), fresh: false };
    if (!own) {
      onStatus('booting');
      own = createRegion(options.boot);
      own.catch(() => (own = undefined));
      return { region: own, fresh: true };
    }
    // A setup that failed partway leaves the region to be emptied before it runs again
    if (options.reset !== 'never' || prepared !== own) {
      onStatus('resetting');
      const emptied = own.then(async (region) => {
        await region.reset();
        return region;
      });
      return { region: emptied, fresh: true };
    }
    return { region: own, fresh: false };
  }

  // Ends whatever is running, however stuck; the next run starts a fresh worker
  const abort = (error: Error) => {
    worker?.terminate();
    worker = undefined;
    runs.fail(error);
  };

  function workerFor() {
    if (worker) return worker;
    const started = startWorker(importing(siblingUrl('runner/worker')), 'pocket-region-runner');
    onFailure(started, "the runner's worker", abort);
    started.onmessage = ({ data }: MessageEvent<FromRunnerWorker>) => {
      switch (data.type) {
        case 'resolve':
          answer(async () => resolve(data.specifier), (url, error) => started.postMessage({ type: 'resolved', id: data.id, url, error }));
          return;
        case 'output':
          return current?.onOutput?.(data.output);
        case 'done':
          return runs.settle(data.id);
        case 'failed':
          return runs.settle(data.id, undefined, data.error);
      }
    };
    return (worker = started);
  }

  async function attach(target: Worker, id: number, region: Promise<Region>) {
    try {
      const port = portFor(await region);
      target.postMessage({ type: 'region', id, port } satisfies ToRunnerWorker, [port]);
    } catch (error) {
      target.postMessage({ type: 'region', id, error: toWire(error) } satisfies ToRunnerWorker);
    }
  }

  // The code's imports start loading now; it runs once attach sends its region
  function post(target: Worker, code: string) {
    let id = 0;
    const finished = runs.start((started) => target.postMessage({ type: 'run', id: (id = started), code } satisfies ToRunnerWorker));
    finished.catch(() => {});
    return { id, finished };
  }

  async function complete(target: Worker, run: ReturnType<typeof post>, region: Promise<Region>, status: RunnerStatus, onStatus: (status: RunnerStatus) => void) {
    // A run that fails first still waits for its region, so the next run never overlaps a boot or reset
    const [outcome] = await Promise.allSettled([run.finished, attach(target, run.id, region).then(() => onStatus(status))]);
    if (outcome.status === 'rejected') throw outcome.reason;
  }

  async function execute(code: string, runOptions: RunOptions) {
    const { onStatus = () => {} } = runOptions;
    const target = workerFor();
    const { region, fresh } = regionFor(onStatus);
    const booted = own;
    const setup = fresh && options.setup !== undefined ? post(target, options.setup) : undefined;
    const snippet = post(target, code);

    if (setup) {
      const held: RunnerOutput[] = [];
      current = { onOutput: (output) => held.push(output) };
      try {
        await complete(target, setup, region, 'setting-up', onStatus);
      } catch (error) {
        held.forEach((output) => runOptions.onOutput?.(output));
        const failure = new Error(`setup failed: ${(error as Error).message}`, { cause: error });
        await attach(target, snippet.id, Promise.reject(failure));
        await snippet.finished.catch(() => {});
        throw failure;
      }
    }
    if (fresh) prepared = booted;

    current = runOptions;
    await complete(target, snippet, region, 'running', onStatus);
  }

  return {
    supported: jspiSupported(),
    run(code, runOptions = {}) {
      const result = queue.then(async (): Promise<RunResult> => {
        const started = performance.now();
        try {
          await execute(code, runOptions);
          return { ok: true, durationMs: performance.now() - started };
        } catch (error) {
          return { ok: false, durationMs: performance.now() - started, error };
        }
      });
      queue = result;
      return result;
    },
    // The runner's own region goes with the worker, and a later run boots again
    async stop() {
      abort(new Error('stopped'));
      await queue;
      const booted = own;
      own = undefined;
      await (await booted?.catch(() => undefined))?.stop();
    },
  };
}
