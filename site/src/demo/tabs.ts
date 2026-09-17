import { element } from './dom.ts';

const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].map((tab) => ({
  tab,
  panel: element<HTMLElement>(`#${tab.dataset.tab}-tab`),
}));

const STEP: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };

function select(chosen: HTMLButtonElement) {
  for (const { tab, panel } of tabs) {
    const selected = tab === chosen;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    panel.hidden = !selected;
  }
}

function show(tab: HTMLButtonElement) {
  history.replaceState(null, '', `#${tab.dataset.tab}`);
  select(tab);
  tab.focus();
}

for (const [index, { tab }] of tabs.entries()) {
  tab.addEventListener('click', () => show(tab));
  tab.addEventListener('keydown', (event) => {
    const step = STEP[event.key];
    if (step) show(tabs[(index + step + tabs.length) % tabs.length]!.tab);
  });
}

select(tabs.find(({ tab }) => `#${tab.dataset.tab}` === location.hash)?.tab ?? tabs[0]!.tab);
