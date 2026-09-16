import { describe, expect, it } from 'vitest';
import type { RunnerOutput } from './protocol.ts';
import { createConsole } from './console.ts';

function capture() {
  const lines: RunnerOutput[] = [];
  return { console: createConsole((line) => lines.push(line)), lines };
}

describe('the console a snippet sees', () => {
  it('lays out console.table as Node does, with a Values column for rows that are not objects', () => {
    const { console, lines } = capture();
    const books = [{ title: 'IT', price: 15 }, { title: 'Carrie', genre: ['HORROR'] }, 'loose'];
    console.table(books);
    expect(lines).toEqual([{ method: 'table', stream: 'log', values: [books], text: `┌─────────┬────────┬───────┬────────────┬────────┐
│ (index) │ title  │ price │ genre      │ Values │
├─────────┼────────┼───────┼────────────┼────────┤
│ 0       │ IT     │ 15    │            │        │
│ 1       │ Carrie │       │ ["HORROR"] │        │
│ 2       │        │       │            │ loose  │
└─────────┴────────┴───────┴────────────┴────────┘` }]);
  });

  it('keeps only the columns console.table is given, keyed by an object', () => {
    const { console, lines } = capture();
    console.table({ it: { title: 'IT', price: 15 } }, ['price']);
    expect(lines[0].text).toBe(`┌─────────┬───────┐
│ (index) │ price │
├─────────┼───────┤
│ it      │ 15    │
└─────────┴───────┘`);
  });

  it('prints a table with no rows to draw as log would', () => {
    const { console, lines } = capture();
    console.table('plain', 1);
    console.table(new Error('bad'));
    console.table(new Map([['k', 1]]));
    console.table([]);
    expect(lines.map((line) => line.text)).toEqual(['plain 1', 'Error: bad', '{}', '[]']);
  });

  it('prints only what console.dir is given, not its options', () => {
    const { console, lines } = capture();
    console.dir({ a: 1 }, { depth: 0 });
    expect(lines).toEqual([{ method: 'dir', stream: 'log', text: '{\n  "a": 1\n}', values: [{ a: 1 }, { depth: 0 }] }]);
  });

  it('names the method each line came from, and sends warnings and errors to the error stream', () => {
    const { console, lines } = capture();
    for (const method of ['log', 'info', 'debug', 'warn', 'error'] as const) console[method](method);
    expect(lines.map(({ method, stream }) => [method, stream])).toEqual([
      ['log', 'log'],
      ['info', 'log'],
      ['debug', 'log'],
      ['warn', 'error'],
      ['error', 'error'],
    ]);
  });
});
