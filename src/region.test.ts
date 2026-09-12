import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRegion, type Region } from './region.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const authorization = (service: string) =>
  `AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/${service}/aws4_request, SignedHeaders=host, Signature=test`;

let region: Region;

beforeAll(async () => {
  region = await createRegion();
}, 30_000);

afterAll(async () => {
  await region?.stop();
});

function s3On(target: Region, method: string, key: string, body?: string) {
  return target.dispatch({
    method,
    path: key,
    headers: { host: 'localhost:4566', authorization: authorization('s3') },
    body: body === undefined ? undefined : encoder.encode(body),
  });
}

function s3(method: string, key: string, body?: string) {
  return s3On(region, method, key, body);
}

async function jsonApiOn(
  target: Region,
  service: 'sqs' | 'dynamodb',
  operation: string,
  body: object,
) {
  const response = await target.dispatch({
    method: 'POST',
    path: '/',
    headers: {
      host: 'localhost:4566',
      authorization: authorization(service),
      'content-type': 'application/x-amz-json-1.0',
      'x-amz-target': operation,
    },
    body: encoder.encode(JSON.stringify(body)),
  });
  return { status: response.status, body: JSON.parse(decoder.decode(response.body)) };
}

function jsonApi(service: 'sqs' | 'dynamodb', operation: string, body: object) {
  return jsonApiOn(region, service, operation, body);
}

describe('createRegion', () => {
  it('lets Node exit once stopped', async () => {
    const module = JSON.stringify(new URL('./region.ts', import.meta.url).href);
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', `import { createRegion } from ${module}; await (await createRegion()).stop();`],
      { stdio: 'ignore', signal: AbortSignal.timeout(20_000) },
    );
    const [code] = await once(child, 'exit');
    expect(code).toBe(0);
  }, 30_000);

  it('round-trips an S3 object', async () => {
    expect((await s3('PUT', '/photos')).status).toBe(200);
    expect((await s3('PUT', '/photos/cat.txt', 'meow')).status).toBe(200);
    const read = await s3('GET', '/photos/cat.txt');
    expect(read.status).toBe(200);
    expect(decoder.decode(read.body)).toBe('meow');
  });

  it('round-trips an SQS message', async () => {
    const created = await jsonApi('sqs', 'AmazonSQS.CreateQueue', { QueueName: 'orders' });
    expect(created.status).toBe(200);
    const { QueueUrl } = created.body;
    expect(QueueUrl).toContain(':4566/');
    await jsonApi('sqs', 'AmazonSQS.SendMessage', { QueueUrl, MessageBody: 'one latte' });
    const received = await jsonApi('sqs', 'AmazonSQS.ReceiveMessage', { QueueUrl });
    expect(received.body.Messages.map((message: { Body: string }) => message.Body)).toEqual([
      'one latte',
    ]);
  });

  it('round-trips a DynamoDB item', async () => {
    const created = await jsonApi('dynamodb', 'DynamoDB_20120810.CreateTable', {
      TableName: 'users',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST',
    });
    expect(created.status).toBe(200);
    const item = { pk: { S: 'ada' }, name: { S: 'Ada Lovelace' } };
    await jsonApi('dynamodb', 'DynamoDB_20120810.PutItem', { TableName: 'users', Item: item });
    const read = await jsonApi('dynamodb', 'DynamoDB_20120810.GetItem', {
      TableName: 'users',
      Key: { pk: { S: 'ada' } },
    });
    expect(read.body.Item).toEqual(item);
  });

  it('saves state that a later region reads back', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'pocket-region-state-'));
    const first = await createRegion({ stateDir });
    await s3On(first, 'PUT', '/saved');
    await s3On(first, 'PUT', '/saved/keep.txt', 'kept');
    await s3On(first, 'PUT', '/saved/gone.txt', 'deleted after the first save');
    await first.save();
    expect((await readdir(stateDir, { recursive: true })).length).toBeGreaterThan(0);
    await s3On(first, 'DELETE', '/saved/gone.txt');
    await first.stop();

    const second = await createRegion({ stateDir });
    const kept = await s3On(second, 'GET', '/saved/keep.txt');
    expect(kept.status).toBe(200);
    expect(decoder.decode(kept.body)).toBe('kept');
    expect((await s3On(second, 'GET', '/saved/gone.txt')).status).toBe(404);
    await second.stop();
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
    const second = await createRegion({ stateDir, onOutput: (line) => output.push(line) });
    expect(output.join('\n')).toContain('sqs.json was not loaded');
    const lookup = await jsonApiOn(second, 'sqs', 'AmazonSQS.GetQueueUrl', {
      QueueName: 'from-the-future',
    });
    expect(lookup.status).toBe(400);
    await second.save();
    await second.stop();

    const kept = await readFile(`${file}.refused`, 'utf8');
    expect(JSON.parse(kept).__ministack_format__).toBe(99);
    expect(kept).toContain('from-the-future');
    await rm(stateDir, { recursive: true, force: true });
  }, 60_000);
});
