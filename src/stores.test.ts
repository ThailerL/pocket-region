import 'fake-indexeddb/auto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { indexedDbStore } from './browser.ts';
import { directoryStore, type StateStore } from './node.ts';

const directories: string[] = [];
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (contents?: Uint8Array) => new TextDecoder().decode(contents);

afterAll(() => Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true }))));

const tempDir = async (name: string) => {
  const dir = await mkdtemp(path.join(tmpdir(), `pocket-region-${name}-`));
  directories.push(dir);
  return dir;
};

const STORES: [string, (name: string) => Promise<StateStore>][] = [
  ['directoryStore', async (name) => directoryStore(path.join(await tempDir(name), 'missing'))],
  ['indexedDbStore', async (name) => indexedDbStore(`pocket-region-${name}`)],
];

describe.each(STORES)('%s', (_, create) => {
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

describe('directoryStore locking', () => {
  const lockedDir = async (owner: { pid: number; hostname: string }) => {
    const dir = await tempDir('lock');
    await writeFile(path.join(dir, '.lock'), JSON.stringify(owner));
    return dir;
  };

  it('takes over a lock left by a process that has exited', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    await once(child, 'exit');
    const store = directoryStore(await lockedDir({ pid: child.pid!, hostname: hostname() }));
    expect((await store.load()).size).toBe(0);
    await store.close?.();
  });

  it('refuses a lock a live process holds, and one from another host', async () => {
    const live = directoryStore(await lockedDir({ pid: process.ppid, hostname: hostname() }));
    await expect(live.load()).rejects.toThrow(`process ${process.ppid}`);
    const remote = directoryStore(await lockedDir({ pid: 1, hostname: `not-${hostname()}` }));
    await expect(remote.load()).rejects.toThrow('in use by another region');
  });

  it('refuses a second store on the same directory', async () => {
    const dir = await tempDir('shared');
    const first = directoryStore(dir);
    await first.load();
    await expect(directoryStore(dir).load()).rejects.toThrow('in use by another region');
    await first.close?.();
    expect(await readdir(dir)).toEqual([]);
  });
});
