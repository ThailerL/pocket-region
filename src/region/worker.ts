// A page's region, started by createRegion as a module worker
import { bootRegion, hostObserver, type Region, type RegionSettings, type StateFiles, type StateStore } from '../core.ts';
import { createWorkerHost } from '../lambda/worker-host.ts';
import { pendingCalls, toWire, workerEndpoint, type Endpoint, type FromRegionWorker, type StoreMethod, type ToRegionWorker } from './protocol.ts';

const port = workerEndpoint<FromRegionWorker, ToRegionWorker>();
const post = (message: FromRegionWorker, transfer?: Transferable[]) => port.postMessage(message, transfer);

const stores = pendingCalls<StateFiles>();
const askStore = (method: StoreMethod, files?: StateFiles) =>
  stores.start((id) => post({ type: 'store', id, method, files }));

// The page's store, which may hold a lock the page owns
const bridgedStore: StateStore = {
  load: () => askStore('load') as Promise<StateFiles>,
  replace: (files) => askStore('replace', files).then(() => {}),
  close: () => askStore('close').then(() => {}),
};

async function boot({ type: _, assets, port: regionPort, hasStore, listening }: ToRegionWorker & { type: 'boot' }): Promise<Region> {
  // Fetched while bootRegion loads the store
  const runtime: Promise<typeof import('pyodide')> = import(/* @vite-ignore */ `${assets.indexURL}pyodide.mjs`);
  const settings: RegionSettings = {
    port: regionPort,
    store: hasStore ? bridgedStore : undefined,
    onOutput: listening.output ? (output) => post({ type: 'output', output }) : undefined,
    lambda: {
      onOutput: listening.lambdaOutput ? (output) => post({ type: 'lambda-output', output }) : undefined,
      onEvent: listening.lambdaEvents ? (event) => post({ type: 'lambda-event', event }) : undefined,
    },
  };
  return bootRegion(
    { ...assets, loadPyodide: (options) => runtime.then(({ loadPyodide }) => loadPyodide(options)) },
    settings,
    (region) => createWorkerHost({ ...region, lambda: hostObserver(settings) }),
  );
}

let region: Promise<Region> | undefined;

// Calls are answered on the endpoint they came in on; the page's is the one that boots
function serve(endpoint: Endpoint<FromRegionWorker, ToRegionWorker>) {
  endpoint.onmessage = async ({ data }) => {
    switch (data.type) {
      case 'boot':
        region = boot(data);
        region.then(
          ({ port }) => post({ type: 'booted', port }),
          (error) => post({ type: 'boot-failed', error: toWire(error) }),
        );
        return;
      case 'stored':
        return stores.settle(data.id, data.files, data.error);
      case 'connect':
        serve(data.port);
        data.port.postMessage({ type: 'booted', port: (await region!).port });
        return;
      case 'call':
        try {
          const booted = await region!;
          if (data.method === 'dispatch') {
            const response = await booted.dispatch(data.request!);
            // The body is a fresh copy out of Python: safe to transfer
            endpoint.postMessage({ type: 'done', id: data.id, response }, [response.body.buffer as ArrayBuffer]);
          } else {
            await booted[data.method]();
            endpoint.postMessage({ type: 'done', id: data.id });
          }
        } catch (error) {
          endpoint.postMessage({ type: 'failed', id: data.id, error: toWire(error) });
        }
        return;
    }
  };
}

serve(port);
