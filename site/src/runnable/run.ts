import type * as Browser from 'pocket-region/browser';
import { load } from '../load.ts';
import { storageKey } from '../snippets.mjs';
import type { Editor } from './editor.ts';
import { isSession, PRIMARY, PROMPT, sessionCode } from './session.ts';

let browser: Promise<typeof Browser> | undefined;
const browserFor = () => (browser ??= load<typeof Browser>('pocket-region/browser'));

let runner: Promise<Browser.Runner> | undefined;
const runnerFor = () => (runner ??= browserFor().then(({ createRunner }) => createRunner()));

const linesOf = (block: HTMLElement) => Array.from(block.querySelectorAll<HTMLElement>('.ec-line'));
const textsOf = (block: HTMLElement) => linesOf(block).map((line) => line.textContent ?? '');

// The fence's language, as Expressive Code stamps it; anything but Python runs as JavaScript
const languageOf = (block: HTMLElement): Browser.Language =>
  ['py', 'python'].includes(block.querySelector<HTMLElement>('pre[data-language]')?.dataset.language ?? '') ? 'python' : 'javascript';

const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

type Sink = (text: string, stream: Browser.OutputStream, line?: number) => void;

// One fence of an example, with the code and editor a reader has for it
type Variant = { language: Browser.Language; block: HTMLElement; session: boolean; original: string; editor?: Editor; pane?: HTMLElement };

// The language every toggled example on the page shows, chosen from any of them and remembered
const chosen = (): Browser.Language => (document.documentElement.dataset.snippets === 'python' ? 'python' : 'javascript');
function choose(language: Browser.Language) {
  document.documentElement.dataset.snippets = language;
  try {
    localStorage.setItem(storageKey, language);
  } catch {}
}

export function connect(root: HTMLElement) {
  const button = root.querySelector<HTMLButtonElement>('.run')!;
  const state = root.querySelector<HTMLElement>('.state')!;
  const output = root.querySelector<HTMLElement>('.output')!;
  const panes = root.querySelector<HTMLElement>('.editor')!;
  const toggles = root.querySelectorAll<HTMLButtonElement>('.toggle button');
  const onPage = root.dataset.page !== undefined;
  const variants = new Map<Browser.Language, Variant>();
  for (const block of root.querySelectorAll<HTMLElement>('.expressive-code')) {
    const language = languageOf(block);
    const texts = textsOf(block);
    variants.set(language, { language, block, session: language === 'python' && isSession(texts), original: texts.join('\n') });
  }
  const active = () => variants.get(chosen()) ?? variants.values().next().value!;

  // Switching languages clears the run shown and brings back the editor open for the other one
  function show() {
    const variant = active();
    output.textContent = '';
    state.textContent = '';
    for (const other of variants.values()) {
      if (other.session) clearResults(root, other.block);
      if (other.pane) other.pane.hidden = other !== variant;
    }
    root.classList.toggle('session', variant.session);
    root.classList.toggle('editing', variant.editor !== undefined);
    for (const toggle of toggles) toggle.ariaPressed = String(toggle.dataset.language === variant.language);
  }
  show();
  if (variants.size > 1) new MutationObserver(show).observe(document.documentElement, { attributeFilter: ['data-snippets'] });

  button.addEventListener('click', async () => {
    const variant = active();
    button.disabled = true;
    root.classList.add('running');
    try {
      if (variant.session) await runSession(root, variant.block, state);
      else {
        const code = variant.editor?.code() ?? variant.original;
        output.textContent = '';
        if (onPage) await runOnPage(code, state, output);
        else await run(code, { language: variant.language }, (text) => output.append(`${text}\n`), state);
      }
    } finally {
      root.classList.remove('running');
      button.disabled = false;
    }
  });
  root.querySelector('.stop')!.addEventListener('click', () => runner?.then((current) => current.stop()));
  root.querySelector('.edit')!.addEventListener('click', async () => {
    const variant = active();
    variant.pane ??= panes.appendChild(document.createElement('div'));
    variant.editor ??= await (await import('./editor.ts')).mount(variant.pane, variant.original, variant.language);
    root.classList.add('editing');
  });
  root.querySelector('.reset')!.addEventListener('click', () => {
    const variant = active();
    if (variant.session) clearResults(root, variant.block);
    else variant.editor?.reset();
  });
  for (const toggle of toggles) toggle.addEventListener('click', () => choose(toggle.dataset.language as Browser.Language));
}

const STATUS: Record<Browser.RunnerPhase, string> = {
  booting: 'Booting a region… a first visit downloads about 10.5 MB',
  resetting: 'Emptying the region…',
  'setting-up': 'Setting up the region…',
  running: 'Running…',
};

async function run(code: string, options: { language: Browser.Language; echo?: boolean }, show: Sink, state: HTMLElement) {
  state.textContent = 'Loading…';
  try {
    const { regionSupported } = await browserFor();
    if (!regionSupported()) {
      state.textContent = "This browser can't run a region: it lacks WebAssembly JSPI";
      return;
    }
    const current = await runnerFor();
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

// A session's statements and, for each fence line, the statement it belongs to
function statementsOf(block: HTMLElement) {
  const statements: Statement[] = [];
  const owner: (Statement | undefined)[] = [];
  for (const line of linesOf(block)) {
    const text = line.textContent ?? '';
    if (PRIMARY.test(text)) statements.push({ last: line });
    else if (PROMPT.test(text) && statements.length > 0) statements.at(-1)!.last = line;
    else line.classList.add('expected');
    owner.push(statements.at(-1));
  }
  return { statements, owner, code: sessionCode(textsOf(block)) };
}

function clearResults(root: HTMLElement, block: HTMLElement) {
  root.classList.remove('ran');
  for (const line of block.querySelectorAll('.result')) line.remove();
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
async function runSession(root: HTMLElement, block: HTMLElement, state: HTMLElement) {
  clearResults(root, block);
  root.classList.add('ran');
  const { statements, owner, code } = statementsOf(block);
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
