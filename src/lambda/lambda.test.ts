import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { crc32 } from 'node:zlib';
import {
  CreateFunctionCommand,
  InvokeCommand,
  LambdaClient,
  PutFunctionConcurrencyCommand,
  ResourceNotFoundException,
  TooManyRequestsException,
} from '@aws-sdk/client-lambda';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRegion as createPageRegion, type PageRegion } from '../browser.ts';
import { createRegion } from '../node.ts';
import { requestHandler } from '../request-handler.ts';
import { serve } from '../server.ts';
import { authorization, clientConfig, freePort, installWorkerShim, serveVendor } from '../test-support.ts';

const decoder = new TextDecoder();

// A stored zip of one file: enough for a deployment package, without a zip dependency
function zipOf(name: string, content: string) {
  const data = Buffer.from(content);
  const fileName = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + fileName.length, 12);
  end.writeUInt32LE(30 + fileName.length + data.length, 16);
  return Buffer.concat([local, fileName, data, central, fileName, end]);
}

const HANDLER = `
let calls = 0;
export const handler = async (event, context) => {
  calls++;
  console.log('handling ' + JSON.stringify(event));
  if (event.throw) throw new Error('handler failed');
  if (event.sleep) await new Promise((resolve) => setTimeout(resolve, event.sleep));
  if (event.bucket) {
    const url = process.env.AWS_ENDPOINT_URL + '/' + event.bucket;
    const response = await fetch(url, { method: 'PUT', headers: { authorization: ${JSON.stringify(authorization('s3'))} } });
    return { created: response.status };
  }
  return { calls, functionName: context.functionName, remaining: context.getRemainingTimeInMillis() > 0, event };
};
`;

let region: PageRegion;
let vendor: Awaited<ReturnType<typeof serveVendor>> | undefined;
let lambda: LambdaClient;
let s3: S3Client;

// The same handler, unbundled, runs on both hosts: fetch and process.env are all it needs
const HOSTS: [string, () => Promise<PageRegion>][] = [
  ['in Node', async () => createRegion({ port: await freePort() })],
  [
    'in a page',
    async () => {
      installWorkerShim();
      vendor = await serveVendor();
      return createPageRegion(vendor);
    },
  ],
];

const createFunction = (FunctionName: string, extra: object = {}, code = HANDLER, client = lambda) =>
  client.send(
    new CreateFunctionCommand({
      FunctionName,
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
      Role: 'arn:aws:iam::000000000000:role/lambda',
      Code: { ZipFile: zipOf('index.mjs', code) },
      ...extra,
    }),
  );

async function invoke(FunctionName: string, event: object, extra: object = {}, client = lambda) {
  const response = await client.send(
    new InvokeCommand({ FunctionName, Payload: JSON.stringify(event), ...extra }),
  );
  return {
    status: response.StatusCode,
    error: response.FunctionError,
    payload: response.Payload ? JSON.parse(decoder.decode(response.Payload)) : undefined,
    log: response.LogResult ? Buffer.from(response.LogResult, 'base64').toString() : undefined,
  };
}

describe.each(HOSTS)('Lambda %s', (_, boot) => {
  beforeAll(async () => {
    region = await boot();
    const config = clientConfig({ requestHandler: requestHandler(region) });
    // One attempt, so a throttle is seen rather than retried until it clears
    lambda = new LambdaClient({ ...config, maxAttempts: 1 });
    s3 = new S3Client({ ...config, forcePathStyle: true });
  }, 60_000);

  afterAll(async () => {
    await region?.stop();
    vendor?.close();
  });

  it('runs a function created with the SDK, warm on the second call', async () => {
    await createFunction('echo');
    const first = await invoke('echo', { hello: 'world' });
    expect(first.status).toBe(200);
    expect(first.error).toBeUndefined();
    expect(first.payload).toEqual({ calls: 1, functionName: 'echo', remaining: true, event: { hello: 'world' } });
    expect((await invoke('echo', {})).payload.calls).toBe(2);
  }, 30_000);

  it('answers ResourceNotFoundException for an unknown function', async () => {
    await expect(invoke('absent', {})).rejects.toBeInstanceOf(ResourceNotFoundException);
  });

  it('lets a handler call the region while its own invocation is pending', async () => {
    expect((await invoke('echo', { bucket: 'made-by-lambda' })).payload).toEqual({ created: 200 });
    await expect(s3.send(new HeadBucketCommand({ Bucket: 'made-by-lambda' }))).resolves.toBeDefined();
  });

  it('reports a thrown handler as an unhandled function error', async () => {
    const thrown = await invoke('echo', { throw: true });
    expect(thrown.status).toBe(200);
    expect(thrown.error).toBe('Unhandled');
    expect(thrown.payload).toMatchObject({ errorType: 'Error', errorMessage: 'handler failed' });
  });

  it("returns the handler's log with LogType Tail", async () => {
    const tailed = await invoke('echo', { tail: 1 }, { LogType: 'Tail' });
    expect(tailed.log).toContain('handling {"tail":1}');
  });

  it('times out with Lambda’s message, and the next invocation still runs', async () => {
    await createFunction('slow', { Timeout: 1 });
    const late = await invoke('slow', { sleep: 1500 });
    expect(late.error).toBe('Unhandled');
    expect(late.payload).toEqual({ errorType: 'Sandbox.Timedout', errorMessage: 'Task timed out after 1.00 seconds' });
    // A fresh environment: the timed-out one was not reused
    expect((await invoke('slow', {})).payload.calls).toBe(1);
  }, 30_000);

  it('throttles past the reserved concurrency', async () => {
    await createFunction('single');
    await lambda.send(
      new PutFunctionConcurrencyCommand({ FunctionName: 'single', ReservedConcurrentExecutions: 1 }),
    );
    const outcomes = await Promise.allSettled([
      invoke('single', { sleep: 500 }),
      invoke('single', { sleep: 500 }),
    ]);
    const refused = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toBeInstanceOf(TooManyRequestsException);
  }, 30_000);

  it('accepts an Event invocation before the handler runs it', async () => {
    const accepted = await invoke('echo', { bucket: 'made-asynchronously' }, { InvocationType: 'Event' });
    expect(accepted.status).toBe(202);
    await expect.poll(() => s3.send(new HeadBucketCommand({ Bucket: 'made-asynchronously' })).then(() => true, () => false), { timeout: 10_000 }).toBe(true);
  });

  it('refuses a runtime it cannot run', async () => {
    await createFunction('snake', { Runtime: 'python3.12', Handler: 'index.handler' }, 'def handler(e, c): return 1');
    const refused = await invoke('snake', {});
    expect(refused.error).toBe('Unhandled');
    expect(refused.payload.errorMessage).toContain('python3.12');
  });

  it('fails an invocation whose handler cannot load', async () => {
    await createFunction('broken', {}, 'export const notHandler = 1');
    const failed = await invoke('broken', {});
    expect(failed.error).toBe('Unhandled');
    expect(failed.payload.errorMessage).toContain('does not export a function named "handler"');
  });
});

describe('Lambda in Node', () => {
  // The host serves the region itself, but a caller may already have
  it('shares the port with a server the caller started', async () => {
    const shared = await createRegion({ port: await freePort() });
    const server = await serve(shared);
    const own = new LambdaClient(clientConfig({ requestHandler: requestHandler(shared) }));
    await createFunction('echo', {}, HANDLER, own);
    expect((await invoke('echo', { bucket: 'shared' }, {}, own)).payload).toEqual({ created: 200 });
    await shared.stop();
    await server.close();
  }, 30_000);

  // In a process of its own, where nothing but the region can keep Node running
  async function runAlone(code: string, expected: string) {
    const module = JSON.stringify(new URL('../node.ts', import.meta.url).href);
    const zip = JSON.stringify(zipOf('index.mjs', code).toString('base64'));
    const script = `
      import { createRegion } from ${module};
      const region = await createRegion();
      const call = (method, path, body) => region.dispatch({ method, path, headers: { host: 'localhost:4566', authorization: ${JSON.stringify(authorization('lambda'))}, 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(body)) });
      await call('POST', '/2015-03-31/functions', { FunctionName: 'one', Runtime: 'nodejs22.x', Handler: 'index.handler', Role: 'r', Code: { ZipFile: ${zip} } });
      const invoked = new TextDecoder().decode((await call('POST', '/2015-03-31/functions/one/invocations', {})).body);
      if (!invoked.includes(${JSON.stringify(expected)})) throw new Error('unexpected ' + invoked);
      await region.stop();
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
      signal: AbortSignal.timeout(30_000),
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const [exitCode] = await once(child, 'exit');
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  }

  it('lets Node exit once a region that ran a function is stopped', async () => {
    await runAlone('export const handler = async () => 1', '1');
  }, 40_000);

  // An environment that dies without a word, as it does when its runtime cannot be found
  it('keeps Node running until an environment that died starting has been answered for', async () => {
    await runAlone('process.exit(3);', 'stopped before it asked for an invocation');
  }, 40_000);
});
