import type * as Browser from 'pocket-region/browser';
import { load } from '../load.ts';
import type { Editor } from './editor.ts';

let runner: Promise<Browser.Runner> | undefined;
const runnerFor = () => (runner ??= load<typeof Browser>('pocket-region/browser').then(({ createRunner }) => createRunner()));

const linesOf = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>('.ec-line'));
const codeOf = (root: HTMLElement) => linesOf(root).map((line) => line.textContent).join('\n');

// The fence's language, as Expressive Code stamps it; anything but Python runs as JavaScript
const languageOf = (root: HTMLElement): Browser.Language =>
  ['py', 'python'].includes(root.querySelector<HTMLElement>('pre[data-language]')?.dataset.language ?? '') ? 'python' : 'javascript';

// A `>>>` session: its statements start at a primary prompt and continue at `...`
const PRIMARY = /^>>>( |$)/;
const PROMPT = /^(>>>|\.\.\.)( |$)/;
const isSession = (root: HTMLElement) => PRIMARY.test(linesOf(root).find((line) => line.textContent?.trim())?.textContent ?? '');

const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

type Sink = (text: string, stream: Browser.OutputStream, line?: number) => void;

export function connect(root: HTMLElement) {
  const button = root.querySelector<HTMLButtonElement>('.run')!;
  const state = root.querySelector<HTMLElement>('.state')!;
  const output = root.querySelector<HTMLElement>('.output')!;
  const onPage = root.dataset.page !== undefined;
  const language = languageOf(root);
  const session = language === 'python' && isSession(root);
  if (session) root.classList.add('session');
  let original: string | undefined;
  let editor: Editor | undefined;

  button.addEventListener('click', async () => {
    button.disabled = true;
    root.classList.add('running');
    try {
      if (session) await runSession(root, state);
      else {
        const code = editor?.code() ?? (original ??= codeOf(root));
        output.textContent = '';
        if (onPage) await runOnPage(code, state, output);
        else await run(code, { language }, (text) => output.append(`${text}\n`), state);
      }
    } finally {
      root.classList.remove('running');
      button.disabled = false;
    }
  });
  root.querySelector('.stop')!.addEventListener('click', () => runner?.then((current) => current.stop()));
  root.querySelector('.edit')!.addEventListener('click', async () => {
    editor = await (await import('./editor.ts')).mount(root.querySelector('.editor')!, (original ??= codeOf(root)), language);
    root.classList.add('editing');
  });
  root.querySelector('.reset')!.addEventListener('click', () => {
    if (session) clearResults(root);
    else editor?.reset();
  });
}

const STATUS: Record<Browser.RunnerPhase, string> = {
  booting: 'Booting a region… a first visit downloads about 15 MB',
  resetting: 'Emptying the region…',
  'setting-up': 'Setting up the region…',
  running: 'Running…',
};

async function run(code: string, options: { language: Browser.Language; echo?: boolean }, show: Sink, state: HTMLElement) {
  state.textContent = 'Loading…';
  try {
    const current = await runnerFor();
    if (!current.supported) {
      state.textContent = "This browser can't run a region: it lacks WebAssembly JSPI";
      return;
    }
    const result = await current.run(code, {
      ...options,
      onOutput: ({ text, stream, line }) => show(text, stream, line),
      onStatus: ({ phase }) => (state.textContent = STATUS[phase]),
    });
    if (result.ok) {
      state.textContent = `Done in ${Math.round(result.durationMs)} ms`;
      return;
    }
    const error = result.error as Error & { line?: number };
    // A Python error's stack is its traceback, as a terminal would show it
    show((options.language === 'python' && error.stack) || describe(error), 'stderr', error.line);
  } catch (error) {
    show(describe(error), 'stderr');
  }
  state.textContent = 'Failed';
}

// Where a statement's next result goes: its last line, then each result placed after the one before
type Statement = { last: HTMLElement };

// A session's statements and, for each fence line, the statement it belongs to; the prompts are the
// fence's format and the expected output is blanked, so every line keeps its number
function statementsOf(root: HTMLElement) {
  const statements: Statement[] = [];
  const owner: (Statement | undefined)[] = [];
  const code: string[] = [];
  for (const line of linesOf(root)) {
    const text = line.textContent ?? '';
    if (PRIMARY.test(text)) statements.push({ last: line });
    else if (PROMPT.test(text) && statements.length > 0) statements.at(-1)!.last = line;
    else line.classList.add('expected');
    owner.push(statements.at(-1));
    code.push(PROMPT.test(text) ? text.replace(PROMPT, '') : '');
  }
  return { statements, owner, code: code.join('\n') };
}

function clearResults(root: HTMLElement) {
  root.classList.remove('ran');
  for (const line of root.querySelectorAll('.result')) line.remove();
}

function showResult(after: HTMLElement, text: string, stream: Browser.OutputStream) {
  const line = document.createElement('div');
  line.className = `ec-line result ${stream}`;
  const code = document.createElement('div');
  code.className = 'code';
  code.textContent = text;
  line.append(code);
  after.after(line);
  return line;
}

// The session as one run, each result placed under the statement whose line produced it, where the
// fence showed what the page's author expected
async function runSession(root: HTMLElement, state: HTMLElement) {
  clearResults(root);
  root.classList.add('ran');
  const { statements, owner, code } = statementsOf(root);
  await run(code, { language: 'python', echo: true }, (text, stream, line) => {
    const statement = (line === undefined ? undefined : owner[line - 1]) ?? statements.at(-1)!;
    statement.last = showResult(statement.last, text, stream);
  }, state);
}

const LEVELS = ['log', 'info', 'debug', 'warn', 'error'] as const;
const format = (value: unknown) => (typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value)));

// The code as shown, as a module of this page, with the page's console pointed at the panel
async function runOnPage(code: string, state: HTMLElement, output: HTMLElement) {
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
