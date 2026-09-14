import { CreateBucketCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRegion, type Region } from './browser.ts';
import { requestHandler } from './request-handler.ts';
import { clientConfig, serveVendor } from './test-support.ts';

let vendor: Awaited<ReturnType<typeof serveVendor>>;
let region: Region;

beforeAll(async () => {
  vendor = await serveVendor();
  region = await createRegion(vendor);
}, 60_000);

afterAll(async () => {
  await region?.stop();
  vendor?.close();
});

describe('createRegion in a page', () => {
  it('serves an SDK client from assets fetched over HTTP', async () => {
    const s3 = new S3Client(
      clientConfig({ forcePathStyle: true, requestHandler: requestHandler(region) }),
    );
    await s3.send(new CreateBucketCommand({ Bucket: 'pages' }));
    await s3.send(new PutObjectCommand({ Bucket: 'pages', Key: 'hello.txt', Body: 'from a page' }));
    const read = await s3.send(new GetObjectCommand({ Bucket: 'pages', Key: 'hello.txt' }));
    expect(await read.Body?.transformToString()).toBe('from a page');
  });

  it('says where it looked when the assets are missing', async () => {
    await expect(createRegion({ assetsBaseUrl: `${vendor.assetsBaseUrl}/absent` })).rejects.toThrow(
      /no region assets at/,
    );
  });
});
