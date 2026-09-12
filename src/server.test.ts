import {
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  CreateQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRegion, type Region } from './node.ts';
import { serve, type RegionServer } from './server.ts';
import { clientConfig, freePort } from './test-support.ts';

const SIGNED = {
  authorization:
    'AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=test',
};

let region: Region;
let server: RegionServer;
let config: ReturnType<typeof clientConfig>;

beforeAll(async () => {
  region = await createRegion({ port: await freePort() });
  // No port passed: the server takes the region's, which is what its queue URLs name
  server = await serve(region);
  config = clientConfig({ endpoint: server.url });
}, 30_000);

afterAll(async () => {
  await server?.close();
  await region?.stop();
});

describe('serve', () => {
  it('answers an SDK client that was given no request handler', async () => {
    const s3 = new S3Client({ ...config, forcePathStyle: true });
    await s3.send(new CreateBucketCommand({ Bucket: 'photos' }));
    await s3.send(new PutObjectCommand({ Bucket: 'photos', Key: 'cat.txt', Body: 'meow' }));
    const read = await s3.send(new GetObjectCommand({ Bucket: 'photos', Key: 'cat.txt' }));
    expect(await read.Body?.transformToString()).toBe('meow');
    s3.destroy();
  });

  it('serves the queue URLs it mints, which a client dials directly', async () => {
    const sqs = new SQSClient(config);
    const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: 'orders' }));
    expect(QueueUrl).toContain(`:${server.port}/`);
    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'one latte' }));
    const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl }));
    expect(received.Messages?.[0]?.Body).toBe('one latte');
    sqs.destroy();
  });

  it('speaks plain HTTP, so anything that signs a request works', async () => {
    const response = await fetch(`${server.url}/photos/cat.txt`, { headers: SIGNED });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('meow');
  });

  it('refuses a body past the cap rather than buffering it', async () => {
    const small = await serve(region, { port: 0, maxBodyBytes: 16 });
    const response = await fetch(`${small.url}/photos/big.txt`, {
      method: 'PUT',
      body: 'x'.repeat(64),
      headers: SIGNED,
    });
    expect(response.status).toBe(413);
    await small.close();
  });

  it('answers on the port the region mints its queue URLs with', () => {
    expect(server.port).toBe(region.port);
  });

  it('refuses an upload by its declared length, before reading it', async () => {
    const small = await serve(region, { port: 0, maxBodyBytes: 16 });
    const response = await fetch(`${small.url}/photos/big.txt`, {
      method: 'PUT',
      body: new Uint8Array(1024),
      headers: SIGNED,
    });
    expect(response.status).toBe(413);
    await small.close();
  });

  it('frees the port when closed', async () => {
    const extra = await serve(region, { port: 0 });
    const { port } = extra;
    await extra.close();
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });
});
