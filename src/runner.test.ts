import { afterAll, describe, expect, it, vi } from 'vitest';
import { createRunner, type JavaScriptOutput, type Language, type PythonOutput, type RunnerOutput, type RunnerPhase } from './browser.ts';
import { s3 } from './test-clients.ts';
import { assetsBaseUrl, createTestRegion, indexURL } from './test-region.browser.ts';

// A snippet's worker imports by URL, so its modules come from jsDelivr at the site's versions
const versions: Record<string, string> = {
  '@aws-sdk/client-s3': '3.1131.0',
  '@xmldom/xmldom': '0.9.12',
  fflate: '0.8.2',
};
const resolve = (specifier: string) => (specifier.startsWith('data:') ? specifier : `https://cdn.jsdelivr.net/npm/${specifier}@${versions[specifier]}/+esm`);
const boot = { assetsBaseUrl, indexURL, resolve };

const runner = createRunner({ boot });

afterAll(() => runner.stop());

async function run(code: string, target = runner, language: Language = 'javascript') {
  const output: RunnerOutput[] = [];
  const statuses: RunnerPhase[] = [];
  const result = await target.run(code, { language, onOutput: (line) => output.push(line), onStatus: ({ phase }) => statuses.push(phase) });
  return { result, output, statuses, text: output.map((line) => line.text) };
}

const python = async (code: string, target = runner) => {
  const ran = await run(code, target, 'python');
  return { ...ran, output: ran.output as PythonOutput[] };
};

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
    const chained = createRunner({ boot, reset: 'never' });
    await run("import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';\nawait new S3Client({}).send(new CreateBucketCommand({ Bucket: 'step-one' }));", chained);
    const second = await run(listBuckets, chained);
    expect(second.statuses).toEqual(['running']);
    expect(second.text).toEqual(['[\n  "step-one"\n]']);
    await chained.stop();
  }, 60_000);

  const createBucket = (name: string) =>
    `import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';\nawait new S3Client({}).send(new CreateBucketCommand({ Bucket: '${name}' }));`;

  it('runs setup on the region whenever it is empty, and hides what setup prints', async () => {
    const prepared = createRunner({ boot, setup: `console.log('preparing');\n${createBucket('fixture')}` });
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

  it('runs setup given as a function of the region, on the page', async () => {
    let attempts = 0;
    const prepared = createRunner({
      boot,
      async setup(region) {
        attempts += 1;
        if (attempts === 1) throw new Error('not yet');
        await s3('PUT', '/fixture', undefined, region);
      },
    });
    const failed = await run(listBuckets, prepared);
    expect(failed.result).toMatchObject({ ok: false, error: expect.objectContaining({ message: 'setup failed: not yet' }) });
    const retried = await run(listBuckets, prepared);
    expect(retried.statuses).toEqual(['resetting', 'setting-up', 'running']);
    expect(retried.text).toEqual(['[\n  "fixture"\n]']);
    await prepared.stop();
  }, 60_000);

  it("runs setup once when reset is 'never'", async () => {
    const prepared = createRunner({ boot, reset: 'never', setup: createBucket('fixture') });
    await run(createBucket('extra'), prepared);
    const second = await run(listBuckets, prepared);
    expect(second.statuses).toEqual(['running']);
    expect(second.text).toEqual(['[\n  "extra",\n  "fixture"\n]']);
    await prepared.stop();
  }, 60_000);

  it('shows what a failed setup printed, and empties the region before setup runs again', async () => {
    // A module lives as long as the worker, where a snippet's globals don't outlive a fresh run
    const setup = `import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { bump } from 'data:text/javascript,let n = 0; export const bump = () => ++n';
const attempt = bump();
await new S3Client({}).send(new CreateBucketCommand({ Bucket: \`try-\${attempt}\` }));
console.log('attempt', attempt);
if (attempt === 1) throw new Error('no table');`;
    const prepared = createRunner({ boot, reset: 'never', setup });
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
      { language: 'javascript', method: 'log', stream: 'stdout', text: 'out 1 {\n  "a": 1\n}', values: ['out', 1, { a: 1 }], line: 1 },
      { language: 'javascript', method: 'warn', stream: 'stderr', text: 'careful', values: ['careful'], line: 2 },
      { language: 'javascript', method: 'error', stream: 'stderr', text: 'TypeError: bad', values: [new TypeError('bad')], line: 3 },
    ]);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('passes what a snippet logs as values, and the text of what it cannot copy', async () => {
    const { output } = await run(
      "console.log(new Set(['a']), new Date(0), new Uint8Array([1, 2]), 10n, { items: new Map([['k', 1]]) });\nconsole.log({ send() {} }, 'next');",
    );
    const [first, second] = output as JavaScriptOutput[];
    expect([first.line, second.line]).toEqual([1, 2]);
    expect(first.values).toEqual([new Set(['a']), new Date(0), new Uint8Array([1, 2]), 10n, { items: new Map([['k', 1]]) }]);
    expect(second.values).toEqual(['{}', 'next']);
  });

  it('passes console.table and console.dir on with their method', async () => {
    const output = (await run("console.table([{ title: 'IT' }]);\nconsole.dir({ a: 1 });")).output as JavaScriptOutput[];
    expect(output.map(({ method, stream, values }) => ({ method, stream, values }))).toEqual([
      { method: 'table', stream: 'stdout', values: [[{ title: 'IT' }]] },
      { method: 'dir', stream: 'stdout', values: [{ a: 1 }] },
    ]);
    expect(output[0].text).toContain('│ 0       │ IT    │');
  });

  it('reports what a snippet throws, with the output before it and the line', async () => {
    const { result, text } = await run("console.log('before');\nthrow new RangeError('broken');");
    expect(text).toEqual(['before']);
    expect(result).toMatchObject({ ok: false, error: expect.objectContaining({ name: 'RangeError', message: 'broken', line: 2 }) });
  });

  it('clears what a snippet left on the global object before a fresh run, and keeps it while the region keeps its state', async () => {
    await run('globalThis.leak = 1;');
    expect((await run('console.log(typeof leak);')).text).toEqual(['undefined']);
    await run('globalThis.leak = 1;');
    const kept = await runner.run('console.log(typeof leak);', { reset: 'never', onOutput: (line) => expect(line.text).toBe('number') });
    expect(kept.ok).toBe(true);
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
      { language: 'javascript', method: 'error', stream: 'stderr', text: 'Uncaught (in promise) Region is missing', values: ['Uncaught (in promise)', 'Region is missing'] },
      { language: 'javascript', method: 'error', stream: 'stderr', text: 'Uncaught (in promise) RangeError: lost', values: ['Uncaught (in promise)', new RangeError('lost')] },
    ]);
    expect(output.every((line) => line.line === undefined)).toBe(true);
  });

  it('runs one snippet at a time', async () => {
    const order: string[] = [];
    const slow = runner.run("await new Promise((resolve) => setTimeout(resolve, 50));\nconsole.log('slow');", { onOutput: ({ text }) => order.push(text) });
    const fast = runner.run("console.log('fast');", { onOutput: ({ text }) => order.push(text) });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['slow', 'fast']);
  });

  it('runs against a region the page made, and leaves it as it is', async () => {
    const made = await createTestRegion({ resolve });
    await s3('PUT', '/before', undefined, made);
    const against = createRunner({ region: made });
    const { statuses, text } = await run(listBuckets, against);
    expect(statuses).toEqual(['running']);
    expect(text).toEqual(['[\n  "before"\n]']);
    await against.stop();
    expect((await s3('GET', '/before', undefined, made)).status).toBe(200);
    await made.stop();
  }, 60_000);

  it("loads a snippet's imports from where the region it runs against says", async () => {
    const greeting = `data:text/javascript,${encodeURIComponent("export const greeting = 'from the region';")}`;
    const made = await createTestRegion({ resolve: (specifier) => (specifier === 'greeting' ? greeting : resolve(specifier)) });
    const against = createRunner({ region: made });
    const { text } = await run("import { greeting } from 'greeting';\nconsole.log(greeting);", against);
    expect(text).toEqual(['from the region']);
    await against.stop();
    await made.stop();
  }, 60_000);

  it('empties a region the page made before every run when asked, and sets it up', async () => {
    const made = await createTestRegion({ resolve });
    await s3('PUT', '/before', undefined, made);
    const against = createRunner({ region: made, reset: 'each-run', setup: createBucket('fixture') });
    const first = await run(listBuckets, against);
    expect(first.statuses).toEqual(['resetting', 'setting-up', 'running']);
    expect(first.text).toEqual(['[\n  "fixture"\n]']);
    await run(createBucket('extra'), against);
    expect((await run(listBuckets, against)).text).toEqual(['[\n  "fixture"\n]']);
    await against.stop();
    expect((await s3('GET', '/fixture', undefined, made)).status).toBe(200);
    await made.stop();
  }, 60_000);

  it('sets up a region the page made once, as it is', async () => {
    const made = await createTestRegion({ resolve });
    await s3('PUT', '/before', undefined, made);
    const against = createRunner({ region: made, setup: createBucket('fixture') });
    const first = await run(listBuckets, against);
    expect(first.statuses).toEqual(['setting-up', 'running']);
    expect(first.text).toEqual(['[\n  "before",\n  "fixture"\n]']);
    const second = await run(listBuckets, against);
    expect(second.statuses).toEqual(['running']);
    await against.stop();
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

describe('createRunner with Python', () => {
  const listBucketsPy = "import boto3\n\nprint([bucket['Name'] for bucket in boto3.client('s3').list_buckets()['Buckets']])";

  it('runs boto3 code written for AWS against the region JavaScript shares', async () => {
    const chained = createRunner({ boot, reset: 'never' });
    const first = await python("import boto3\n\ns3 = boto3.client('s3')\ns3.create_bucket(Bucket='photos')\nprint([bucket['Name'] for bucket in s3.list_buckets()['Buckets']])", chained);
    expect(first.result.ok).toBe(true);
    expect(first.statuses).toEqual(['booting', 'running']);
    expect(first.output).toEqual([{ language: 'python', stream: 'stdout', text: "['photos']", line: 5 }]);
    const second = await run(listBuckets, chained);
    expect(second.statuses).toEqual(['running']);
    expect(second.text).toEqual(['[\n  "photos"\n]']);
    // The names too, as one session continued across fences
    expect((await python('print(s3.list_buckets()["Buckets"][0]["Name"])', chained)).text).toEqual(['photos']);
    await chained.stop();
  }, 120_000);

  it('echoes as the interpreter would when asked, with the lines as given', async () => {
    const output: PythonOutput[] = [];
    const result = await runner.run(
      `import boto3
s3 = boto3.client('s3')
for name in ['alpha', 'beta']:
    s3.create_bucket(Bucket=name)['ResponseMetadata']['HTTPStatusCode']

len(s3.list_buckets()['Buckets'])
print('done'); None; 'quoted'
s3.get_object(Bucket='alpha', Key='missing')`,
      { language: 'python', echo: true, onOutput: (line) => output.push(line as PythonOutput) },
    );
    expect(output.map(({ text, line }) => [text, line])).toEqual([['200', 4], ['200', 4], ['2', 6], ['done', 7], ["'quoted'", 7]]);
    expect(result).toMatchObject({
      ok: false,
      error: expect.objectContaining({ name: 'NoSuchKey', message: expect.stringContaining('GetObject'), line: 8, stack: expect.stringMatching(/^Traceback[\s\S]*"<snippet>", line 8/) }),
    });
    const refused = await runner.run('1 + 1', { echo: true });
    expect(refused).toMatchObject({ ok: false, error: expect.objectContaining({ message: expect.stringContaining('echo is not supported for JavaScript') }) });
  }, 120_000);

  it('reports what a script raises, with its traceback as the stack, and code it cannot parse', async () => {
    const { result, output } = await python("print('before')\nraise ValueError('bad')");
    expect(result).toMatchObject({ ok: false, error: expect.objectContaining({ name: 'ValueError', message: 'bad', line: 2, stack: expect.stringMatching(/^Traceback[\s\S]*line 2[\s\S]*ValueError: bad\n$/) }) });
    expect(output).toEqual([{ language: 'python', stream: 'stdout', text: 'before', line: 1 }]);
    expect((await python('x = 1')).result.ok).toBe(true);
    expect((await python('print(x)')).result).toMatchObject({ ok: false, error: expect.objectContaining({ name: 'NameError' }) });
    const broken = await python('x = 1\ny = = 1');
    expect(broken.result).toMatchObject({ ok: false, error: expect.objectContaining({ name: 'SyntaxError', line: 2 }) });
    expect(broken.output).toEqual([]);
    const partial = await python("import sys\nsys.stdout.write('no newline')");
    expect(partial.output).toEqual([{ language: 'python', stream: 'stdout', text: 'no newline' }]);
  }, 120_000);

  it('continues from the previous run when that run asks, keeping the names too', async () => {
    expect((await python('x = 1')).result.ok).toBe(true);
    const output: RunnerOutput[] = [];
    const continued = await runner.run('print(x)', { language: 'python', reset: 'never', onOutput: (line) => output.push(line) });
    expect(continued.ok).toBe(true);
    expect(output.map((line) => line.text)).toEqual(['1']);
    expect((await python('print(x)')).result).toMatchObject({ ok: false, error: expect.objectContaining({ name: 'NameError' }) });
  }, 120_000);

  it('runs setup written in Python before a JavaScript snippet', async () => {
    const prepared = createRunner({ boot, setup: { language: 'python', code: "import boto3\nname = 'fixture'\nboto3.client('s3').create_bucket(Bucket=name)\nprint('hidden')" } });
    const first = await run(listBuckets, prepared);
    expect(first.statuses).toEqual(['booting', 'setting-up', 'running']);
    expect(first.text).toEqual(['[\n  "fixture"\n]']);
    expect((await python(listBucketsPy, prepared)).text).toEqual(["['fixture']"]);
    // Setup prepares the region, not the snippet's names
    expect((await python('print(name)', prepared)).result).toMatchObject({ ok: false, error: expect.objectContaining({ name: 'NameError' }) });
    await prepared.stop();
  }, 120_000);

  it('stops a Python run that never ends, and runs again after', async () => {
    const stuck = runner.run('while True: pass', { language: 'python' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await runner.stop();
    expect(await stuck).toMatchObject({ ok: false, error: expect.objectContaining({ message: 'stopped' }) });
    const after = await python("print('back')");
    expect(after.statuses).toEqual(['booting', 'running']);
    expect(after.text).toEqual(['back']);
  }, 120_000);
});
