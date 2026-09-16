// A module beside this one, with this file's extension: .ts under Vite, .js as published
export function siblingUrl(path: string) {
  // Not new URL(`./${path}`, import.meta.url): Vite rewrites that form into an asset lookup
  const url = new URL(import.meta.url);
  url.pathname = url.pathname.replace(/[^/]+(\.[cm]?[jt]s)$/, `${path}$1`);
  url.search = '';
  url.hash = '';
  return url.href;
}

// From a blob, so the module it imports may be cross-origin
export function startWorker(source: string, name?: string) {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    return new Worker(url, { type: 'module', name });
  } finally {
    // Resolved by the constructor
    URL.revokeObjectURL(url);
  }
}

export const importing = (url: string) => `import ${JSON.stringify(url)};`;

type Failing = { onerror?: ((event: ErrorEvent) => void) | null };

// A module that fails to load never answers; the error event is the only sign
export function onFailure(worker: Failing, what: string, fail: (error: Error) => void) {
  worker.onerror = (event) => {
    event.preventDefault();
    fail(new Error(`${what} failed: ${event.message}`));
  };
}
