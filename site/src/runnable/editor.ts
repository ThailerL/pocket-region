import { Compartment, EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, minimalSetup } from 'codemirror';
import type { Language } from 'pocket-region/browser';

export type Editor = { code(): string; reset(): void };

// Starlight stamps the chosen theme on <html>, so open editors follow it
const themed = () => (document.documentElement.dataset.theme === 'dark' ? oneDark : []);
const theme = new Compartment();
const views = new Set<EditorView>();
new MutationObserver(() => {
  for (const view of views) view.dispatch({ effects: theme.reconfigure(themed()) });
}).observe(document.documentElement, { attributeFilter: ['data-theme'] });

// The grammar loads with the language, so a reader editing one never downloads the other
const grammarFor = async (language: Language) =>
  language === 'python' ? (await import('@codemirror/lang-python')).python() : (await import('@codemirror/lang-javascript')).javascript();

export async function mount(parent: HTMLElement, original: string, language: Language): Promise<Editor> {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: original,
      extensions: [minimalSetup, await grammarFor(language), theme.of(themed())],
    }),
  });
  views.add(view);
  return {
    code: () => view.state.doc.toString(),
    reset: () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: original } }),
  };
}
