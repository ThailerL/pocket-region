import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emulatorVersion, type VendorManifest } from './core.ts';
import { createRegion, directoryStore, type StateStore } from './node.ts';
import { s3 } from './testing/clients.ts';
import { regionPort } from './testing/region.ts';
import { runNode } from './testing/support.ts';

const decoder = new TextDecoder();

// A module beside this one, as a child script imports it
const imported = (file: string) => JSON.stringify(new URL(file, import.meta.url).href);

describe('createRegion', () => {
  it('lets Node exit once stopped', async () => {
    const script = `import { createRegion } from ${imported('./node.ts')}; await (await createRegion()).stop();`;
    expect(await runNode(script, 20_000)).toEqual({ code: 0, stderr: '' });
  }, 30_000);

  it('lets Node exit with a region never stopped', async () => {
    const script = `import { createRegion } from ${imported('./node.ts')};
      await (await createRegion()).dispatch({ method: 'GET', path: '/', headers: {} });`;
    expect(await runNode(script, 20_000)).toEqual({ code: 0, stderr: '' });
  }, 30_000);

  // An idle environment's child process once held Node until it was stopped 60 s later
  it('lets Node exit after an invocation, with its environment still idle', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pocket-region-idle-'));
    const done = path.join(directory, 'done.txt');
    const handler = `export const handler = async ({ file }) => {
      (await import('node:fs')).writeFileSync(file, 'done');
    };`;
    const script = `
      import { CreateFunctionCommand, InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
      import { createRegion } from ${imported('./node.ts')};
      import { clientConfig } from ${imported('./client-config.ts')};
      import { zipOf } from ${imported('./testing/clients.ts')};
      const lambda = new LambdaClient(clientConfig(await createRegion({ port: ${await regionPort()} })));
      await lambda.send(new CreateFunctionCommand({
        FunctionName: 'idle', Runtime: 'nodejs22.x', Handler: 'index.handler', Role: 'arn:aws:iam::000000000000:role/lambda',
        Code: { ZipFile: zipOf('index.mjs', ${JSON.stringify(handler)}) },
      }));
      await lambda.send(new InvokeCommand({ FunctionName: 'idle', Payload: JSON.stringify({ file: ${JSON.stringify(done)} }) }));
    `;
    expect(await runNode(script, 30_000)).toEqual({ code: 0, stderr: '' });
    expect(await readFile(done, 'utf8')).toBe('done');
    await rm(directory, { recursive: true, force: true });
  }, 40_000);

  it('keeps the calling thread answering timers while the region works', async () => {
    const region = await createRegion();
    await s3('PUT', '/busy', undefined, region);
    const body = new Uint8Array(32 * 1024 * 1024).fill(1);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    await s3('PUT', '/busy/large', body, region);
    clearInterval(timer);
    await region.stop();
    // On the calling thread, Python held the timer for the whole put: 2 or 3 ticks
    expect(ticks).toBeGreaterThan(10);
  }, 60_000);

  it('leaves saved state on disk until the next save', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'pocket-region-reset-'));
    const store = directoryStore(stateDir);
    const first = await createRegion({ store });
    await s3('PUT', '/saved', undefined, first);
    await s3('PUT', '/saved/keep.txt', 'kept', first);
    await first.save();
    await first.reset();
    expect((await readdir(stateDir, { recursive: true })).some((file) => file.endsWith('keep.txt'))).toBe(true);

    // Stopping saves, so the reset reaches disk here
    await first.stop();
    const saved = await createRegion({ store });
    expect((await s3('GET', '/saved/keep.txt', undefined, saved)).status).toBe(404);
    expect((await s3('GET', '/saved', undefined, saved)).status).toBe(404);
    await saved.stop();
    await rm(stateDir, { recursive: true, force: true });
  }, 60_000);

  it('saves state that a later region reads back', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'pocket-region-state-'));
    const store = directoryStore(stateDir);
    const first = await createRegion({ store });
    await s3('PUT', '/saved', undefined, first);
    await s3('PUT', '/saved/keep.txt', 'kept', first);
    await s3('PUT', '/saved/gone.txt', 'deleted after the first save', first);
    await first.save();
    expect((await readdir(stateDir, { recursive: true })).length).toBeGreaterThan(0);
    await s3('DELETE', '/saved/gone.txt', undefined, first);
    await first.stop();

    const second = await createRegion({ store });
    const kept = await s3('GET', '/saved/keep.txt', undefined, second);
    expect(kept.status).toBe(200);
    expect(decoder.decode(kept.body)).toBe('kept');
    expect((await s3('GET', '/saved/gone.txt', undefined, second)).status).toBe(404);
    await second.stop();
    await rm(stateDir, { recursive: true, force: true });
  }, 60_000);

  it('refuses a second region on a store in use until the first stops', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'pocket-region-lock-'));
    const first = await createRegion({ store: directoryStore(stateDir) });
    await expect(createRegion({ store: directoryStore(stateDir) })).rejects.toThrow('in use by another region');
    expect((await s3('PUT', '/still-answering', undefined, first)).status).toBe(200);
    await first.stop();

    const second = await createRegion({ store: directoryStore(stateDir) });
    expect((await s3('HEAD', '/still-answering', undefined, second)).status).toBe(200);
    await second.stop();
    await rm(stateDir, { recursive: true, force: true });
  }, 60_000);

  it('releases the store when boot fails after taking it', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'pocket-region-failed-boot-'));
    const store = directoryStore(stateDir);
    // A file and a directory at one path, which boot fails to write into Pyodide's filesystem
    const clashing: StateStore = {
      ...store,
      load: async () => new Map([...(await store.load()), ['state', new Uint8Array()], ['state/sqs.json', new Uint8Array()]]),
    };
    await expect(createRegion({ store: clashing })).rejects.toMatchObject({ name: 'ErrnoError' });

    const next = directoryStore(stateDir);
    expect((await next.load()).size).toBe(0);
    await next.close?.();
    await rm(stateDir, { recursive: true, force: true });
  }, 60_000);

  it('loads a region an older MiniStack saved and refuses one a newer MiniStack saved', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'pocket-region-saved-by-'));
    const stamp = path.join(stateDir, 'saved-by.json');
    const first = await createRegion({ store: directoryStore(stateDir) });
    await s3('PUT', '/kept', undefined, first);
    await first.stop();
    const manifest: VendorManifest = JSON.parse(await readFile(new URL('../vendor/meta.json', import.meta.url), 'utf8'));
    expect(JSON.parse(await readFile(stamp, 'utf8')).ministack).toBe(emulatorVersion(manifest));

    await writeFile(stamp, JSON.stringify({ pocketRegion: '0.1.0', ministack: '1.0.0' }));
    const older = await createRegion({ store: directoryStore(stateDir) });
    expect((await s3('HEAD', '/kept', undefined, older)).status).toBe(200);
    await older.stop();

    await writeFile(stamp, JSON.stringify({ pocketRegion: '99.0.0', ministack: '99.0.0' }));
    const before = await readdir(stateDir, { recursive: true });
    await expect(createRegion({ store: directoryStore(stateDir) })).rejects.toThrow(
      'saved by Pocket Region 99.0.0 (MiniStack 99.0.0)',
    );
    expect(await readdir(stateDir, { recursive: true })).toEqual(before);
    expect(JSON.parse(await readFile(stamp, 'utf8')).ministack).toBe('99.0.0');
    // The refusal released the store
    const next = directoryStore(stateDir);
    expect((await next.load()).size).toBeGreaterThan(0);
    await next.close?.();
    await rm(stateDir, { recursive: true, force: true });
  }, 60_000);
});
