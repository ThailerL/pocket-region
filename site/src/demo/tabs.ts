import { element } from './dom.ts';

const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

function select(name: string) {
  for (const tab of tabs) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    element<HTMLElement>(`#${tab.dataset.tab}-tab`).hidden = !selected;
  }
}

function show(tab: HTMLButtonElement) {
  history.replaceState(null, '', `#${tab.dataset.tab}`);
  select(tab.dataset.tab!);
  tab.focus();
}

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => show(tab));
  tab.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (step) show(tabs[(index + step + tabs.length) % tabs.length]!);
  });
}

select(tabs.some((tab) => `#${tab.dataset.tab}` === location.hash) ? location.hash.slice(1) : tabs[0]!.dataset.tab!);
