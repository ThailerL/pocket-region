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

  const createBucket = (name: string) =>
    `import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';\nawait new S3Client({}).send(new CreateBucketCommand({ Bucket: '${name}' }));`;

  it('runs setup on the region whenever it is empty, and hides what setup prints', async () => {
    const prepared = createRunner({ boot, resolve, setup: `console.log('preparing');\n${createBucket('fixture')}` });
    const first = await run(listBuckets, prepared);
    expect(first.statuses).toEqual(['booting', 'setting-up', 'running']);
    expect(first.text).toEqual(['[\n  "fixture"\n]']);
    await run(createBucket('extra'), prepared);
    const third = await run(listBuckets, prepared);
    expect(third.statuses).toEqual(['resetting', 'setting-up', 'running']);
    expect(third.text).toEqual(['[\n  "fixture"\n]']);
    const refused = await run("import { createRegion } from 'pocket-region/browser';", prepared);
    expect(refused.result).toMatchObject({ ok: false, error: expect.objectContaining({ message: expect.stringContaining("can't import") }) });
    expect((await run(listBuckets, prepared)).text).toEqual(['[\n  "fixture"\n]']);
    await prepared.stop();
  }, 60_000);

  it("runs setup once when reset is 'never'", async () => {
    const prepared = createRunner({ boot, resolve, reset: 'never', setup: createBucket('fixture') });
    await run(createBucket('extra'), prepared);
    const second = await run(listBuckets, prepared);
    expect(second.statuses).toEqual(['running']);
    expect(second.text).toEqual(['[\n  "extra",\n  "fixture"\n]']);
    await prepared.stop();
  }, 60_000);

  it('shows what a failed setup printed, and empties the region before setup runs again', async () => {
    const setup = `import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
globalThis.attempt = (globalThis.attempt ?? 0) + 1;
await new S3Client({}).send(new CreateBucketCommand({ Bucket: \`try-\${globalThis.attempt}\` }));
console.log('attempt', globalThis.attempt);
if (globalThis.attempt === 1) throw new Error('no table');`;
    const prepared = createRunner({ boot, resolve, reset: 'never', setup });
    const failed = await run("console.log('never printed');", prepared);
    expect(failed.result).toMatchObject({ ok: false, error: expect.objectContaining({ message: 'setup failed: no table' }) });
    expect(failed.text).toEqual(['attempt 1']);
    const retried = await run(listBuckets, prepared);
    expect(retried.statuses).toEqual(['resetting', 'setting-up', 'running']);
    expect(retried.text).toEqual(['[\n  "try-2"\n]']);
    await prepared.stop();
  }, 60_000);

  it('separates stdout from stderr, and leaves the page console alone', async () => {
    const log = vi.spyOn(console, 'log');
    const { output } = await run("console.log('out', 1, { a: 1 });\nconsole.warn('careful');\nconsole.error(new TypeError('bad'));");
    expect(output).toEqual([
      { method: 'log', stream: 'stdout', text: 'out 1 {\n  "a": 1\n}', values: ['out', 1, { a: 1 }] },
      { method: 'warn', stream: 'stderr', text: 'careful', values: ['careful'] },
      { method: 'error', stream: 'stderr', text: 'TypeError: bad', values: [new TypeError('bad')] },
    ]);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('passes what a snippet logs as values, and the text of what it cannot copy', async () => {
    const { output } = await run(
      "console.log(new Set(['a']), new Date(0), new Uint8Array([1, 2]), 10n, { items: new Map([['k', 1]]) });\nconsole.log({ send() {} }, 'next');",
    );
    expect(output[0].values).toEqual([new Set(['a']), new Date(0), new Uint8Array([1, 2]), 10n, { items: new Map([['k', 1]]) }]);
    expect(output[1].values).toEqual(['{}', 'next']);
  });

  it('passes console.table and console.dir on with their method', async () => {
    const { output } = await run("console.table([{ title: 'IT' }]);\nconsole.dir({ a: 1 });");
    expect(output.map(({ method, stream, values }) => ({ method, stream, values }))).toEqual([
      { method: 'table', stream: 'stdout', values: [[{ title: 'IT' }]] },
      { method: 'dir', stream: 'stdout', values: [{ a: 1 }] },
    ]);
    expect(output[0].text).toContain('│ 0       │ IT    │');
  });

  it('reports what a snippet throws, with the output before it', async () => {
    const { result, text } = await run("console.log('before');\nthrow new RangeError('broken');");
    expect(text).toEqual(['before']);
    expect(result).toMatchObject({ ok: false, error: expect.objectContaining({ name: 'RangeError', message: 'broken' }) });
  });

  it('runs TypeScript, and reports where a snippet fails to parse', async () => {
    const { result, text } = await run(`import type { ListBucketsCommandOutput } from '@aws-sdk/client-s3';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
enum Unit { Bucket = 'bucket' }
const out = (await new S3Client({}).send(new ListBucketsCommand({}))) as ListBucketsCommandOutput;
console.log(\`\${out.Buckets!.length} \${Unit.Bucket}s\` satisfies string);`);
    expect(result.ok).toBe(true);
    expect(text).toEqual(['0 buckets']);
    const broken = await run('const x: = 1;');
    expect(broken.result).toMatchObject({ ok: false, error: expect.objectContaining({ message: expect.stringContaining('(1:10)') }) });
  }, 60_000);

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
      { method: 'error', stream: 'stderr', text: 'Uncaught (in promise) Region is missing', values: ['Uncaught (in promise)', 'Region is missing'] },
      { method: 'error', stream: 'stderr', text: 'Uncaught (in promise) RangeError: lost', values: ['Uncaught (in promise)', new RangeError('lost')] },
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
    // @ts-expect-error a region passed in is never reset
    createRunner({ region: made, reset: 'each-run' });
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
