// Runs one snippet at a time against the runner's region, started by createRunner as a module worker
import type { Region } from '../core.ts';
import { promiseCache } from '../promise-cache.ts';
import { pendingCalls } from '../region/protocol.ts';
import { withRegion } from '../with-region.ts';
import { createConsole, format } from './console.ts';
import { rewriteImports } from './imports.ts';
import { post, serveRuns, type RunMessage } from './serve.ts';
import type { JavaScriptOutput } from './protocol.ts';
import { importSnippet, lineIn, moduleOf } from './stack.ts';
import { stripTypes } from './strip.ts';

const resolutions = pendingCalls<string>();
const modules = promiseCache<object>();
const load = (specifier: string) =>
  modules(specifier, () =>
    resolutions.start((id) => post({ type: 'resolve', id, specifier })).then((url) => import(/* @vite-ignore */ url)),
  );

// What the worker itself put on the global object; a fresh run removes what snippets added since,
// as a Python run starts its namespace over
const own = new Set(Object.getOwnPropertyNames(globalThis));
function clearGlobals() {
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (!own.has(name) && Object.getOwnPropertyDescriptor(globalThis, name)?.configurable) delete (globalThis as Record<string, unknown>)[name];
  }
}

// The SDK's browser build parses XML with the DOM, which a worker lacks
async function polyfillDom() {
  if ('DOMParser' in globalThis) return;
  const { DOMParser, Node } = (await load('@xmldom/xmldom')) as Pick<typeof globalThis, 'DOMParser' | 'Node'>;
  Object.assign(globalThis, { DOMParser, Node });
  own.add('DOMParser').add('Node');
}

// Where in the snippet it was thrown, when its stack still says
function located(error: unknown, url: string) {
  if (typeof error === 'object' && error !== null) Object.assign(error, { line: lineIn((error as Error).stack, url) });
  return error;
}

function copyable(value: unknown) {
  try {
    structuredClone(value);
    return value;
  } catch {
    return format(value);
  }
}

function send(made: JavaScriptOutput, line?: number) {
  const output = { ...made, line };
  try {
    post({ type: 'output', output });
  } catch {
    post({ type: 'output', output: { ...output, values: output.values.map(copyable) } });
  }
}

// A library that drops a rejection can leave the run hanging, so the reader at least sees why
self.addEventListener('unhandledrejection', (event) => createConsole(send).error('Uncaught (in promise)', event.reason));

const isPocketRegion = (specifier: string) => specifier.split('/')[0] === 'pocket-region';

async function run({ code, fresh }: RunMessage, attached: Promise<Region>) {
  if (fresh) clearGlobals();
  const stripped = stripTypes(code);
  if (/^[ \t]*export\s/m.test(stripped)) throw new SyntaxError('a snippet runs as a function body, so it cannot export');
  const { code: body, specifiers } = rewriteImports(stripped);
  const refused = specifiers.find(isPocketRegion);
  if (refused) throw new Error(`a snippet can't import ${refused}: it runs against the runner's region`);

  // The imports load while the region boots on the page
  const loading = new Map(specifiers.map((specifier) => [specifier, load(specifier)]));
  const [, region] = await Promise.all([polyfillDom(), attached]);

  const importer = async (specifier: string) => withRegion(await loading.get(specifier)!, region);
  const url = URL.createObjectURL(new Blob([moduleOf(body)], { type: 'text/javascript' }));
  const console = createConsole((made) => send(made, lineIn(new Error().stack, url)));
  try {
    const snippet = await importSnippet(url);
    await snippet(importer, console);
  } catch (error) {
    throw located(error, url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

serveRuns(run, (data) => {
  if (data.type === 'resolved') resolutions.settle(data.id, data.url, data.error);
});
