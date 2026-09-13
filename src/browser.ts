import {
  bootRegion,
  hostObserver,
  type Region,
  type RegionSettings,
  type VendorManifest,
} from './core.ts';
import { createWorkerHost } from './lambda/worker-host.ts';

export type { LambdaEvent, LambdaObserver, OutputStream, Region, RegionRequest, RegionResponse } from './core.ts';

// A page has nowhere to save to, so it is not offered: IndexedDB is its own decision
export type PageRegion = Omit<Region, 'save'>;

export type BrowserRegionOptions = RegionSettings & {
  // Where the vendored tree is served from: meta.json, the wheels and the stdlib beside it
  assetsBaseUrl: string;
  // Pyodide's own runtime; by default jsDelivr at the version the tree was built against
  indexURL?: string;
};

export async function createRegion(options: BrowserRegionOptions): Promise<PageRegion> {
  const base = new URL(
    options.assetsBaseUrl.endsWith('/') ? options.assetsBaseUrl : `${options.assetsBaseUrl}/`,
    globalThis.location?.href,
  );
  const response = await fetch(new URL('meta.json', base));
  if (!response.ok) {
    throw new Error(`no region assets at ${base.href} (meta.json answered ${response.status})`);
  }
  const manifest: VendorManifest = await response.json();

  return bootRegion(
    {
      indexURL:
        options.indexURL ?? `https://cdn.jsdelivr.net/npm/pyodide@${manifest.pyodideVersion}/`,
      stdLib: new URL(manifest.stdlib, base).href,
      wheels: manifest.wheels.map((file) => new URL(file, base).href),
    },
    options,
    undefined,
    (region) => createWorkerHost({ ...region, lambda: hostObserver(options) }),
  );
}
