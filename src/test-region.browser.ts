import { createRegion, type BrowserRegionOptions } from './browser.ts';

// Paths on Vite's server over the repo root; new URL(…, import.meta.url) would be rewritten
export const assetsBaseUrl = '/vendor';
export const indexURL = '/node_modules/pyodide/';

export const createTestRegion = (settings: BrowserRegionOptions = {}) => createRegion({ ...settings, assetsBaseUrl, indexURL });

// Nothing listens in a page, so the default port collides with nothing
export const regionPort = async (): Promise<number | undefined> => undefined;
