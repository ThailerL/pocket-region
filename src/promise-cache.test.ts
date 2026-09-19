import { describe, expect, it } from 'vitest';
import { promiseCache } from './promise-cache.ts';

describe('promiseCache', () => {
  it('makes each key once', async () => {
    const cache = promiseCache<number>();
    let made = 0;
    const make = async () => ++made;
    expect(await cache('a', make)).toBe(1);
    expect(await cache('a', make)).toBe(1);
    expect(await cache('b', make)).toBe(2);
  });

  it('makes a key again after its promise rejects', async () => {
    const cache = promiseCache<string>();
    await expect(cache('a', () => Promise.reject(new Error('offline')))).rejects.toThrow('offline');
    expect(await cache('a', async () => 'loaded')).toBe('loaded');
  });
});
