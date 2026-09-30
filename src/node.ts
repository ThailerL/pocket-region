import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageChannel, Worker } from 'node:worker_threads';
import { lockedLoad, requireJspi, type Region, type RegionSettings, type StateStore } from './core.ts';
import type { NodeAssets } from './region/node-host.ts';
import type { FromRegionWorker } from './region/protocol.ts';
import { regionOver, type RegionPort } from './region/proxy.ts';
import { siblingUrl } from './start-worker.ts';

export * from './public.ts';

export type NodeRegionOptions = RegionSettings & NodeAssets;

const LOCK_FILE = '.lock';

const isLockFile = (dir: string, entry: fs.Dirent) =>
  (entry.name === LOCK_FILE || entry.name.startsWith(`${LOCK_FILE}-`)) &&
  path.relative(dir, entry.parentPath) === '';

const filesUnder = (dir: string) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !isLockFile(dir, entry))
    .map((entry) => path.join(entry.parentPath, entry.name));

// The token tells this process from an earlier one that was given the same pid
type LockOwner = { pid: number; hostname: string; token: string };

const PROCESS_TOKEN = randomUUID();

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
};

const linked = (from: string, to: string) => {
  try {
    fs.linkSync(from, to);
    return true;
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    return false;
  }
};

const ownerOf = (lock: string): LockOwner | undefined => {
  try {
    return JSON.parse(fs.readFileSync(lock, 'utf8'));
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
};

const isLive = (held: LockOwner, owner: LockOwner) =>
  held.hostname !== owner.hostname ||
  held.token === owner.token ||
  (held.pid !== owner.pid && isAlive(held.pid));

// Written whole, then linked into place: a link fails atomically on EEXIST
function lockDirectory(dir: string): () => void {
  const lock = path.join(dir, LOCK_FILE);
  const owner: LockOwner = { pid: process.pid, hostname: os.hostname(), token: PROCESS_TOKEN };
  const pending = `${lock}-${randomUUID()}`;
  fs.writeFileSync(pending, JSON.stringify(owner));
  try {
    if (!linked(pending, lock)) {
      const held = ownerOf(lock);
      if (held !== undefined && isLive(held, owner)) {
        throw new Error(`${dir} is in use by another region (process ${held.pid} on ${held.hostname})`);
      }
      fs.rmSync(lock, { force: true });
      if (!linked(pending, lock)) throw new Error(`${dir} is in use by another region`);
    }
    return () => fs.rmSync(lock, { force: true });
  } finally {
    fs.rmSync(pending, { force: true });
  }
}

// Keys use / on every platform, so a saved directory reads back wherever it is copied
const keyOf = (dir: string, file: string) => path.relative(dir, file).split(path.sep).join('/');

export function directoryStore(dir: string): StateStore {
  return {
    ...lockedLoad(
      async () => {
        fs.mkdirSync(dir, { recursive: true });
        return lockDirectory(dir);
      },
      async () => new Map(filesUnder(dir).map((file) => [keyOf(dir, file), fs.readFileSync(file)])),
    ),
    async replace(files) {
      for (const [key, contents] of files) {
        const file = path.join(dir, ...key.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
      }
      for (const file of filesUnder(dir)) {
        if (!files.has(keyOf(dir, file))) fs.rmSync(file);
      }
    },
  };
}

// A worker inherits Node's flags, and Node refuses --input-type for one started from a file
const workerFlags = () => process.execArgv.filter((flag, index, flags) => !flag.startsWith('--input-type') && flags[index - 1] !== '--input-type');

// The region runs in a worker thread, so Python never holds this thread's event loop
export async function createRegion({ indexURL, assetsDir, ...settings }: NodeRegionOptions = {}): Promise<Region> {
  requireJspi();
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL(siblingUrl('region/node-worker')), {
    name: 'pocket-region',
    execArgv: workerFlags(),
    workerData: { port: port2 },
    transferList: [port2],
  });
  let terminated = false;
  const port: RegionPort<NodeAssets> = {
    // Only a page's runner connects, the one message this side transfers anything with
    postMessage: (message) => port1.postMessage(message),
    set onmessage(handler: ((event: MessageEvent<FromRegionWorker>) => void) | null) {
      // Node delivers MessageEvents, which its typings call Events
      port1.addEventListener('message', (event) => handler?.(event as MessageEvent<FromRegionWorker>));
      // Liveness is the worker's, held by keepAlive
      port1.unref();
    },
    terminate() {
      terminated = true;
      void worker.terminate();
    },
  };
  return regionOver(port, settings, {
    assets: Promise.resolve({ indexURL, assetsDir }),
    watch(fail) {
      worker.on('error', (error) => fail(new Error(`the region's worker failed: ${error.message}`, { cause: error })));
      worker.on('exit', (code) => terminated || fail(new Error(`the region's worker exited with code ${code}`)));
    },
    keepAlive: (alive) => (alive ? worker.ref() : worker.unref()),
  });
}
