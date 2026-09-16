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
  // Whether setup has succeeded since the runner's region last booted or reset
  let setUp = false;
  let worker: Worker | undefined;
  let current: RunOptions | undefined;
  const runs = pendingCalls<void>();
  // One snippet at a time: they share the region
  let queue: Promise<unknown> = Promise.resolve();

  async function regionFor(onStatus: (status: RunnerStatus) => void) {
    if (options.region) return options.region;
    if (!own) {
      onStatus('booting');
      setUp = false;
      own = createRegion(options.boot);
      own.catch(() => (own = undefined));
    } else if (options.reset !== 'never' || (options.setup !== undefined && !setUp)) {
      // A setup that failed partway leaves the region to be emptied before it runs again
      onStatus('resetting');
      setUp = false;
      await (await own).reset();
    }
    return own;
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

  async function attach(target: Worker, region: Promise<Region>) {
    try {
      const port = portFor(await region);
      target.postMessage({ type: 'region', port } satisfies ToRunnerWorker, [port]);
    } catch (error) {
      target.postMessage({ type: 'region', error: toWire(error) } satisfies ToRunnerWorker);
    }
  }

  async function runIn(target: Worker, code: string, region: Promise<Region>, announce: () => void) {
    // Posted first, so the code's imports load while the region boots
    const finished = runs.start((id) => target.postMessage({ type: 'run', id, code } satisfies ToRunnerWorker));
    // A run that fails first still waits for the region, so the next run's port isn't taken by this one
    const [outcome] = await Promise.allSettled([finished, attach(target, region).then(announce)]);
    if (outcome.status === 'rejected') throw outcome.reason;
  }

  async function execute(code: string, runOptions: RunOptions) {
    const { onStatus = () => {} } = runOptions;
    const target = workerFor();
    const region = regionFor(onStatus);

    if (options.setup !== undefined && !setUp) {
      const held: RunnerOutput[] = [];
      current = { onOutput: (output) => held.push(output) };
      try {
        await runIn(target, options.setup, region, () => onStatus('setting-up'));
      } catch (error) {
        held.forEach((output) => runOptions.onOutput?.(output));
        throw new Error(`setup failed: ${(error as Error).message}`, { cause: error });
      }
      setUp = true;
    }

    current = runOptions;
    await runIn(target, code, region, () => onStatus('running'));
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
