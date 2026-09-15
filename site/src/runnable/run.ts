import type * as Browser from 'pocket-region/browser';
import { load } from '../load.ts';
import type { Editor } from './editor.ts';

let runner: Promise<Browser.Runner> | undefined;
const runnerFor = () =>
  (runner ??= load<typeof Browser>('pocket-region/browser').then(({ createRunner }) => createRunner({ load })));

const codeOf = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('.ec-line'), (line) => line.textContent).join('\n');

const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

export function connect(root: HTMLElement) {
  const button = root.querySelector<HTMLButtonElement>('.run')!;
  const state = root.querySelector<HTMLElement>('.state')!;
  const output = root.querySelector<HTMLElement>('.output')!;
  let original: string | undefined;
  let editor: Editor | undefined;

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await run(editor?.code() ?? (original ??= codeOf(root)), state, output);
    } finally {
      button.disabled = false;
    }
  });
  root.querySelector('.edit')!.addEventListener('click', async () => {
    editor = (await import('./editor.ts')).mount(root.querySelector('.editor')!, (original ??= codeOf(root)));
    root.classList.add('editing');
  });
  root.querySelector('.reset')!.addEventListener('click', () => editor?.reset());
}

async function run(code: string, state: HTMLElement, output: HTMLElement) {
  output.textContent = '';
  state.textContent = 'Running… a first run downloads about 15 MB';
  try {
    const current = await runnerFor();
    if (!current.supported) {
      state.textContent = "This browser can't run a region: it lacks WebAssembly JSPI";
      return;
    }
    const result = await current.run(code, { onOutput: ({ text }) => output.append(`${text}\n`) });
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
