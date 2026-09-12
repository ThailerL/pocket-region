import {
  CreateBucketCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  CreateQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  CreateTableCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRegion, type Region } from './region.ts';
import { requestHandler } from './request-handler.ts';

let region: Region;
let s3: S3Client;
let sqs: SQSClient;
let dynamodb: DynamoDBClient;

beforeAll(async () => {
  region = await createRegion();
  const config = {
    region: 'us-east-1',
    endpoint: 'http://localhost:4566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    requestHandler: requestHandler(region),
  };
  s3 = new S3Client({ ...config, forcePathStyle: true });
  sqs = new SQSClient(config);
  dynamodb = new DynamoDBClient(config);
}, 30_000);

afterAll(async () => {
  await region?.stop();
});

describe('requestHandler', () => {
  it('serves an S3 client, streaming bodies included', async () => {
    await s3.send(new CreateBucketCommand({ Bucket: 'photos' }));
    await s3.send(new PutObjectCommand({ Bucket: 'photos', Key: 'cat.txt', Body: 'meow' }));
    const read = await s3.send(new GetObjectCommand({ Bucket: 'photos', Key: 'cat.txt' }));
    expect(await read.Body?.transformToString()).toBe('meow');

    // A query string, and the paths the SDK builds from it
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: 'photos', Prefix: 'cat' }));
    expect(listed.Contents?.map((entry) => entry.Key)).toEqual(['cat.txt']);
  });

  it("throws the SDK's own error for a missing key", async () => {
    await expect(
      s3.send(new GetObjectCommand({ Bucket: 'photos', Key: 'absent.txt' })),
    ).rejects.toBeInstanceOf(NoSuchKey);
  });

  it('serves an SQS client', async () => {
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: 'orders' }));
    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'one latte' }));
    const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl }));
    expect(received.Messages?.map((message) => message.Body)).toEqual(['one latte']);
  });

  it('serves a DynamoDB client', async () => {
    await dynamodb.send(
      new CreateTableCommand({
        TableName: 'users',
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
    await dynamodb.send(
      new PutItemCommand({ TableName: 'users', Item: { pk: { S: 'ada' }, name: { S: 'Ada' } } }),
    );
    const read = await dynamodb.send(
      new GetItemCommand({ TableName: 'users', Key: { pk: { S: 'ada' } } }),
    );
    expect(read.Item?.name?.S).toBe('Ada');
  });
});
