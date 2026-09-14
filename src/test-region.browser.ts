import { createRegion } from './browser.ts';

// Paths on Vite's server over the repo root; new URL(…, import.meta.url) would be rewritten
export const assetsBaseUrl = '/vendor';

export const createTestRegion = () => createRegion({ assetsBaseUrl, indexURL: '/node_modules/pyodide/' });
