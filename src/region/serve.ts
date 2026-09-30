// A region's worker side, whichever host started the worker
import { bootRegion, type LambdaHostFactory, type Region, type RegionAssets, type StateFiles, type StateStore } from '../core.ts';
import {
  answer,
  pendingCalls,
  toWire,
  type Endpoint,
  type FromRegionWorker,
  type ResolveAll,
  type StoreCall,
  type ToRegionWorker,
} from './protocol.ts';

// What a host boots its region with, from the assets the booting side sent
export type RegionHost<Assets> = (assets: Assets, resolveAll: ResolveAll) => { assets: RegionAssets; lambda: LambdaHostFactory };

export function serveRegion<Assets>(port: Endpoint<FromRegionWorker, ToRegionWorker<Assets>>, host: RegionHost<Assets>) {
  const stores = pendingCalls<StateFiles>();
  const askStore = (call: StoreCall) => stores.start((id) => port.postMessage({ type: 'store', id, ...call }));

  const resolutions = pendingCalls<Record<string, string>>();
  const resolveAll: ResolveAll = (specifiers) => resolutions.start((id) => port.postMessage({ type: 'resolve', id, specifiers }));

  // The booting side's store, which may hold a lock that side owns
  const bridgedStore: StateStore = {
    load: () => askStore({ method: 'load' }),
    replace: (files) => askStore({ method: 'replace', files }).then(() => {}),
    close: () => askStore({ method: 'close' }).then(() => {}),
  };

  function boot({ assets, config, hasStore, listening }: ToRegionWorker<Assets> & { type: 'boot' }): Promise<Region> {
    const hosted = host(assets, resolveAll);
    return bootRegion(
      hosted.assets,
      {
        ...config,
        store: hasStore ? bridgedStore : undefined,
        onOutput: listening.output ? (output) => port.postMessage({ type: 'output', output }) : undefined,
        lambda: {
          onOutput: listening.lambdaOutput ? (output) => port.postMessage({ type: 'lambda-output', output }) : undefined,
          onEvent: listening.lambdaEvents ? (event) => port.postMessage({ type: 'lambda-event', event }) : undefined,
        },
      },
      hosted.lambda,
    );
  }

  let region: Promise<Region> | undefined;

  // Calls are answered on the endpoint they came in on; the booting side's is the one that boots
  function serve(endpoint: Endpoint<FromRegionWorker, ToRegionWorker<Assets>>) {
    endpoint.onmessage = async ({ data }) => {
      switch (data.type) {
        case 'boot':
          region = boot(data);
          region.then(
            (booted) => port.postMessage({ type: 'booted', port: booted.port }),
            (error) => port.postMessage({ type: 'boot-failed', error: toWire(error) }),
          );
          return;
        case 'stored':
          return stores.settle(data.id, data.files, data.error);
        case 'resolved':
          return resolutions.settle(data.id, data.urls, data.error);
        case 'connect':
          serve(data.port);
          data.port.postMessage({ type: 'booted', port: (await region!).port });
          return;
        case 'call':
          answer(
            async () => {
              const booted = await region!;
              if (data.method === 'dispatch') return booted.dispatch(data.request);
              await booted[data.method]();
            },
            (response, error) =>
              endpoint.postMessage(
                error ? { type: 'failed', id: data.id, error } : { type: 'done', id: data.id, response },
                // The body is a fresh copy out of Python: safe to transfer
                response && [response.body.buffer as ArrayBuffer],
              ),
          );
          return;
      }
    };
  }

  serve(port);
}
