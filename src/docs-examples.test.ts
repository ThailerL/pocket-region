import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { importMap } from '../site/src/import-map.mjs';
import type { Region } from './core.ts';
import { createRegion } from './node.ts';
import { AsyncFunction, IMPORT, rewriteImports } from './runner/imports.ts';
import { runnablesOf } from './testing/docs.ts';
import { withRegion } from './with-region.ts';

const DOCS = new URL('../site/src/content/docs/docs/', import.meta.url);

// What the docs' import map serves in a page, from the installed packages, with the library's Node entry standing in
const modules = new Map(
  Object.keys(importMap.imports)
    .filter((specifier) => !specifier.endsWith('/'))
    .map((specifier) => [
      specifier,
      specifier === 'pocket-region/browser' ? () => import('./index.ts') : () => import(/* @vite-ignore */ specifier),
    ]),
);

// A Python fence beside one runs in docs-python-examples.test.ts
const examples = readdirSync(DOCS)
  .filter((file) => file.endsWith('.mdx'))
  .flatMap((file) => runnablesOf(file, readFileSync(new URL(file, DOCS), 'utf8'), 'js'));

// For examples written for AWS, as the runner has; without it their clients would reach AWS
let shared: Promise<Region> | undefined;
afterAll(async () => (await shared)?.stop());

async function run(code: string) {
  const lines: string[] = [];
  const console = { log: (...args: unknown[]) => lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')) };
  const { code: body, specifiers } = rewriteImports(code);
  const region = specifiers.some((specifier) => specifier.startsWith('pocket-region')) ? undefined : await (shared ??= createRegion());
  await region?.reset();
  const load = async (specifier: string) => {
    const loadModule = modules.get(specifier);
    if (!loadModule) throw new Error(`the docs import ${specifier}: add it to the site's import map`);
    const module = (await loadModule()) as object;
    return region ? withRegion(module, region) : module;
  };
  await new AsyncFunction(IMPORT, 'console', body)(load, console);
  return lines;
}

describe('runnable docs examples', () => {
  it('finds them', () => {
    expect(examples.length).toBeGreaterThan(10);
  });

  it.each(examples)('$name prints what it did', async ({ code }) => {
    expect(await run(code)).toMatchSnapshot();
  }, 60_000);
});
