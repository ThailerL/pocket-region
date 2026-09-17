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
let booting: Promise<Run> | undefined;

async function boot({ indexURL, packageBaseUrl, packages, environment }: PythonBoot): Promise<Run> {
  const { loadPyodide }: typeof import('pyodide') = await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`);
  // micropip downloads while Pyodide bootstraps; the packages need micropip first
  const py: PyodideInterface = await loadPyodide({ indexURL, packageBaseUrl, packages: ['micropip'] });
  const micropip = py.pyimport('micropip');
  await micropip.install(packages);
  micropip.destroy();
  bridge.environment = environment;
  py.registerJsModule('_pocket_region', bridge);
  // Takes over stdout and stderr after the install: what Pyodide printed while loading packages is not the snippet's output
  py.runPython(SNIPPET_PYTHON);
  return py.globals.get('run') as Run;
}

async function run({ code, fresh, echo = false }: RunMessage, attached: Promise<Region>) {
  if (!booting) throw new Error('the Python worker was not told where Pyodide is');
  // Pyodide and the packages load while the region boots on the page
  const [execute, region] = await Promise.all([booting, attached]);
  bridge.dispatch = region.dispatch;
  return execute(code, echo, fresh);
}

serveRuns(run, (data) => {
  if (data.type === 'boot') booting = boot(data.python);
});
