import { describe, expect, it, vi } from 'vitest';
import { createRegion, indexedDbStore } from './browser.ts';
import { s3 } from './test-clients.ts';
import { assetsBaseUrl, createTestRegion } from './test-region.browser.ts';
import { describeStore } from './test-stores.ts';

const decoder = new TextDecoder();

describe('createRegion in a page', () => {
  it('says where it looked when the assets are missing', async () => {
    await expect(createRegion({ assetsBaseUrl: `${assetsBaseUrl}/absent` })).rejects.toThrow(
      /no region assets at/,
    );
  });

  it("loads this release's assets from jsDelivr when no assetsBaseUrl is given", async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    try {
      await expect(createRegion()).rejects.toThrow(/no region assets at/);
      expect(String(fetch.mock.calls[0]![0])).toMatch(
        /^https:\/\/cdn\.jsdelivr\.net\/npm\/pocket-region@\d+\.\d+\.\d+[^/]*\/vendor\/meta\.json$/,
      );
    } finally {
      fetch.mockRestore();
    }
  });
});

describeStore('indexedDbStore', async (name) => indexedDbStore(`pocket-region-${name}-${crypto.randomUUID()}`));

describe('indexedDbStore in a page', () => {
  it('refuses a second store on the same database until the first is closed', async () => {
    const store = indexedDbStore('pocket-region-page-locked');
    await store.load();
    await expect(indexedDbStore('pocket-region-page-locked').load()).rejects.toThrow('in use by another region');
    await store.close?.();
    await store.load();
    await store.close?.();
  });

  // A terminated worker stands in for a closed tab: both end the agent that holds the lock
  it('refuses a store another context holds, and takes it once that context ends', async () => {
    const name = 'pocket-region-page-worker';
    const source = `navigator.locks.request('pocket-region:${name}', () => { postMessage('held'); return new Promise(() => {}); });`;
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    await new Promise((resolve) => worker.addEventListener('message', resolve, { once: true }));

    const store = indexedDbStore(name);
    await expect(store.load()).rejects.toThrow('in use by another region');
    worker.terminate();
    await expect.poll(() => store.load().then(() => true, () => false)).toBe(true);
    await store.close?.();
  });

  it('saves a region that a later region reads back', async () => {
    const name = `pocket-region-page-saved-${crypto.randomUUID()}`;
    const first = await createTestRegion({ store: indexedDbStore(name) });
    await s3('PUT', '/saved', undefined, first);
    await s3('PUT', '/saved/keep.txt', 'kept', first);
    await s3('PUT', '/saved/gone.txt', 'deleted after the first save', first);
    await first.save();
    await s3('DELETE', '/saved/gone.txt', undefined, first);
    await first.stop();

    const second = await createTestRegion({ store: indexedDbStore(name) });
    const kept = await s3('GET', '/saved/keep.txt', undefined, second);
    expect(kept.status).toBe(200);
    expect(decoder.decode(kept.body)).toBe('kept');
    expect((await s3('GET', '/saved/gone.txt', undefined, second)).status).toBe(404);
    await second.stop();
    indexedDB.deleteDatabase(name);
  }, 60_000);
});
