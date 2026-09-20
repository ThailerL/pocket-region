import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Region } from './core.ts';
import { authorization, jsonApi, s3 } from './testing/clients.ts';
import { createTestRegion } from './testing/region.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let region: Region;

beforeAll(async () => {
  region = await createTestRegion();
}, 30_000);

afterAll(async () => {
  await region?.stop();
});

describe('a region', () => {
  it('refuses to boot without JSPI', async () => {
    const suspending = Object.getOwnPropertyDescriptor(WebAssembly, 'Suspending')!;
    Reflect.deleteProperty(WebAssembly, 'Suspending');
    try {
      await expect(createTestRegion()).rejects.toThrow('needs WebAssembly JSPI');
    } finally {
      Object.defineProperty(WebAssembly, 'Suspending', suspending);
    }
  });

  it('round-trips an S3 object', async () => {
    expect((await s3('PUT', '/photos', undefined, region)).status).toBe(200);
    expect((await s3('PUT', '/photos/cat.txt', 'meow', region)).status).toBe(200);
    const read = await s3('GET', '/photos/cat.txt', undefined, region);
    expect(read.status).toBe(200);
    expect(decoder.decode(read.body)).toBe('meow');
  });

  it('round-trips an SQS message', async () => {
    const created = await jsonApi('sqs', 'AmazonSQS.CreateQueue', { QueueName: 'orders' }, region);
    expect(created.status).toBe(200);
    const { QueueUrl } = created.body;
    expect(QueueUrl).toContain(':4566/');
    await jsonApi('sqs', 'AmazonSQS.SendMessage', { QueueUrl, MessageBody: 'one latte' }, region);
    const received = await jsonApi('sqs', 'AmazonSQS.ReceiveMessage', { QueueUrl }, region);
    expect(received.body.Messages.map((message: { Body: string }) => message.Body)).toEqual([
      'one latte',
    ]);
  });

  it('round-trips a DynamoDB item', async () => {
    const created = await jsonApi(
      'dynamodb',
      'DynamoDB_20120810.CreateTable',
      {
        TableName: 'users',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
      },
      region,
    );
    expect(created.status).toBe(200);
    const item = { pk: { S: 'ada' }, name: { S: 'Ada Lovelace' } };
    await jsonApi('dynamodb', 'DynamoDB_20120810.PutItem', { TableName: 'users', Item: item }, region);
    const read = await jsonApi(
      'dynamodb',
      'DynamoDB_20120810.GetItem',
      { TableName: 'users', Key: { pk: { S: 'ada' } } },
      region,
    );
    expect(read.body.Item).toEqual(item);
  });

  it('fires a one-time schedule that is already due', async () => {
    const { QueueUrl } = (await jsonApi('sqs', 'AmazonSQS.CreateQueue', { QueueName: 'reminders' }, region)).body;
    const { Attributes } = (
      await jsonApi('sqs', 'AmazonSQS.GetQueueAttributes', { QueueUrl, AttributeNames: ['QueueArn'] }, region)
    ).body;
    const scheduled = await region.dispatch({
      method: 'POST',
      path: '/schedules/reminder',
      headers: { host: 'localhost:4566', authorization: authorization('scheduler'), 'content-type': 'application/json' },
      body: encoder.encode(
        JSON.stringify({
          ScheduleExpression: 'at(2020-01-01T00:00:00)',
          FlexibleTimeWindow: { Mode: 'OFF' },
          Target: { Arn: Attributes.QueueArn, RoleArn: 'arn:aws:iam::000000000000:role/scheduler', Input: '"wake up"' },
        }),
      ),
    });
    expect(scheduled.status).toBe(200);
    const bodies = async () => {
      const { body } = await jsonApi('sqs', 'AmazonSQS.ReceiveMessage', { QueueUrl, VisibilityTimeout: 0 }, region);
      return (body.Messages ?? []).map((message: { Body: string }) => message.Body);
    };

    // MiniStack's scheduler sweeps every 10 s
    await expect.poll(bodies, { timeout: 15_000 }).toEqual(['"wake up"']);
  }, 20_000);

  it('resets to empty, and the same names can be used again', async () => {
    const fresh = await createTestRegion();
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
});
