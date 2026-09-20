/// <reference types="vite/client" />
import { afterAll, describe, expect, it } from 'vitest';
import { isSession, sessionCode } from '../site/src/runnable/session.ts';
import { createRunner } from './browser.ts';
import { runnablesOf } from './testing/docs.ts';
import { assetsBaseUrl, indexURL } from './testing/region.browser.ts';

const pages = import.meta.glob('../site/src/content/docs/docs/*.mdx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

// A page example calls pocket-region itself, which the runner refuses
const examples = Object.entries(pages)
  .flatMap(([path, source]) => runnablesOf(path.split('/').pop()!, source, 'py'))
  .filter((example) => !example.page);

const runner = createRunner({ boot: { assetsBaseUrl, indexURL } });
afterAll(() => runner.stop());

describe('runnable Python docs examples', () => {
  it('finds them', () => {
    expect(examples.length).toBeGreaterThan(10);
  });

  // As the site runs them, a `>>>` session echoing each value
  it.each(examples)('$name prints what it did', async ({ code }) => {
    const lines = code.split('\n');
    const session = isSession(lines);
    const output: string[] = [];
    const result = await runner.run(session ? sessionCode(lines) : code, { language: 'python', echo: session, onOutput: ({ text }) => output.push(text) });
    expect(result).toMatchObject({ ok: true });
    expect(output).toMatchSnapshot();
  }, 120_000);
});
