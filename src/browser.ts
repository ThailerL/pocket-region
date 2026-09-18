import { lockedLoad, type Region, type RegionSettings, type StateStore } from './core.ts';
import type { Resolve } from './import-map.ts';
import { bootRegion } from './region/boot.ts';

export type {
  Dispatch,
  Dispatcher,
  LambdaEnvironment,
  LambdaEvent,
  LambdaObserver,
  LambdaOutput,
  OutputStream,
  Region,
  RegionOutput,
  RegionRequest,
  RegionResponse,
  RegionSettings,
  StateFiles,
  StateStore,
} from './core.ts';
export * from './cli/index.ts';
export { clientConfig } from './client-config.ts';
export * from './request-handler.ts';
export * from './runner.ts';

export type BrowserRegionOptions = RegionSettings & {
  // Where the vendored tree is served from; by default the import map's pocket-region/vendor/, else jsDelivr
  assetsBaseUrl?: string;
  // Pyodide's own runtime; by default jsDelivr at the version the tree was built against
  indexURL?: string;
  // Where a handler's bare imports load from, and a runner's snippets; by default the import map, else jsDelivr
  resolve?: Resolve;
};

const OBJECT_STORE = 'files';

function settle<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openStateDb(name: string) {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(OBJECT_STORE);
  return settle(request);
}

// Freed by the returned release, or when the tab closes
function lockDatabase(name: string) {
  return new Promise<() => Promise<void>>((resolve, reject) => {
    const held = navigator.locks.request(`pocket-region:${name}`, { ifAvailable: true }, (lock) => {
      if (lock === null) {
        reject(new Error(`IndexedDB database ${name} is in use by another region`));
        return;
      }
      return new Promise<void>((release) =>
        resolve(async () => {
          release();
          // Firefox frees the lock a task after its callback's promise settles; this settles after
          await held;
        }),
      );
    });
    held.catch(reject);
  });
}

async function readStateDb(name: string) {
  const db = await openStateDb(name);
  try {
    const store = db.transaction(OBJECT_STORE).objectStore(OBJECT_STORE);
    const [keys, contents] = await Promise.all([settle(store.getAllKeys()), settle(store.getAll())]);
    return new Map(keys.map((key, index) => [String(key), contents[index]]));
  } finally {
    db.close();
  }
}

export function indexedDbStore(name: string): StateStore {
  return {
    ...lockedLoad(
      () => lockDatabase(name),
      () => readStateDb(name),
    ),
    // One transaction: a tab closed partway through keeps the previous save whole
    async replace(files) {
      const db = await openStateDb(name);
      try {
        const transaction = db.transaction(OBJECT_STORE, 'readwrite');
        const store = transaction.objectStore(OBJECT_STORE);
        store.clear();
        for (const [key, contents] of files) store.put(contents, key);
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = transaction.onabort = () => reject(transaction.error);
        });
      } finally {
        db.close();
      }
    },
  };
}

export async function createRegion(options: BrowserRegionOptions = {}): Promise<Region> {
  return bootRegion(options).region;
}
