import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bootRegion,
  hostObserver,
  type Region,
  type RegionSettings,
  type StateStore,
  type VendorManifest,
} from './core.ts';
import { createProcessHost } from './lambda/process-host.ts';

export type {
  LambdaEvent,
  LambdaObserver,
  OutputStream,
  Region,
  RegionRequest,
  RegionResponse,
  StateFiles,
  StateStore,
} from './core.ts';

export type NodeRegionOptions = RegionSettings & {
  // Only for hosts where Pyodide cannot locate itself from import.meta.url
  indexURL?: string;
  packageCacheDir?: string;
};

const filesUnder = (dir: string) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));

// Keys use / on every platform, so a saved directory reads back wherever it is copied
const keyOf = (dir: string, file: string) => path.relative(dir, file).split(path.sep).join('/');

export function directoryStore(dir: string): StateStore {
  return {
    async load() {
      fs.mkdirSync(dir, { recursive: true });
      return new Map(filesUnder(dir).map((file) => [keyOf(dir, file), fs.readFileSync(file)]));
    },
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

export function createRegion(options: NodeRegionOptions = {}): Promise<Region> {
  const packageCacheDir =
    options.packageCacheDir ?? fileURLToPath(new URL('../vendor', import.meta.url));
  const manifest: VendorManifest = JSON.parse(
    fs.readFileSync(path.join(packageCacheDir, 'meta.json'), 'utf8'),
  );

  return bootRegion(
    {
      indexURL: options.indexURL,
      packageCacheDir,
      stdLib: path.join(packageCacheDir, manifest.stdlib),
      wheels: manifest.wheels.map((file) => path.join(packageCacheDir, file)),
    },
    options,
    (region) => createProcessHost({ ...region, lambda: hostObserver(options) }),
  );
}
