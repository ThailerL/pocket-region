import { describe, expect, it } from 'vitest';
import { AsyncFunction } from './imports.ts';
import { snippetLine } from './stack.ts';

describe('snippetLine', () => {
  it('names the line of the snippet a call came from, through a library, and none from outside one', async () => {
    const lines: (number | undefined)[] = [];
    const console = { log: () => lines.push(snippetLine()) };
    const library = { warn: (target: typeof console) => target.log() };
    await new AsyncFunction('__import', 'console', 'lib', 'console.log();\n\nfor (const i of [1]) {\n  lib.warn(console);\n}\nawait Promise.resolve();\nconsole.log();')(undefined, console, library);
    expect(lines).toEqual([1, 4, 7]);
    expect(snippetLine()).toBeUndefined();
  });
});
