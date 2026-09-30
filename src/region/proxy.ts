import type { Region, RegionResponse, RegionSettings, StateFiles } from '../core.ts';
import type { Resolve } from '../import-map.ts';
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

export type RegionPort<Assets> = Endpoint<ToRegionWorker<Assets>, FromRegionWorker> & {
  // A Worker has it; a MessagePort does not
  terminate?(): void;
};

// resolve is a page's, for its handlers' imports; keepAlive a Node worker's, held while booting or answering a call
export type WorkerBoot<Assets> = {
  assets: Promise<Assets>;
  watch(fail: (error: Error) => void): void;
  resolve?: Resolve;
  keepAlive?(alive: boolean): void;
};

// What a page's region shares with a runner of snippets against it
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

// Only a region a page booted is one a runner is handed
export function linkRegion(region: Region, port: RegionPort<BootAssets>, boot: RegionBoot) {
  links.set(region, {
    connect() {
      const { port1, port2 } = new MessageChannel();
      port.postMessage({ type: 'connect', port: port1 }, [port1]);
      return port2;
    },
    ...boot,
  });
  return region;
}

// Given a boot, this side boots the far side; otherwise that side reports booted by itself
export function regionOver<Assets>(port: RegionPort<Assets>, settings: RegionSettings, boot?: WorkerBoot<Assets>): Promise<Region> {
  const { store, onOutput, lambda } = settings;
  const calls = pendingCalls<RegionResponse>();
  let dead: Error | undefined;
  // The boot and every call in flight
  let holds = 0;
  const hold = (by: 1 | -1) => boot?.keepAlive?.((holds += by) > 0);

  const call = async (message: RegionCall) => {
    if (dead) throw dead;
    hold(1);
    try {
      return await calls.start((id) => port.postMessage({ type: 'call', id, ...message }));
    } finally {
      hold(-1);
    }
  };
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
    hold(1);
    const die = (error: Error) => {
      dead = error;
      port.terminate?.();
      calls.fail(error);
      failed(error);
    };
    boot?.watch(die);
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
          hold(-1);
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
        // Only a page's worker asks
        case 'resolve':
          answer(
            async () => {
              const resolve = boot?.resolve;
              if (!resolve) throw new Error('this region resolves no imports');
              return Object.fromEntries(data.specifiers.map((specifier) => [specifier, resolve(specifier)]));
            },
            (urls, error) => port.postMessage({ type: 'resolved', id: data.id, urls, error }),
          );
          return;
      }
    };
  });
}
