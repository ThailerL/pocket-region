import type * as Browser from 'pocket-region/browser';
import { load } from '../load.ts';
import type { Editor } from './editor.ts';

let runner: Promise<Browser.Runner> | undefined;
const runnerFor = () => (runner ??= load<typeof Browser>('pocket-region/browser').then(({ createRunner }) => createRunner()));

const codeOf = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('.ec-line'), (line) => line.textContent).join('\n');

const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

type Panel = { state: HTMLElement; output: HTMLElement };

export function connect(root: HTMLElement) {
  const button = root.querySelector<HTMLButtonElement>('.run')!;
  const panel: Panel = { state: root.querySelector('.state')!, output: root.querySelector('.output')! };
  const onPage = root.dataset.page !== undefined;
  let original: string | undefined;
  let editor: Editor | undefined;

  button.addEventListener('click', async () => {
    button.disabled = true;
    root.classList.add('running');
    try {
      const code = editor?.code() ?? (original ??= codeOf(root));
      await (onPage ? runOnPage(code, panel) : run(code, panel));
    } finally {
      root.classList.remove('running');
      button.disabled = false;
    }
  });
  root.querySelector('.stop')!.addEventListener('click', () => runner?.then((current) => current.stop()));
  root.querySelector('.edit')!.addEventListener('click', async () => {
    editor = (await import('./editor.ts')).mount(root.querySelector('.editor')!, (original ??= codeOf(root)));
    root.classList.add('editing');
  });
  root.querySelector('.reset')!.addEventListener('click', () => editor?.reset());
}

const STATUS: Record<Browser.RunnerStatus, string> = {
  booting: 'Booting a region… a first visit downloads about 15 MB',
  resetting: 'Emptying the region…',
  'setting-up': 'Setting up the region…',
  running: 'Running…',
};

async function run(code: string, { state, output }: Panel) {
  output.textContent = '';
  state.textContent = 'Loading…';
  try {
    const current = await runnerFor();
    if (!current.supported) {
      state.textContent = "This browser can't run a region: it lacks WebAssembly JSPI";
      return;
    }
    const result = await current.run(code, {
      onOutput: ({ text }) => output.append(`${text}\n`),
      onStatus: (status) => (state.textContent = STATUS[status]),
    });
    if (result.ok) {
      state.textContent = `Done in ${Math.round(result.durationMs)} ms`;
      return;
    }
    output.append(`${describe(result.error)}\n`);
  } catch (error) {
    output.append(`${describe(error)}\n`);
  }
  state.textContent = 'Failed';
}

const LEVELS = ['log', 'info', 'debug', 'warn', 'error'] as const;
const format = (value: unknown) => (typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value)));

// The code as shown, as a module of this page, with the page's console pointed at the panel
async function runOnPage(code: string, { state, output }: Panel) {
  output.textContent = '';
  state.textContent = 'Running…';
  const started = performance.now();
  const kept = Object.fromEntries(LEVELS.map((level) => [level, console[level]]));
  for (const level of LEVELS) console[level] = (...args: unknown[]) => output.append(`${args.map(format).join(' ')}\n`);
  try {
    await import(/* @vite-ignore */ URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    state.textContent = `Done in ${Math.round(performance.now() - started)} ms`;
  } catch (error) {
    output.append(`${describe(error)}\n`);
    state.textContent = 'Failed';
  } finally {
    Object.assign(console, kept);
  }
}
