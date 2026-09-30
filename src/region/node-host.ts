import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPyodide } from 'pyodide';
import { emulatorVersion, type VendorManifest } from '../core.ts';
import { createProcessHost } from '../lambda/process-host.ts';
import type { RegionHost } from './serve.ts';

export type NodeAssets = {
  // Only for hosts where Pyodide cannot locate itself from import.meta.url
  indexURL?: string;
  assetsDir?: string;
};

// The pyodide package, which a Python function's environment boots its own interpreter from
const pyodideDirectory = () => path.dirname(createRequire(import.meta.url).resolve('pyodide/package.json'));

// Where the wheels a Python environment preinstalls are kept once fetched, across processes
const cacheDirectory = () => path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'pocket-region');

export const nodeHost: RegionHost<NodeAssets> = ({ indexURL, assetsDir = fileURLToPath(new URL('../../vendor', import.meta.url)) }) => {
  const manifest: VendorManifest = JSON.parse(fs.readFileSync(path.join(assetsDir, 'meta.json'), 'utf8'));
  return {
    assets: {
      loadPyodide,
      indexURL,
      packageCacheDir: assetsDir,
      stdLib: path.join(assetsDir, manifest.stdlib),
      wheels: manifest.wheels.map((file) => path.join(assetsDir, file)),
      emulatorVersion: emulatorVersion(manifest),
    },
    lambda: (region) =>
      createProcessHost({
        ...region,
        python: { indexURL: indexURL ?? pyodideDirectory(), wheels: manifest.pythonRuntime, cacheDir: cacheDirectory() },
      }),
  };
};
