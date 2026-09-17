// A `>>>` session: its statements start at a primary prompt and continue at `...`
export const PRIMARY = /^>>>( |$)/;
export const PROMPT = /^(>>>|\.\.\.)( |$)/;

export const isSession = (lines: string[]) => PRIMARY.test(lines.find((line) => line.trim()) ?? '');

// The session as one snippet: prompts are the page's format and the expected output is blanked, so every line keeps its number
export const sessionCode = (lines: string[]) => lines.map((line) => (PROMPT.test(line) ? line.replace(PROMPT, '') : '')).join('\n');
