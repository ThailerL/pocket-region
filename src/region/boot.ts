import type { BrowserRegionOptions } from '../browser.ts';
import { requireJspi, type Region, type VendorManifest } from '../core.ts';
import { defaultAssetsBaseUrl, pyodideIndexUrl, regionResolve } from '../import-map.ts';
import { importing, siblingUrl, startWorker } from '../start-worker.ts';
import type { BootAssets } from './protocol.ts';
import { regionOver, type RegionBoot } from './proxy.ts';

export type RegionBooting = { region: Promise<Region> } & RegionBoot;

// The region runs in a worker; the assets are located here, since a worker has no import map
export function bootRegion(options: BrowserRegionOptions = {}): RegionBooting {
  requireJspi();
  // Loads while meta.json is fetched
  const worker = startWorker(importing(siblingUrl('region/worker')), 'pocket-region');
  const boot: RegionBoot = { assets: locateAssets(options), resolve: regionResolve(options) };
  return { region: regionOver(worker, options, boot), ...boot };
}

async function locateAssets(options: BrowserRegionOptions): Promise<BootAssets> {
  const assetsBaseUrl = options.assetsBaseUrl ?? defaultAssetsBaseUrl();
  const base = new URL(assetsBaseUrl.endsWith('/') ? assetsBaseUrl : `${assetsBaseUrl}/`, globalThis.location?.href);
  const response = await fetch(new URL('meta.json', base));
  if (!response.ok) {
    throw new Error(`no region assets at ${base.href} (meta.json answered ${response.status})`);
  }
  const manifest: VendorManifest = await response.json();
  return {
    indexURL: pyodideIndexUrl(options.indexURL, manifest.pyodideVersion),
    pyodideVersion: manifest.pyodideVersion,
    stdLib: new URL(manifest.stdlib, base).href,
    wheels: manifest.wheels.map((file) => new URL(file, base).href),
    pythonRuntime: manifest.pythonRuntime.map(({ url }) => url),
  };
}
