import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CreateBucketCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRegion, type PageRegion } from './browser.ts';
import { requestHandler } from './request-handler.ts';

const VENDOR = fileURLToPath(new URL('../vendor', import.meta.url));
let server: http.Server;
let region: PageRegion;
let assetsBaseUrl: string;

// The page's fetch path, in Node: meta.json, the wheels and the stdlib all arrive over HTTP.
// Only Pyodide's own runtime differs, since Node resolves indexURL as a directory
beforeAll(async () => {
  server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://x');
    const file = path.join(VENDOR, pathname.replace(/^\/vendor\/?/, ''));
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
      response.writeHead(404).end();
      return;
    }
    // Nothing downstream reads content-type: fetch parses JSON regardless, and Pyodide
    // never inspects it
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };
  assetsBaseUrl = `http://127.0.0.1:${port}/vendor`;
  region = await createRegion({
    assetsBaseUrl,
    indexURL: fileURLToPath(new URL('../node_modules/pyodide', import.meta.url)),
  });
}, 60_000);

afterAll(async () => {
  await region?.stop();
  server?.close();
});

describe('createRegion in a page', () => {
  it('serves an SDK client from assets fetched over HTTP', async () => {
    const s3 = new S3Client({
      region: 'us-east-1',
      endpoint: 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      forcePathStyle: true,
      requestHandler: requestHandler(region),
    });
    await s3.send(new CreateBucketCommand({ Bucket: 'pages' }));
    await s3.send(new PutObjectCommand({ Bucket: 'pages', Key: 'hello.txt', Body: 'from a page' }));
    const read = await s3.send(new GetObjectCommand({ Bucket: 'pages', Key: 'hello.txt' }));
    expect(await read.Body?.transformToString()).toBe('from a page');
  });

  it('says where it looked when the assets are missing', async () => {
    await expect(createRegion({ assetsBaseUrl: `${assetsBaseUrl}/absent` })).rejects.toThrow(
      /no region assets at/,
    );
  });
});
