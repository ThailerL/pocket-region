// The StateStore contract, run over directoryStore in Node and indexedDbStore in a page
import { describe, expect, it } from 'vitest';
import type { StateStore } from '../core.ts';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (contents?: Uint8Array) => new TextDecoder().decode(contents);

export function describeStore(label: string, create: (name: string) => Promise<StateStore>) {
  describe(label, () => {
    it('loads nothing before the first save', async () => {
      const store = await create('empty');
      expect((await store.load()).size).toBe(0);
      await store.close?.();
    });

    it('refuses a second load until the first is closed', async () => {
      const store = await create('locked');
      await store.load();
      await expect(store.load()).rejects.toThrow('in use by another region');
      await store.close?.();
      await store.load();
      await store.close?.();
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
      await store.close?.();
    });
  });
}
