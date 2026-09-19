import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPyodide } from 'pyodide';
import {
  bootRegion,
  lockedLoad,
  type Region,
  type RegionSettings,
  type StateStore,
  type VendorManifest,
} from './core.ts';
import { createProcessHost } from './lambda/process-host.ts';

export * from './public.ts';

export type NodeRegionOptions = RegionSettings & {
  // Only for hosts where Pyodide cannot locate itself from import.meta.url
  indexURL?: string;
  assetsDir?: string;
};

const LOCK_FILE = '.lock';

const isLockFile = (dir: string, entry: fs.Dirent) =>
  (entry.name === LOCK_FILE || entry.name.startsWith(`${LOCK_FILE}-`)) &&
  path.relative(dir, entry.parentPath) === '';

const filesUnder = (dir: string) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !isLockFile(dir, entry))
    .map((entry) => path.join(entry.parentPath, entry.name));

type LockOwner = { pid: number; hostname: string };

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

// Written whole, then linked into place: a link fails atomically on EEXIST
function lockDirectory(dir: string): () => void {
  const lock = path.join(dir, LOCK_FILE);
  const owner: LockOwner = { pid: process.pid, hostname: os.hostname() };
  const pending = `${lock}-${randomUUID()}`;
  fs.writeFileSync(pending, JSON.stringify(owner));
  try {
    if (!linked(pending, lock)) {
      const held = ownerOf(lock);
      if (held !== undefined && (held.hostname !== owner.hostname || isAlive(held.pid))) {
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

// The pyodide package, which a Python function's environment boots its own interpreter from
const pyodideDirectory = () => path.dirname(createRequire(import.meta.url).resolve('pyodide/package.json'));

// Where the wheels a Python environment preinstalls are kept once fetched, across processes
const cacheDirectory = () => path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'pocket-region');

export function createRegion(options: NodeRegionOptions = {}): Promise<Region> {
  const assetsDir = options.assetsDir ?? fileURLToPath(new URL('../vendor', import.meta.url));
  const manifest: VendorManifest = JSON.parse(fs.readFileSync(path.join(assetsDir, 'meta.json'), 'utf8'));

  return bootRegion(
    {
      loadPyodide,
      indexURL: options.indexURL,
      packageCacheDir: assetsDir,
      stdLib: path.join(assetsDir, manifest.stdlib),
      wheels: manifest.wheels.map((file) => path.join(assetsDir, file)),
    },
    options,
    (region) =>
      createProcessHost({
        ...region,
        python: { indexURL: options.indexURL ?? pyodideDirectory(), wheels: manifest.pythonRuntime, cacheDir: cacheDirectory() },
      }),
  );
}
