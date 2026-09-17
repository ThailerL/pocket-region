import { createRegion, type BrowserRegionOptions } from './browser.ts';
import { AWS_DEFAULTS, awsEnvironment } from './client-defaults.ts';
import { jspiSupported, type Region } from './core.ts';
import { fromImportMap, pyodideIndexUrl } from './import-map.ts';
import { answer, pendingCalls, toWire } from './region/protocol.ts';
import { portFor } from './region/proxy.ts';
import type { FromRunnerWorker, Language, PythonBoot, RunnerOutput, ToRunnerWorker } from './runner/protocol.ts';
import { importing, onFailure, siblingUrl, startWorker } from './start-worker.ts';
import { PYODIDE_VERSION } from './version.generated.ts';

export type { ConsoleMethod, JavaScriptOutput, Language, PythonOutput, RunnerOutput } from './runner/protocol.ts';
export type Snippet = { language: Language; code: string };
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
  // Where a snippet's import of anything but pocket-region loads from
  resolve?: (specifier: string) => string;
  // Defaults to 'each-run' for the runner's own region and 'never' for one passed in
  reset?: RunnerReset;
  // Code run on the region whenever it's empty, JavaScript unless it says which language
  setup?: string | Snippet;
  python?: {
    // What micropip installs before the first Python run, by default boto3
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

const fromCdn = (specifier: string) => fromImportMap(specifier, () => `https://cdn.jsdelivr.net/npm/${specifier}/+esm`);

const asSnippet = (code: string | Snippet): Snippet => (typeof code === 'string' ? { language: 'javascript', code } : code);

export function createRunner(options: RunnerOptions = {}): Runner {
  const resolve = options.resolve ?? fromCdn;
  const reset = options.reset ?? (options.region ? 'never' : 'each-run');
  let own: Promise<Region> | undefined;
  // Whether the region was set up in full since it was last booted, passed in, or emptied
  let prepared = false;
  // A setup that failed partway leaves the region to be emptied before it runs again
  let spoiled = false;
  const workers = new Map<Language, Worker>();
  let active: Language | undefined;
  let pythonBoot: PythonBoot | undefined;
  let current: RunOptions | undefined;
  const runs = pendingCalls<void>();
  // One snippet at a time: they share the region
  let queue: Promise<unknown> = Promise.resolve();

  // Fresh when just booted, first passed in, or emptied, and so due for setup
  function regionFor(onStatus: (status: RunnerStatus) => void, wanted: RunnerReset): { region: Promise<Region>; fresh: boolean } {
    if (!options.region && !own) {
      onStatus({ phase: 'booting' });
      own = createRegion(options.boot);
      own.catch(() => (own = undefined));
      prepared = spoiled = false;
      return { region: own, fresh: true };
    }
    const held = options.region ? Promise.resolve(options.region) : own!;
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

  // Pyodide for a snippet comes from where the region's does, or the CDN; micropip lives only on Pyodide's own CDN
  const bootPython = (worker: Worker) => {
    pythonBoot ??= {
      indexURL: pyodideIndexUrl(options.boot?.indexURL, PYODIDE_VERSION),
      packageBaseUrl: `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`,
      packages: options.python?.packages ?? ['boto3'],
      environment: awsEnvironment(AWS_DEFAULTS),
    };
    worker.postMessage({ type: 'boot', python: pythonBoot } satisfies ToRunnerWorker);
  };

  function workerFor(language: Language) {
    const running = workers.get(language);
    if (running) return running;
    const started = startWorker(importing(siblingUrl(`runner/${language}-worker`)), `pocket-region-${language}-runner`);
    onFailure(started, "the runner's worker", (error) => abort(error, language));
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
    const setup = fresh && options.setup !== undefined ? post(asSnippet(options.setup), true) : undefined;
    const snippet = post(code, fresh, runOptions.echo);

    if (setup) {
      const held: RunnerOutput[] = [];
      current = { onOutput: (output) => held.push(output) };
      try {
        await complete(setup, region, 'setting-up', onStatus);
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
      await (await booted?.catch(() => undefined))?.stop();
    },
  };
}
