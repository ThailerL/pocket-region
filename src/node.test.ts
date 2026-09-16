import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRegion, directoryStore, type StateStore } from './node.ts';
import { jsonApi, s3 } from './test-clients.ts';

const decoder = new TextDecoder();

describe('createRegion', () => {
  it('lets Node exit once stopped', async () => {
    const module = JSON.stringify(new URL('./node.ts', import.meta.url).href);
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', `import { createRegion } from ${module}; await (await createRegion()).stop();`],
      { stdio: 'ignore', signal: AbortSignal.timeout(20_000) },
    );
    const [code] = await once(child, 'exit');
    expect(code).toBe(0);
  }, 30_000);

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

  it('keeps a state file it cannot read instead of saving over it', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'pocket-region-refused-'));
    // Stamped by a release this build does not understand, which it refuses to load
    const file = path.join(stateDir, 'state', 'sqs.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ __ministack_format__: 99, payload: { queues: 'from-the-future' } }),
    );

    const output: string[] = [];
    const second = await createRegion({ store: directoryStore(stateDir), onOutput: ({ text }) => output.push(text) });
    expect(output.join('\n')).toContain('sqs.json was not loaded');
    const lookup = await jsonApi(
      'sqs',
      'AmazonSQS.GetQueueUrl',
      { QueueName: 'from-the-future' },
      second,
    );
    expect(lookup.status).toBe(400);
    await second.save();
    await second.stop();

    const kept = await readFile(`${file}.refused`, 'utf8');
    expect(JSON.parse(kept).__ministack_format__).toBe(99);
    expect(kept).toContain('from-the-future');
    await rm(stateDir, { recursive: true, force: true });
  }, 60_000);
});
