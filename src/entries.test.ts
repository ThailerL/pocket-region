import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

describe('entry points', () => {
  it('publishes one entry for Node and one for a page, and nothing else', () => {
    expect(Object.keys(manifest.exports).sort()).toEqual(['./browser', './node']);
  });

  it('gives Node everything from one import', async () => {
    const node = await import('./index.ts');
    expect(Object.keys(node).sort()).toEqual(['CliError', 'awsCli', 'createRegion', 'directoryStore', 'requestHandler', 'serve']);
  });

  it('gives a page everything from one import', async () => {
    const page = await import('./browser.ts');
    expect(Object.keys(page).sort()).toEqual(['CliError', 'awsCli', 'createRegion', 'createRunner', 'indexedDbStore', 'requestHandler']);
  });
});
