import * as s3Module from '@aws-sdk/client-s3';
import * as sqsModule from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Region } from './core.ts';
import { createTestRegion } from './test-region.ts';
import { withRegion } from './with-region.ts';

let region: Region;
let s3: typeof s3Module;

beforeAll(async () => {
  region = await createTestRegion();
  s3 = withRegion(s3Module, region);
}, 30_000);

afterAll(() => region.stop());

describe('withRegion', () => {
  it('lets a client built with no config reach the region', async () => {
    const client = new s3.S3Client({});
    await client.send(new s3.CreateBucketCommand({ Bucket: 'bare' }));
    const { Buckets } = await client.send(new s3.ListBucketsCommand({}));
    expect(Buckets?.map((bucket) => bucket.Name)).toContain('bare');
  });

  it('defaults the aggregated client too', async () => {
    const client = new s3.S3();
    await client.createBucket({ Bucket: 'aggregated' });
    await expect(client.headBucket({ Bucket: 'aggregated' })).resolves.toBeDefined();
  });

  it("keeps the caller's region and credentials", async () => {
    const client = new s3.S3Client({ region: 'eu-west-1', credentials: { accessKeyId: 'mine', secretAccessKey: 'mine' } });
    expect(await client.config.region()).toBe('eu-west-1');
    expect((await client.config.credentials()).accessKeyId).toBe('mine');
  });

  it("never uses the caller's requestHandler", async () => {
    const elsewhere = {
      handle: () => Promise.reject(new Error('reached the requestHandler the caller passed')),
      updateHttpClientConfig() {},
      httpHandlerConfigs: () => ({}),
    };
    const { SQSClient, CreateQueueCommand } = withRegion(sqsModule, region);
    const client = new SQSClient({ requestHandler: elsewhere });
    await expect(client.send(new CreateQueueCommand({ QueueName: 'handled' }))).resolves.toHaveProperty('QueueUrl');
  });

  it('passes everything else through, and keeps the client names and instanceof', () => {
    expect(s3.PutObjectCommand).toBe(s3Module.PutObjectCommand);
    expect(s3.S3Client.name).toBe('S3Client');
    expect(new s3.S3Client({})).toBeInstanceOf(s3Module.S3Client);
  });

  it('returns a module that is not an SDK client module as it is', () => {
    const other = { S3Client: class {} };
    expect(withRegion(other, region)).toBe(other);
  });
});
