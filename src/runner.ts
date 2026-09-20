import type { BrowserRegionOptions } from './browser.ts';
import { AWS_DEFAULTS, awsEnvironment } from './client-config.ts';
import { jspiSupported, type Region } from './core.ts';
import { bootRegion, type RegionBooting } from './region/boot.ts';
import { answer, pendingCalls, toWire } from './region/protocol.ts';
import { bootOf, portFor, type RegionBoot } from './region/proxy.ts';
import type { FromRunnerWorker, Language, PythonBoot, RunnerOutput, ToRunnerWorker } from './runner/protocol.ts';
import { importing, onFailure, siblingUrl, startWorker } from './start-worker.ts';

export type { ConsoleMethod, JavaScriptOutput, Language, PythonOutput, RunnerOutput } from './runner/protocol.ts';
export type Snippet = { language: Language; code: string };
// Page code run on the region instead of a snippet, for a setup the reader isn't shown
export type SetupFunction = (region: Region) => Promise<void>;
export type RunnerPhase = 'booting' | 'resetting' | 'setting-up' | 'running';
export type RunnerStatus = { phase: RunnerPhase };
export type RunResult = { ok: true; durationMs: number } | { ok: false; durationMs: number; error: unknown };

export type RunOptions = {
  // Defaults to 'javascript'
  language?: Language;
  // Print each expression statement's value as an interpreter session would. Python only
  echo?: boolean;
  // For this run, in place of the runner's: 'never' continues from the previous run
  reset?: RunnerReset;
  onOutput?: (output: RunnerOutput) => void;
  onStatus?: (status: RunnerStatus) => void;
};

export type RunnerOptions = {
  // Defaults to 'each-run' for the runner's own region and 'never' for one passed in
  reset?: RunnerReset;
  // Run on the region whenever it's empty: code, JavaScript unless it says which language, or a function of the region
  setup?: string | Snippet | SetupFunction;
  python?: {
    // What micropip installs from PyPI beside the region's boto3, as requirement strings such as 'pynamodb==6.1.0'
    packages?: string[];
  };
} & (
  // A region to run against, never stopped by the runner
  | { region: Region; boot?: never }
  // Options for the region the runner boots itself
  | { region?: never; boot?: BrowserRegionOptions }
);

// 'never' keeps what earlier runs made, for examples that build on each other
export type RunnerReset = 'each-run' | 'never';

export type Runner = {
  readonly supported: boolean;
  run(code: string, options?: RunOptions): Promise<RunResult>;
  stop(): Promise<void>;
};

const asSnippet = (code: string | Snippet): Snippet => (typeof code === 'string' ? { language: 'javascript', code } : code);

export function createRunner(options: RunnerOptions = {}): Runner {
  const reset = options.reset ?? (options.region ? 'never' : 'each-run');
  let own: RegionBooting | undefined;
  // What the region booted from, which its snippets share: its handlers' imports and its Python
  const boot = (): RegionBoot => (options.region ? bootOf(options.region) : own!);
  // Whether the region was set up in full since it was last booted, passed in, or emptied
  let prepared = false;
  // A setup that failed partway leaves the region to be emptied before it runs again
  let spoiled = false;
  const workers = new Map<Language, Worker>();
  let active: Language | undefined;
  let current: RunOptions | undefined;
  const runs = pendingCalls<void>();
  // One snippet at a time: they share the region
  let queue: Promise<unknown> = Promise.resolve();

  // Fresh when just booted, first passed in, or emptied, and so due for setup
  function regionFor(onStatus: (status: RunnerStatus) => void, wanted: RunnerReset): { region: Promise<Region>; fresh: boolean } {
    if (!options.region && !own) {
      onStatus({ phase: 'booting' });
      own = bootRegion(options.boot);
      own.region.catch(() => (own = undefined));
      prepared = spoiled = false;
      return { region: own.region, fresh: true };
    }
    const held = options.region ? Promise.resolve(options.region) : own!.region;
    if (wanted === 'each-run' || spoiled) {
      onStatus({ phase: 'resetting' });
      const emptied = held.then(async (region) => {
        await region.reset();
        return region;
      });
      return { region: emptied, fresh: true };
    }
    return { region: held, fresh: !prepared };
  }

  // Ends whatever that language's worker is running, however stuck; its next run starts a fresh one
  const abort = (error: Error, language = active) => {
    workers.get(language!)?.terminate();
    workers.delete(language!);
    runs.fail(error);
  };

  // A snippet's Pyodide and boto3 are the ones the region's Python functions get
  const bootPython = (worker: Worker) =>
    Promise.resolve().then(() => boot().assets).then(
      ({ indexURL, pyodideVersion, pythonRuntime }) => {
        const packages = options.python?.packages ?? [];
        const python: PythonBoot = { indexURL, pyodideVersion, pythonRuntime, packages, environment: awsEnvironment(AWS_DEFAULTS.credentials) };
        worker.postMessage({ type: 'boot', python } satisfies ToRunnerWorker);
      },
      // A worker never booted would hold every later run
      (error) => {
        if (workers.get('python') === worker) abort(error, 'python');
      },
    );

  function workerFor(language: Language) {
    const running = workers.get(language);
    if (running) return running;
    const started = startWorker(importing(siblingUrl(`runner/${language}-worker`)), `pocket-region-${language}-runner`);
    onFailure(started, "the runner's worker", (error) => abort(error, language));
    started.onmessage = ({ data }: MessageEvent<FromRunnerWorker>) => {
      switch (data.type) {
        case 'resolve':
          answer(async () => boot().resolve(data.specifier), (url, error) => started.postMessage({ type: 'resolved', id: data.id, url, error }));
          return;
        case 'output':
          return current?.onOutput?.(data.output);
        case 'done':
          return runs.settle(data.id);
        case 'failed':
          return runs.settle(data.id, undefined, data.error);
      }
    };
    workers.set(language, started);
    if (language === 'python') bootPython(started);
    return started;
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
  function post({ language, code }: Snippet, fresh: boolean, echo?: boolean) {
    const target = workerFor((active = language));
    let id = 0;
    const finished = runs.start((started) => target.postMessage({ type: 'run', id: (id = started), code, fresh, echo } satisfies ToRunnerWorker));
    finished.catch(() => {});
    return { finished, attach: (region: Promise<Region>) => attach(target, id, region) };
  }

  async function complete(run: ReturnType<typeof post>, region: Promise<Region>, phase: RunnerPhase, onStatus: (status: RunnerStatus) => void) {
    // A run that fails first still waits for its region, so the next run never overlaps a boot or reset
    const [outcome] = await Promise.allSettled([run.finished, run.attach(region).then(() => onStatus({ phase }))]);
    if (outcome.status === 'rejected') throw outcome.reason;
  }

  async function execute(code: Snippet, runOptions: RunOptions) {
    const { onStatus = () => {} } = runOptions;
    if (runOptions.echo && code.language !== 'python') throw new Error('echo is not supported for JavaScript: it needs an expression-statement rewrite the runner lacks');
    const { region, fresh } = regionFor(onStatus, runOptions.reset ?? reset);
    const wanted = fresh ? options.setup : undefined;
    // Posted before the snippet, so it reaches the worker first
    const setup = wanted === undefined || typeof wanted === 'function' ? wanted : post(asSnippet(wanted), true);
    const snippet = post(code, fresh, runOptions.echo);

    if (setup) {
      // Only a worker's output comes back here; a setup function prints to the page's console
      const held: RunnerOutput[] = [];
      try {
        if (typeof setup === 'function') {
          const ready = await region;
          onStatus({ phase: 'setting-up' });
          await setup(ready);
        } else {
          current = { onOutput: (output) => held.push(output) };
          await complete(setup, region, 'setting-up', onStatus);
        }
      } catch (error) {
        spoiled = true;
        held.forEach((output) => runOptions.onOutput?.(output));
        const failure = new Error(`setup failed: ${(error as Error).message}`, { cause: error });
        await snippet.attach(Promise.reject(failure));
        await snippet.finished.catch(() => {});
        throw failure;
      }
    }
    if (fresh) {
      prepared = true;
      spoiled = false;
    }

    current = runOptions;
    await complete(snippet, region, 'running', onStatus);
  }

  return {
    supported: jspiSupported(),
    run(code, runOptions = {}) {
      const result = queue.then(async (): Promise<RunResult> => {
        const started = performance.now();
        try {
          await execute({ language: runOptions.language ?? 'javascript', code }, runOptions);
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
      await (await booted?.region.catch(() => undefined))?.stop();
    },
  };
}
