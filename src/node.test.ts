import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRegion, type Region } from './node.ts';
import { authorization } from './test-support.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let region: Region;

beforeAll(async () => {
  region = await createRegion();
}, 30_000);

afterAll(async () => {
  await region?.stop();
});

// The region defaults at call time, once beforeAll has booted it
function s3(method: string, key: string, body?: string, target: Region = region) {
  return target.dispatch({
    method,
    path: key,
    headers: { host: 'localhost:4566', authorization: authorization('s3') },
    body: body === undefined ? undefined : encoder.encode(body),
  });
}

async function jsonApi(
  service: 'sqs' | 'dynamodb',
  operation: string,
  body: object,
  target: Region = region,
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

  it('resets to empty, and the same names can be used again', async () => {
    const fresh = await createRegion();
    const fifo = async () => {
      const { body } = await jsonApi(
        'sqs',
        'AmazonSQS.CreateQueue',
        { QueueName: 'orders.fifo', Attributes: { FifoQueue: 'true' } },
        fresh,
      );
      await jsonApi(
        'sqs',
        'AmazonSQS.SendMessage',
        { QueueUrl: body.QueueUrl, MessageBody: 'latte', MessageGroupId: 'g', MessageDeduplicationId: 'once' },
        fresh,
      );
      return body.QueueUrl;
    };
    const table = () =>
      jsonApi(
        'dynamodb',
        'DynamoDB_20120810.CreateTable',
        {
          TableName: 'users',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
          BillingMode: 'PAY_PER_REQUEST',
        },
        fresh,
      );

    await s3('PUT', '/photos', undefined, fresh);
    await s3('PUT', '/photos/cat.txt', 'meow', fresh);
    await fifo();
    await table();
    await jsonApi('dynamodb', 'DynamoDB_20120810.PutItem', { TableName: 'users', Item: { pk: { S: 'ada' } } }, fresh);

    await fresh.reset();

    expect(decoder.decode((await s3('GET', '/', undefined, fresh)).body)).not.toContain('<Name>');
    expect((await jsonApi('sqs', 'AmazonSQS.ListQueues', {}, fresh)).body.QueueUrls ?? []).toEqual([]);
    expect((await jsonApi('dynamodb', 'DynamoDB_20120810.ListTables', {}, fresh)).body.TableNames).toEqual([]);

    expect((await s3('PUT', '/photos', undefined, fresh)).status).toBe(200);
    expect((await s3('GET', '/photos/cat.txt', undefined, fresh)).status).toBe(404);
    // The deduplication id was spent before the reset; a message with it is new again
    const QueueUrl = await fifo();
    const received = await jsonApi('sqs', 'AmazonSQS.ReceiveMessage', { QueueUrl }, fresh);
    expect(received.body.Messages).toHaveLength(1);
    expect((await table()).status).toBe(200);
    await fresh.stop();
  }, 30_000);

  it('leaves saved state on disk until the next save', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'pocket-region-reset-'));
    const first = await createRegion({ stateDir });
    await s3('PUT', '/saved', undefined, first);
    await s3('PUT', '/saved/keep.txt', 'kept', first);
    await first.save();
    await first.reset();

    const unsaved = await createRegion({ stateDir });
    expect((await s3('GET', '/saved/keep.txt', undefined, unsaved)).status).toBe(200);
    await unsaved.stop();

    // Stopping saves, so the reset reaches disk here
    await first.stop();
    const saved = await createRegion({ stateDir });
    expect((await s3('GET', '/saved/keep.txt', undefined, saved)).status).toBe(404);
    expect((await s3('GET', '/saved', undefined, saved)).status).toBe(404);
    await saved.stop();
    await rm(stateDir, { recursive: true, force: true });
  }, 60_000);

  it('saves state that a later region reads back', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'pocket-region-state-'));
    const first = await createRegion({ stateDir });
    await s3('PUT', '/saved', undefined, first);
    await s3('PUT', '/saved/keep.txt', 'kept', first);
    await s3('PUT', '/saved/gone.txt', 'deleted after the first save', first);
    await first.save();
    expect((await readdir(stateDir, { recursive: true })).length).toBeGreaterThan(0);
    await s3('DELETE', '/saved/gone.txt', undefined, first);
    await first.stop();

    const second = await createRegion({ stateDir });
    const kept = await s3('GET', '/saved/keep.txt', undefined, second);
    expect(kept.status).toBe(200);
    expect(decoder.decode(kept.body)).toBe('kept');
    expect((await s3('GET', '/saved/gone.txt', undefined, second)).status).toBe(404);
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
