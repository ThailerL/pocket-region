import type { Region, RegionResponse, RegionSettings, StateFiles } from '../core.ts';
import type { Resolve } from '../import-map.ts';
import { onFailure } from '../start-worker.ts';
import {
  answer,
  fromWire,
  pendingCalls,
  type BootAssets,
  type Endpoint,
  type FromRegionWorker,
  type RegionCall,
  type StoreCall,
  type ToRegionWorker,
} from './protocol.ts';

export type RegionPort = Endpoint<ToRegionWorker, FromRegionWorker> & {
  // A Worker has both; a MessagePort has neither
  onerror?: ((event: ErrorEvent) => void) | null;
  terminate?(): void;
};

// What the side that boots a region's worker gives it, and a runner of snippets against it shares
export type RegionBoot = { assets: Promise<BootAssets>; resolve: Resolve };

type Link = { connect: () => MessagePort } & RegionBoot;

const links = new WeakMap<Region, Link>();

function linkOf(region: Region) {
  const link = links.get(region);
  if (!link) throw new Error('the runner needs a region from createRegion');
  return link;
}

// A port to the region's worker for another worker, such as a snippet's
export const portFor = (region: Region) => linkOf(region).connect();

export const bootOf = (region: Region): RegionBoot => linkOf(region);

// Given a boot, this side boots the far side; otherwise that side reports booted by itself
export function regionOver(port: RegionPort, settings: RegionSettings, boot?: RegionBoot): Promise<Region> {
  const { store, onOutput, lambda } = settings;
  const calls = pendingCalls<RegionResponse>();
  let dead: Error | undefined;

  const call = (message: RegionCall) =>
    dead ? Promise.reject(dead) : calls.start((id) => port.postMessage({ type: 'call', id, ...message }));
  const voidCall = (method: 'reset' | 'save') => () => call({ method }).then(() => {});

  const serveStore = (id: number, message: StoreCall) =>
    answer(
      async (): Promise<StateFiles | undefined> => {
        if (message.method === 'load') return store!.load();
        if (message.method === 'replace') await store!.replace(message.files);
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
    boot?.assets.then(
      (ready) =>
        port.postMessage({
          type: 'boot',
          assets: ready,
          config: { port: settings.port, enforceIam: settings.enforceIam },
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
            dispatch: (request) => call({ method: 'dispatch', request }),
            reset: voidCall('reset'),
            save: voidCall('save'),
            async stop() {
              try {
                await call({ method: 'stop' });
              } finally {
                port.terminate?.();
              }
            },
          };
          // Only a region booted here is one a runner is handed
          if (boot) {
            links.set(region, {
              connect() {
                const { port1, port2 } = new MessageChannel();
                port.postMessage({ type: 'connect', port: port1 }, [port1]);
                return port2;
              },
              ...boot,
            });
          }
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
          serveStore(data.id, data);
          return;
        // Only the worker this side booted asks
        case 'resolve':
          answer(
            async () => Object.fromEntries(data.specifiers.map((specifier) => [specifier, boot!.resolve(specifier)])),
            (urls, error) => port.postMessage({ type: 'resolved', id: data.id, urls, error }),
          );
          return;
      }
    };
  });
}
