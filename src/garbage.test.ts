import { CreateEventSourceMappingCommand, CreateFunctionCommand, InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { CreateTableCommand, DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { expect, it } from 'vitest';
import { collectGarbage } from './core.ts';
import { requestHandler } from './request-handler.ts';
import { clientConfig, createQueue, zipOf } from './test-clients.ts';
import { createTestRegion, regionPort } from './test-region.ts';

const ROUNDS = 200;

const HANDLER = `export const handler = async (event) => {
  if (event.fail) throw new Error('failed on purpose');
  return { ok: true };
};`;

// Automatic collection is off, so whatever a request leaves in cycles stays until collectGarbage
it('leaves little for the garbage collector across S3, SQS, DynamoDB, and Lambda', async () => {
  const region = await createTestRegion({ port: await regionPort() });
  try {
    const config = clientConfig({ requestHandler: requestHandler(region) });
    const s3 = new S3Client({ ...config, forcePathStyle: true });
    const sqs = new SQSClient(config);
    const dynamodb = new DynamoDBClient(config);
    const lambda = new LambdaClient({ ...config, maxAttempts: 1 });

    await s3.send(new CreateBucketCommand({ Bucket: 'garbage' }));
    const { QueueUrl } = await createQueue(sqs, 'garbage');
    const mapped = await createQueue(sqs, 'garbage-mapped');
    await dynamodb.send(
      new CreateTableCommand({
        TableName: 'garbage',
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
    await lambda.send(
      new CreateFunctionCommand({
        FunctionName: 'garbage',
        Runtime: 'nodejs22.x',
        Handler: 'index.handler',
        Role: 'arn:aws:iam::000000000000:role/lambda',
        Code: { ZipFile: zipOf('index.mjs', HANDLER) },
      }),
    );
    await lambda.send(
      new CreateEventSourceMappingCommand({ FunctionName: 'garbage', EventSourceArn: mapped.QueueArn, BatchSize: 10 }),
    );

    const round = async (index: number) => {
      await s3.send(new PutObjectCommand({ Bucket: 'garbage', Key: 'object', Body: `body ${index}` }));
      await (await s3.send(new GetObjectCommand({ Bucket: 'garbage', Key: 'object' }))).Body!.transformToString();
      await s3.send(new GetObjectCommand({ Bucket: 'garbage', Key: 'missing' })).catch(() => {});
      await s3.send(new DeleteObjectCommand({ Bucket: 'garbage', Key: 'object' }));
      await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: `message ${index}` }));
      const { Messages } = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 1 }));
      for (const { ReceiptHandle } of Messages ?? []) await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle }));
      await dynamodb.send(new PutItemCommand({ TableName: 'garbage', Item: { id: { S: 'item' }, n: { N: String(index) } } }));
      await dynamodb.send(new GetItemCommand({ TableName: 'garbage', Key: { id: { S: 'item' } } }));
      await dynamodb.send(new GetItemCommand({ TableName: 'missing', Key: { id: { S: 'item' } } })).catch(() => {});
      await lambda.send(new InvokeCommand({ FunctionName: 'garbage', Payload: JSON.stringify({ fail: index % 2 === 1 }) }));
      await sqs.send(new SendMessageCommand({ QueueUrl: mapped.QueueUrl, MessageBody: '{}' }));
    };
    const drained = async () => {
      const { Attributes } = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: mapped.QueueUrl,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      );
      return Number(Attributes!.ApproximateNumberOfMessages) + Number(Attributes!.ApproximateNumberOfMessagesNotVisible);
    };

    // The first round imports each service, which leaves garbage of its own
    await round(0);
    await expect.poll(drained, { timeout: 15_000 }).toBe(0);
    collectGarbage(region);

    for (let index = 1; index <= ROUNDS; index++) await round(index);
    await expect.poll(drained, { timeout: 30_000 }).toBe(0);
    const freed = collectGarbage(region);
    expect(freed, `${freed} objects freed after ${ROUNDS} rounds`).toBeLessThan(ROUNDS);
  } finally {
    await region.stop();
  }
}, 120_000);
