// Runs one Python snippet at a time against the runner's region, started by createRunner as a module worker
import type { PyodideInterface } from 'pyodide';
import type { Dispatch, OutputStream, Region } from '../core.ts';
import type { WireError } from '../region/protocol.ts';
import type { PythonBoot } from './protocol.ts';
import { SNIPPET_PYTHON } from './python.generated.ts';
import { post, serveRuns, type RunMessage } from './serve.ts';

type Run = (source: string, echo: boolean, fresh: boolean) => Promise<WireError | undefined>;

// What the snippet's Python reaches through the module named _pocket_region: the run's region, its
// environment, and the way out for what it prints, with the snippet line that printed it
const bridge = {
  dispatch: undefined as Dispatch | undefined,
  environment: undefined as Record<string, string> | undefined,
  output: (stream: OutputStream, text: string, line: number | undefined) => post({ type: 'output', output: { language: 'python', stream, text, line } }),
};

async function boot({ indexURL, pyodideVersion, pythonRuntime, packages, environment }: PythonBoot): Promise<Run> {
  const { loadPyodide }: typeof import('pyodide') = await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`);
  const installing = packages.length > 0;
  // The wheels, and micropip when it's needed, download while Pyodide bootstraps. micropip is on
  // Pyodide's own CDN only, not in its npm package
  const py: PyodideInterface = await loadPyodide({
    indexURL,
    packages: installing ? [...pythonRuntime, 'micropip'] : pythonRuntime,
    ...(installing && { packageBaseUrl: `https://cdn.jsdelivr.net/pyodide/v${pyodideVersion}/full/` }),
  });
  if (installing) {
    // After the pinned wheels, so what they satisfy stays at the region's versions
    const micropip = py.pyimport('micropip');
    await micropip.install(packages);
    micropip.destroy();
  }
  bridge.environment = environment;
  py.registerJsModule('_pocket_region', bridge);
  // Takes over stdout and stderr after the load: what Pyodide printed while loading packages is not the snippet's output
  py.runPython(SNIPPET_PYTHON);
  return py.globals.get('run') as Run;
}

// The first run can arrive first: the page posts boot once it has the region's assets
let booted: (python: PythonBoot) => void;
const booting = new Promise<PythonBoot>((resolve) => (booted = resolve)).then(boot);

async function run({ code, fresh, echo = false }: RunMessage, attached: Promise<Region>) {
  // Pyodide and the wheels load while the region boots on the page
  const [execute, region] = await Promise.all([booting, attached]);
  bridge.dispatch = region.dispatch;
  return execute(code, echo, fresh);
}

serveRuns(run, (data) => {
  if (data.type === 'boot') booted(data.python);
});
