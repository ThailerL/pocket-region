---
title: Getting started
description: Install Pocket Region, boot a region in Node or a page, and point an AWS SDK client at it.
---

## Install

```sh
npm install pocket-region
```

The AWS SDK clients aren't dependencies. Install the ones you use, such as
`@aws-sdk/client-s3`.

## In Node

```js
import { createRegion, requestHandler } from 'pocket-region/node';
import { S3Client, CreateBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const region = await createRegion();

const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: 'http://localhost:4566', // never dialed
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  forcePathStyle: true,
  requestHandler: requestHandler(region),
});

await s3.send(new CreateBucketCommand({ Bucket: 'photos' }));
await s3.send(new PutObjectCommand({ Bucket: 'photos', Key: 'cat.txt', Body: 'meow' }));

await region.stop();
```

## In a page

A page loads the emulator over HTTP, so serve the package's `vendor/` directory from your site
and tell `createRegion` where it is.

```js
import { createRegion, requestHandler } from 'pocket-region/browser';

const region = await createRegion({ assetsBaseUrl: '/vendor' });
```

A first visit downloads about 12 MB: 8 MB of wheels and the Python standard library from your
site, already compressed, and 3.7 MB of Pyodide from jsDelivr, unless you pass `indexURL`.
Everything else works as it does in Node, except that Lambda handlers run in Web Workers and
there is no `save` or `serve`.
