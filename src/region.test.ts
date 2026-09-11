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

function s3(method: string, path: string, body?: string) {
  return region.dispatch({
    method,
    path,
    headers: { host: 'localhost:4566', authorization: authorization('s3') },
    body: body === undefined ? undefined : encoder.encode(body),
  });
}

async function jsonApi(service: 'sqs' | 'dynamodb', target: string, body: object) {
  const response = await region.dispatch({
    method: 'POST',
    path: '/',
    headers: {
      host: 'localhost:4566',
      authorization: authorization(service),
      'content-type': 'application/x-amz-json-1.0',
      'x-amz-target': target,
    },
    body: encoder.encode(JSON.stringify(body)),
  });
  return { status: response.status, body: JSON.parse(decoder.decode(response.body)) };
}

describe('createRegion', () => {
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
});
