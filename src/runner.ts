import * as entry from './browser.ts';
import type { BrowserRegionOptions } from './browser.ts';
import { jspiSupported, type Region } from './core.ts';
import { AsyncFunction, IMPORT, rewriteImports } from './runner/imports.ts';
import { withRegion } from './with-region.ts';

export type RunnerStream = 'log' | 'error';
export type RunnerOutput = { stream: RunnerStream; text: string };
export type RunnerStatus = 'booting' | 'resetting' | 'running';
export type RunResult = { ok: true; durationMs: number } | { ok: false; durationMs: number; error: unknown };

export type RunOptions = {
  onOutput?: (output: RunnerOutput) => void;
  onStatus?: (status: RunnerStatus) => void;
};

export type RunnerOptions = {
  // The runner's own region, for snippets that don't create one
  region?: BrowserRegionOptions;
  // What a snippet's import of anything but pocket-region resolves to
  load?: (specifier: string) => Promise<object>;
  reset?: RunnerReset;
};

// 'never' keeps what earlier runs made, for examples that build on each other
export type RunnerReset = 'each-run' | 'never';

export type Runner = {
  readonly supported: boolean;
  run(code: string, options?: RunOptions): Promise<RunResult>;
  stop(): Promise<void>;
};

const fromJsDelivr = (specifier: string): Promise<object> =>
  import(/* @vite-ignore */ `https://cdn.jsdelivr.net/npm/${specifier}/+esm`);

function format(value: unknown) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

const isPocketRegion = (specifier: string) => specifier.split('/')[0] === 'pocket-region';

export function createRunner(options: RunnerOptions = {}): Runner {
  const load = options.load ?? fromJsDelivr;
  let region: Promise<Region> | undefined;
  // One snippet at a time: they share the region
  let queue: Promise<unknown> = Promise.resolve();

  async function regionFor(onStatus: (status: RunnerStatus) => void) {
    if (!region) {
      onStatus('booting');
      region = entry.createRegion(options.region);
      region.catch(() => (region = undefined));
    } else if (options.reset !== 'never') {
      onStatus('resetting');
      await (await region).reset();
    }
    return region;
  }

  async function execute(code: string, { onOutput, onStatus = () => {} }: RunOptions) {
    const { code: body, specifiers } = rewriteImports(code);
    const refused = specifiers.find((specifier) => isPocketRegion(specifier) && specifier !== 'pocket-region/browser');
    if (refused) throw new Error(`${refused} can't run in a page: import pocket-region/browser`);

    // Fetched alongside a first boot rather than after it; a failure surfaces at the import
    const loading = new Map(specifiers.filter((specifier) => !isPocketRegion(specifier)).map((specifier) => [specifier, load(specifier)]));
    for (const pending of loading.values()) pending.catch(() => {});
    const shared = specifiers.some(isPocketRegion) ? undefined : await regionFor(onStatus);

    const importer = async (specifier: string) => {
      if (specifier === 'pocket-region/browser') return entry;
      const module = await loading.get(specifier)!;
      return shared ? withRegion(module, shared) : module;
    };
    const write = (stream: RunnerStream) => (...args: unknown[]) =>
      onOutput?.({ stream, text: args.map(format).join(' ') });
    const console = { log: write('log'), info: write('log'), debug: write('log'), warn: write('error'), error: write('error') };

    onStatus('running');
    await new AsyncFunction(IMPORT, 'console', body)(importer, console);
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
    async stop() {
      await queue;
      const booted = region;
      region = undefined;
      await (await booted?.catch(() => undefined))?.stop();
    },
  };
}
