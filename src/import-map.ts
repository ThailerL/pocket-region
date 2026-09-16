import { PACKAGE_VERSION } from './version.generated.ts';

// import.meta.resolve throws when the page's import map doesn't map the specifier
export function fromImportMap(specifier: string, fallback: () => string) {
  try {
    return import.meta.resolve(specifier);
  } catch {
    return fallback();
  }
}

export const defaultAssetsBaseUrl = () =>
  fromImportMap('pocket-region/vendor/', () => `https://cdn.jsdelivr.net/npm/pocket-region@${PACKAGE_VERSION}/vendor/`);
