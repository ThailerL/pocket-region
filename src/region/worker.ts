// A page's region, started by createRegion as a module worker
import { createWorkerHost } from '../lambda/worker-host.ts';
import { workerEndpoint, type FromRegionWorker, type ToRegionWorker } from './protocol.ts';
import { serveRegion } from './serve.ts';

serveRegion(workerEndpoint<FromRegionWorker, ToRegionWorker>(), (assets, resolveAll) => {
  // Fetched while bootRegion loads the store
  const runtime: Promise<typeof import('pyodide')> = import(/* @vite-ignore */ `${assets.indexURL}pyodide.mjs`);
  return {
    assets: { ...assets, loadPyodide: (options) => runtime.then(({ loadPyodide }) => loadPyodide(options)) },
    lambda: (region) => createWorkerHost({ ...region, resolveAll, python: { indexURL: assets.indexURL, wheels: assets.pythonRuntime } }),
  };
});
