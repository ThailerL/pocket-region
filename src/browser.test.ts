import { describe, expect, it } from 'vitest';
import { createRegion } from './browser.ts';
import { assetsBaseUrl } from './test-region.browser.ts';

describe('createRegion in a page', () => {
  it('says where it looked when the assets are missing', async () => {
    await expect(createRegion({ assetsBaseUrl: `${assetsBaseUrl}/absent` })).rejects.toThrow(
      /no region assets at/,
    );
  });
});
