import 'fake-indexeddb/auto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { indexedDbStore } from './browser.ts';
import { directoryStore, type StateStore } from './node.ts';

const directories: string[] = [];
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (contents?: Uint8Array) => new TextDecoder().decode(contents);

afterAll(() => Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true }))));

const STORES: [string, (name: string) => Promise<StateStore>][] = [
  [
    'directoryStore',
    async (name) => {
      const dir = await mkdtemp(path.join(tmpdir(), `pocket-region-${name}-`));
      directories.push(dir);
      return directoryStore(path.join(dir, 'missing'));
    },
  ],
  ['indexedDbStore', async (name) => indexedDbStore(`pocket-region-${name}`)],
];

describe.each(STORES)('%s', (_, create) => {
  it('loads nothing before the first save', async () => {
    expect((await (await create('empty')).load()).size).toBe(0);
  });

  it('reads back nested keys, and drops keys a later replace leaves out', async () => {
    const store = await create('replaced');
    await store.replace(
      new Map([
        ['state/sqs.json', bytes('queues')],
        ['objects/000000000000/photos/cat.txt', bytes('meow')],
      ]),
    );
    await store.replace(new Map([['objects/000000000000/photos/cat.txt', bytes('purr')]]));

    const loaded = await store.load();
    expect([...loaded.keys()]).toEqual(['objects/000000000000/photos/cat.txt']);
    expect(text(loaded.get('objects/000000000000/photos/cat.txt'))).toBe('purr');
  });
});
