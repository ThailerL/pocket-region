import { describe, expect, it } from 'vitest';
import { createRegion, indexedDbStore } from './browser.ts';
import { assetsBaseUrl } from './test-region.browser.ts';

describe('createRegion in a page', () => {
  it('says where it looked when the assets are missing', async () => {
    await expect(createRegion({ assetsBaseUrl: `${assetsBaseUrl}/absent` })).rejects.toThrow(
      /no region assets at/,
    );
  });
});

describe('indexedDbStore in a page', () => {
  it('refuses a second load until the first is closed', async () => {
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
});
