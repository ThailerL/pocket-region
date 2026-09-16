import type { Region, RegionRequest, RegionResponse, RegionSettings, StateFiles } from '../core.ts';
import { onFailure } from '../start-worker.ts';
import {
  answer,
  fromWire,
  pendingCalls,
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

const connectors = new WeakMap<Region, () => MessagePort>();

// A port to the region's worker for another worker, such as a snippet's
export function portFor(region: Region) {
  const connect = connectors.get(region);
  if (!connect) throw new Error('the runner needs a region from createRegion');
  return connect();
}

// Given assets, this side boots the far side; otherwise that side reports booted by itself
export function regionOver(port: RegionPort, settings: RegionSettings, assets?: Promise<BootAssets>): Promise<Region> {
  const { store, onOutput, lambda } = settings;
  const calls = pendingCalls<RegionResponse>();
  let dead: Error | undefined;

  const call = (method: RegionMethod, request?: RegionRequest) =>
    dead ? Promise.reject(dead) : calls.start((id) => port.postMessage({ type: 'call', id, method, request }));
  const voidCall = (method: RegionMethod) => () => call(method).then(() => {});

  const serveStore = (id: number, method: StoreMethod, files?: StateFiles) =>
    answer(
      async (): Promise<StateFiles | undefined> => {
        if (method === 'load') return store!.load();
        if (method === 'replace') await store!.replace(files!);
        else await store!.close?.();
        return undefined;
      },
      (loaded, error) => port.postMessage({ type: 'stored', id, files: loaded, error }),
    );

  return new Promise((booted, failed) => {
    const die = (error: Error) => {
      dead = error;
      port.terminate?.();
      calls.fail(error);
      failed(error);
    };
    onFailure(port, "the region's worker", die);
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
        case 'booted': {
          const region: Region = {
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
          };
          connectors.set(region, () => {
            const { port1, port2 } = new MessageChannel();
            port.postMessage({ type: 'connect', port: port1 }, [port1]);
            return port2;
          });
          return booted(region);
        }
        case 'boot-failed':
          return die(fromWire(data.error));
        case 'done':
          return calls.settle(data.id, data.response);
        case 'failed':
          return calls.settle(data.id, undefined, data.error);
        case 'output':
          return onOutput?.(data.output);
        case 'lambda-output':
          return lambda?.onOutput?.(data.output);
        case 'lambda-event':
          return lambda?.onEvent?.(data.event);
        case 'store':
          serveStore(data.id, data.method, data.files);
          return;
      }
    };
  });
}
