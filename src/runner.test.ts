import { afterAll, describe, expect, it, vi } from 'vitest';
import { createRunner, type RunnerOutput, type RunnerStatus } from './browser.ts';
import { s3 } from './test-clients.ts';
import { assetsBaseUrl, createTestRegion, indexURL } from './test-region.browser.ts';

// A snippet's worker imports by URL, so its modules come from jsDelivr at the site's versions
const versions: Record<string, string> = {
  '@aws-sdk/client-s3': '3.1131.0',
  '@xmldom/xmldom': '0.9.12',
  fflate: '0.8.2',
};
const resolve = (specifier: string) => `https://cdn.jsdelivr.net/npm/${specifier}@${versions[specifier]}/+esm`;
const boot = { assetsBaseUrl, indexURL };

const runner = createRunner({ boot, resolve });

afterAll(() => runner.stop());

async function run(code: string, target = runner) {
  const output: RunnerOutput[] = [];
  const statuses: RunnerStatus[] = [];
  const result = await target.run(code, { onOutput: (line) => output.push(line), onStatus: (status) => statuses.push(status) });
  return { result, output, statuses, text: output.map((line) => line.text) };
}

const listBuckets = `import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
const { Buckets } = await new S3Client({}).send(new ListBucketsCommand({}));
console.log(Buckets.map((bucket) => bucket.Name));`;

describe('createRunner', () => {
  it('runs code written for AWS against its own region, and resets it between runs', async () => {
    const first = await run(`import { S3Client, CreateBucketCommand, ListBucketsCommand } from '@aws-sdk/client-s3';
const s3 = new S3Client({});
await s3.send(new CreateBucketCommand({ Bucket: 'photos' }));
const { Buckets } = await s3.send(new ListBucketsCommand({}));
console.log(Buckets.map((bucket) => bucket.Name));`);
    expect(first.result.ok).toBe(true);
    expect(first.statuses).toEqual(['booting', 'running']);
    expect(first.text).toEqual(['[\n  "photos"\n]']);

    const second = await run(listBuckets);
    expect(second.statuses).toEqual(['resetting', 'running']);
    expect(second.text).toEqual(['[]']);
  }, 60_000);

  it("keeps what earlier runs made when reset is 'never'", async () => {
    const chained = createRunner({ boot, resolve, reset: 'never' });
    await run("import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';\nawait new S3Client({}).send(new CreateBucketCommand({ Bucket: 'step-one' }));", chained);
    const second = await run(listBuckets, chained);
    expect(second.statuses).toEqual(['running']);
    expect(second.text).toEqual(['[\n  "step-one"\n]']);
    await chained.stop();
  }, 60_000);

  it('separates log from error output, and leaves the page console alone', async () => {
    const log = vi.spyOn(console, 'log');
    const { output } = await run("console.log('out', 1, { a: 1 });\nconsole.warn('careful');\nconsole.error(new TypeError('bad'));");
    expect(output).toEqual([
      { stream: 'log', text: 'out 1 {\n  "a": 1\n}' },
      { stream: 'error', text: 'careful' },
      { stream: 'error', text: 'TypeError: bad' },
    ]);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('reports what a snippet throws, with the output before it', async () => {
    const { result, text } = await run("console.log('before');\nthrow new RangeError('broken');");
    expect(text).toEqual(['before']);
    expect(result).toMatchObject({ ok: false, error: expect.objectContaining({ name: 'RangeError', message: 'broken' }) });
  });

  it('refuses an import of pocket-region, and code it cannot run', async () => {
    const own = await run("import { createRegion } from 'pocket-region/browser';");
    expect(own.result).toMatchObject({ ok: false, error: expect.objectContaining({ message: expect.stringContaining("can't import pocket-region/browser") }) });
    const exported = await run('export const a = 1;');
    expect(exported.result).toMatchObject({ ok: false, error: expect.objectContaining({ message: expect.stringContaining('cannot export') }) });
  });

  it('prints a rejection nothing handles', async () => {
    const { result, output } = await run("Promise.reject('Region is missing');\nPromise.reject(new RangeError('lost'));\nawait new Promise((resolve) => setTimeout(resolve, 50));");
    expect(result.ok).toBe(true);
    expect(output).toEqual([
      { stream: 'error', text: 'Uncaught (in promise) Region is missing' },
      { stream: 'error', text: 'Uncaught (in promise) RangeError: lost' },
    ]);
  });

  it('runs one snippet at a time', async () => {
    const order: string[] = [];
    const slow = runner.run("await new Promise((resolve) => setTimeout(resolve, 50));\nconsole.log('slow');", { onOutput: ({ text }) => order.push(text) });
    const fast = runner.run("console.log('fast');", { onOutput: ({ text }) => order.push(text) });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['slow', 'fast']);
  });

  it('runs against a region the page made, and leaves it as it is', async () => {
    const made = await createTestRegion();
    await s3('PUT', '/before', undefined, made);
    const against = createRunner({ region: made, resolve });
    const { statuses, text } = await run(listBuckets, against);
    expect(statuses).toEqual(['running']);
    expect(text).toEqual(['[\n  "before"\n]']);
    await against.stop();
    expect((await s3('GET', '/before', undefined, made)).status).toBe(200);
    await made.stop();
  }, 60_000);

  it('keeps the name of an SDK error, and gives a snippet no DOM', async () => {
    const { result } = await run("import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';\nawait new S3Client({}).send(new GetObjectCommand({ Bucket: 'absent', Key: 'x' }));");
    expect(result).toMatchObject({ ok: false, error: expect.objectContaining({ name: 'NoSuchBucket' }) });
    expect((await run('console.log(typeof document, typeof window);')).text).toEqual(['undefined undefined']);
  }, 60_000);

  it('stops a run that never ends, and runs again after', async () => {
    const stuck = runner.run('for (;;) {}');
    await new Promise((resolve) => setTimeout(resolve, 200));
    await runner.stop();
    expect(await stuck).toMatchObject({ ok: false, error: expect.objectContaining({ message: 'stopped' }) });
    const after = await run("console.log('back');");
    expect(after.statuses).toEqual(['booting', 'running']);
    expect(after.text).toEqual(['back']);
  }, 60_000);

  it('says whether this page can run a region', () => {
    expect(runner.supported).toBe('Suspending' in WebAssembly);
  });
});
