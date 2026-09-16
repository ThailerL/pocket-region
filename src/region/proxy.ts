import type { Region, RegionRequest, RegionResponse, RegionSettings, StateFiles } from '../core.ts';
import {
  pendingCalls,
  fromWire,
  toWire,
  type BootAssets,
  type Endpoint,
  type FromRegionWorker,
  type RegionMethod,
  type StoreMethod,
  type ToRegionWorker,
} from './protocol.ts';

export type RegionPort = Endpoint<ToRegionWorker, FromRegionWorker> & {
  // A Worker has both; a MessagePort has neither
  onerror?: ((event: ErrorEvent) => void) | null;
  terminate?(): void;
};

// Given assets, this side boots the far side; otherwise that side reports booted by itself
export function regionOver(port: RegionPort, settings: RegionSettings, assets?: Promise<BootAssets>): Promise<Region> {
  const { store, onOutput, lambda } = settings;
  const calls = pendingCalls<RegionResponse>();
  let dead: Error | undefined;

  const call = (method: RegionMethod, request?: RegionRequest) =>
    dead ? Promise.reject(dead) : calls.start((id) => port.postMessage({ type: 'call', id, method, request }));
  const voidCall = (method: RegionMethod) => () => call(method).then(() => {});

  async function serveStore(id: number, method: StoreMethod, files?: StateFiles) {
    try {
      let loaded: StateFiles | undefined;
      if (method === 'load') loaded = await store!.load();
      else if (method === 'replace') await store!.replace(files!);
      else await store!.close?.();
      port.postMessage({ type: 'stored', id, files: loaded });
    } catch (error) {
      port.postMessage({ type: 'stored', id, error: toWire(error) });
    }
  }

  return new Promise((booted, failed) => {
    const die = (error: Error) => {
      dead = error;
      port.terminate?.();
      calls.fail(error);
      failed(error);
    };
    // A module that fails to load never answers
    port.onerror = (event) => {
      event.preventDefault();
      die(new Error(`the region's worker failed: ${event.message}`));
    };
    assets?.then(
      (ready) =>
        port.postMessage({
          type: 'boot',
          assets: ready,
          port: settings.port,
          hasStore: store !== undefined,
          listening: { output: !!onOutput, lambdaOutput: !!lambda?.onOutput, lambdaEvents: !!lambda?.onEvent },
        }),
      die,
    );

    port.onmessage = ({ data }) => {
      switch (data.type) {
        case 'booted':
          return booted({
            port: data.port,
            dispatch: (request) => call('dispatch', request) as Promise<RegionResponse>,
            reset: voidCall('reset'),
            save: voidCall('save'),
            async stop() {
              try {
                await call('stop');
              } finally {
                port.terminate?.();
              }
            },
          });
        case 'boot-failed':
          return die(fromWire(data.error));
        case 'done':
          return calls.settle(data.id, data.response);
        case 'failed':
          return calls.settle(data.id, undefined, data.error);
        case 'output':
          return onOutput?.(data.line, data.stream);
        case 'lambda-output':
          return lambda?.onOutput?.(data.line, data.source);
        case 'lambda-event':
          return lambda?.onEvent?.(data.event);
        case 'store':
          serveStore(data.id, data.method, data.files);
          return;
      }
    };
  });
}
