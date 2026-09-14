import { load } from '../load.ts';
import type { Editor } from './editor.ts';

// One example at a time: each boots its own region
let queue: Promise<unknown> = Promise.resolve();

const codeOf = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('.ec-line'), (line) => line.textContent).join('\n');

const format = (value: unknown) =>
  typeof value === 'string' ? value : value instanceof Error ? `${value.name}: ${value.message}` : JSON.stringify(value, null, 2);

export function connect(root: HTMLElement) {
  const button = root.querySelector<HTMLButtonElement>('.run')!;
  const state = root.querySelector<HTMLElement>('.state')!;
  const output = root.querySelector<HTMLElement>('.output')!;
  let original: string | undefined;
  let editor: Editor | undefined;

  button.addEventListener('click', () => {
    button.disabled = true;
    queue = queue
      .then(() => run(editor?.code() ?? (original ??= codeOf(root)), state, output))
      .finally(() => (button.disabled = false));
  });
  root.querySelector('.edit')!.addEventListener('click', async () => {
    editor = (await import('./editor.ts')).mount(root.querySelector('.editor')!, (original ??= codeOf(root)));
    root.classList.add('editing');
  });
  root.querySelector('.reset')!.addEventListener('click', () => editor?.reset());
}

async function run(code: string, state: HTMLElement, output: HTMLElement) {
  output.textContent = '';
  const write = (...args: unknown[]) => output.append(`${args.map(format).join(' ')}\n`);

  try {
    state.textContent = 'Running… a first run downloads about 12 MB';
    const started = performance.now();
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    const original = { log: console.log, error: console.error };
    console.log = write;
    console.error = write;
    try {
      await load(url);
    } finally {
      Object.assign(console, original);
      URL.revokeObjectURL(url);
    }
    state.textContent = `Done in ${Math.round(performance.now() - started)} ms`;
  } catch (error) {
    write(error);
    state.textContent = 'Failed';
  }
}
