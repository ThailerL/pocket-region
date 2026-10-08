import { describe, expect, it } from 'vitest';
import { importSnippet, lineIn, moduleOf } from './stack.ts';

describe('lineIn', () => {
  it('names the line of the snippet a call came from, through a library, and none from outside one', async () => {
    // Node imports no Blob URL, which is what the runner loads a snippet from
    const url = `data:text/javascript,${encodeURIComponent(moduleOf('console.log();\n\nfor (const i of [1]) {\n  console.relay();\n}\nawait Promise.resolve();\nconsole.log();'))}`;
    const lines: (number | undefined)[] = [];
    const log = () => lines.push(lineIn(new Error().stack, url));
    const snippet = await importSnippet(url);
    await snippet(async () => ({}), { log, relay: () => log() });
    expect(lines).toEqual([1, 4, 7]);
    expect(lineIn(new Error().stack, url)).toBeUndefined();
  });
});
