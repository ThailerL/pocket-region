import { PACKAGE_VERSION } from './version.generated.ts';

// import.meta.resolve throws when the page's import map doesn't map the specifier
export function fromImportMap(specifier: string, fallback: () => string) {
  try {
    return import.meta.resolve(specifier);
  } catch {
    return fallback();
  }
}

// The URL an import of a bare specifier loads from
export type Resolve = (specifier: string) => string;

// A bare specifier from the page's import map, or jsDelivr's ESM build of the package
export const fromCdn: Resolve = (specifier) => fromImportMap(specifier, () => `https://cdn.jsdelivr.net/npm/${specifier}/+esm`);

// A page region's resolve option, or the default, for its handlers and a runner's snippets alike
export const regionResolve = (options?: { resolve?: Resolve }) => options?.resolve ?? fromCdn;

// Pyodide's own runtime, from where the page says or jsDelivr at the version the tree was built against
export const pyodideIndexUrl = (indexURL: string | undefined, version: string) =>
  new URL(indexURL ?? `https://cdn.jsdelivr.net/npm/pyodide@${version}/`, globalThis.location?.href).href;

export const defaultAssetsBaseUrl = () =>
  fromImportMap('pocket-region/vendor/', () => `https://cdn.jsdelivr.net/npm/pocket-region@${PACKAGE_VERSION}/vendor/`);
