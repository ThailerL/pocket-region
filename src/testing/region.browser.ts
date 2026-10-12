import { vi } from 'vitest';
import { createRegion, type BrowserRegionOptions } from '../browser.ts';
import type { VendorManifest } from '../core.ts';

// Paths on Vite's server over the repo root; new URL(…, import.meta.url) would be rewritten
export const assetsBaseUrl = '/vendor';
export const indexURL = '/node_modules/pyodide/';

export const createTestRegion = (settings: BrowserRegionOptions = {}) => createRegion({ ...settings, assetsBaseUrl, indexURL });

// Where vitest.config.ts answers 503 to the first request and serves path after that
export const failingOnce = (path: string) => new URL(`/fails-once/${crypto.randomUUID()}${path}`, location.href).href;

export const vendorManifest = async (): Promise<VendorManifest> => (await fetch(`${assetsBaseUrl}/meta.json`)).json();

// The next region booted is told one Python wheel is at a URL that fails once. Answers its file name
export async function failWheelOnce() {
  const manifest = await vendorManifest();
  const wheel = manifest.pythonRuntime.find(({ file }) => manifest.wheels.includes(file))!;
  wheel.url = failingOnce(`${assetsBaseUrl}/${wheel.file}`);
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(manifest));
  return wheel.file;
}

// Nothing listens in a page, so the default port collides with nothing
export const regionPort = async (): Promise<number | undefined> => undefined;
