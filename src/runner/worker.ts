// Runs one snippet at a time against the runner's region, started by createRunner as a module worker
import { fromWire, pendingCalls, toWire, workerEndpoint } from '../region/protocol.ts';
import { regionOver } from '../region/proxy.ts';
import { withRegion } from '../with-region.ts';
import { createConsole, format } from './console.ts';
import { AsyncFunction, IMPORT, rewriteImports } from './imports.ts';
import type { FromRunnerWorker, ToRunnerWorker } from './protocol.ts';
import { stripTypes } from './strip.ts';

const port = workerEndpoint<FromRunnerWorker, ToRunnerWorker>();
const post = (message: FromRunnerWorker) => port.postMessage(message);

const resolutions = pendingCalls<string>();
const modules = new Map<string, Promise<object>>();
const load = (specifier: string) => {
  let loading = modules.get(specifier);
  if (!loading) {
    loading = (resolutions.start((id) => post({ type: 'resolve', id, specifier })) as Promise<string>).then(
      (url) => import(/* @vite-ignore */ url),
    );
    modules.set(specifier, loading);
    // A failure is not the answer for the rest of the session
    loading.catch(() => modules.delete(specifier));
  }
  return loading;
};

// The SDK's browser build parses XML with the DOM, which a worker lacks
async function polyfillDom() {
  if ('DOMParser' in globalThis) return;
  const { DOMParser, Node } = (await load('@xmldom/xmldom')) as Pick<typeof globalThis, 'DOMParser' | 'Node'>;
  Object.assign(globalThis, { DOMParser, Node });
}

function copyable(value: unknown) {
  try {
    structuredClone(value);
    return value;
  } catch {
    return format(value);
  }
}

const console = createConsole((output) => {
  try {
    post({ type: 'output', output });
  } catch {
    post({ type: 'output', output: { ...output, values: output.values.map(copyable) } });
  }
});

// A library that drops a rejection can leave the run hanging, so the reader at least sees why
self.addEventListener('unhandledrejection', (event) => console.error('Uncaught (in promise)', event.reason));

const isPocketRegion = (specifier: string) => specifier.split('/')[0] === 'pocket-region';

async function run(code: string, regionPort: Promise<MessagePort>) {
  const { code: body, specifiers } = rewriteImports(stripTypes(code));
  const refused = specifiers.find(isPocketRegion);
  if (refused) throw new Error(`a snippet can't import ${refused}: it runs against the runner's region`);

  // The imports load while the region boots on the page
  const loading = new Map(specifiers.map((specifier) => [specifier, load(specifier)]));
  let attached: MessagePort | undefined;
  const [, region] = await Promise.all([polyfillDom(), regionPort.then((port) => regionOver((attached = port), {}))]);

  const importer = async (specifier: string) => withRegion(await loading.get(specifier)!, region);
  try {
    await new AsyncFunction(IMPORT, 'console', body)(importer, console);
  } finally {
    attached?.close();
  }
}

let deliverRegion: { resolve: (port: MessagePort) => void; reject: (error: Error) => void } | undefined;

port.onmessage = async ({ data }) => {
  switch (data.type) {
    case 'resolved':
      return resolutions.settle(data.id, data.url, data.error);
    case 'region':
      return data.port ? deliverRegion?.resolve(data.port) : deliverRegion?.reject(fromWire(data.error!));
    case 'run': {
      const regionPort = new Promise<MessagePort>((resolve, reject) => (deliverRegion = { resolve, reject }));
      try {
        await run(data.code, regionPort);
        post({ type: 'done', id: data.id });
      } catch (error) {
        post({ type: 'failed', id: data.id, error: toWire(error) });
      }
      return;
    }
  }
};
