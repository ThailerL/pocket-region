import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { directoryStore } from './node.ts';
import { describeStore } from './testing/stores.ts';

const directories: string[] = [];

afterAll(() => Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true }))));

const tempDir = async (name: string) => {
  const dir = await mkdtemp(path.join(tmpdir(), `pocket-region-${name}-`));
  directories.push(dir);
  return dir;
};

describeStore('directoryStore', async (name) => directoryStore(path.join(await tempDir(name), 'missing')));

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

  // A container's region is often pid 1 on every start, so its own pid is no proof of life
  it('takes over a lock left by an earlier process with this pid', async () => {
    const store = directoryStore(await lockedDir({ pid: process.pid, hostname: hostname() }));
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
