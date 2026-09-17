// The language a reader picked for the docs' examples, stamped on <html> before the page paints so no fence swaps
export const storageKey = 'pocket-region-snippets';
export const rememberedChoice = `try { if (localStorage.getItem('${storageKey}') === 'python') document.documentElement.dataset.snippets = 'python'; } catch {}`;
