import { createRegion, type BrowserRegionOptions } from './browser.ts';
import { jspiSupported, type Region } from './core.ts';
import { fromImportMap } from './import-map.ts';
import { answer, pendingCalls, toWire } from './region/protocol.ts';
import { portFor } from './region/proxy.ts';
import type { FromRunnerWorker, RunnerStream, ToRunnerWorker } from './runner/protocol.ts';
import { importing, onFailure, siblingUrl, startWorker } from './start-worker.ts';

export type { RunnerStream } from './runner/protocol.ts';
// values are the console call's arguments, each copied to the page or, when it can't be, its text
export type RunnerOutput = { stream: RunnerStream; text: string; values: unknown[] };
export type RunnerStatus = 'booting' | 'resetting' | 'running';
export type RunResult = { ok: true; durationMs: number } | { ok: false; durationMs: number; error: unknown };

export type RunOptions = {
  onOutput?: (output: RunnerOutput) => void;
  onStatus?: (status: RunnerStatus) => void;
};

export type RunnerOptions = {
  // A region to run against, left as it is
  region?: Region;
  // Without one, options for the region the runner boots and empties between runs
  boot?: BrowserRegionOptions;
  // Where a snippet's import of anything but pocket-region loads from
  resolve?: (specifier: string) => string;
  reset?: RunnerReset;
};

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
  let worker: Worker | undefined;
  let current: RunOptions | undefined;
  const runs = pendingCalls<void>();
  // One snippet at a time: they share the region
  let queue: Promise<unknown> = Promise.resolve();

  async function regionFor(onStatus: (status: RunnerStatus) => void) {
    if (options.region) return options.region;
    if (!own) {
      onStatus('booting');
      own = createRegion(options.boot);
      own.catch(() => (own = undefined));
    } else if (options.reset !== 'never') {
      onStatus('resetting');
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
          return current?.onOutput?.({ stream: data.stream, text: data.text, values: data.values });
        case 'done':
          return runs.settle(data.id);
        case 'failed':
          return runs.settle(data.id, undefined, data.error);
      }
    };
    return (worker = started);
  }

  async function attach(target: Worker, onStatus: (status: RunnerStatus) => void) {
    try {
      const port = portFor(await regionFor(onStatus));
      target.postMessage({ type: 'region', port } satisfies ToRunnerWorker, [port]);
    } catch (error) {
      target.postMessage({ type: 'region', error: toWire(error) } satisfies ToRunnerWorker);
    }
    onStatus('running');
  }

  async function execute(code: string, runOptions: RunOptions) {
    const { onStatus = () => {} } = runOptions;
    const target = workerFor();
    current = runOptions;

    // Posted first, so the snippet's imports load while the region boots
    const finished = runs.start((id) => target.postMessage({ type: 'run', id, code } satisfies ToRunnerWorker));
    // A run that fails first still waits for the region, so the next run's port isn't taken by this one
    const [outcome] = await Promise.allSettled([finished, attach(target, onStatus)]);
    if (outcome.status === 'rejected') throw outcome.reason;
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
