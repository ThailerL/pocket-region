import { afterAll, describe, expect, it, vi } from 'vitest';
import { createRunner, type RunnerOutput, type RunnerStatus } from './browser.ts';
import { assetsBaseUrl, indexURL } from './test-region.browser.ts';

const modules: Record<string, () => Promise<object>> = {
  '@aws-sdk/client-s3': () => import('@aws-sdk/client-s3'),
  '@aws-sdk/client-sqs': () => import('@aws-sdk/client-sqs'),
  fflate: () => import('fflate'),
};

const load = (specifier: string) => modules[specifier]!();
const region = { assetsBaseUrl, indexURL };

const runner = createRunner({ region, load });

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
    const chained = createRunner({ region, load, reset: 'never' });
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

  it("leaves a snippet that brings its own region to it, and boots nothing for it", async () => {
    const own = createRunner({ load });
    const { result, statuses, text } = await run(
      `import { createRegion, requestHandler } from 'pocket-region/browser';
import { SQSClient, CreateQueueCommand } from '@aws-sdk/client-sqs';
const region = await createRegion({ assetsBaseUrl: '${assetsBaseUrl}', indexURL: '${indexURL}' });
const sqs = new SQSClient({ region: 'us-east-1', credentials: { accessKeyId: 'a', secretAccessKey: 'a' }, requestHandler: requestHandler(region) });
const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: 'own' }));
console.log(QueueUrl);
await region.stop();`,
      own,
    );
    expect(result.ok).toBe(true);
    expect(statuses).toEqual(['running']);
    expect(text[0]).toMatch(/\/own$/);
    await own.stop();
  }, 60_000);

  it('refuses the Node entry, and code it cannot run', async () => {
    const node = await run("import { createRegion } from 'pocket-region/node';");
    expect(node.result).toMatchObject({ ok: false, error: expect.objectContaining({ message: expect.stringContaining('import pocket-region/browser') }) });
    const exported = await run('export const a = 1;');
    expect(exported.result).toMatchObject({ ok: false, error: expect.objectContaining({ message: expect.stringContaining('cannot export') }) });
  });

  it('runs one snippet at a time', async () => {
    const order: string[] = [];
    const slow = runner.run("await new Promise((resolve) => setTimeout(resolve, 50));\nconsole.log('slow');", { onOutput: ({ text }) => order.push(text) });
    const fast = runner.run("console.log('fast');", { onOutput: ({ text }) => order.push(text) });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['slow', 'fast']);
  });

  it('says whether this page can run a region', () => {
    expect(runner.supported).toBe('Suspending' in WebAssembly);
  });
});
