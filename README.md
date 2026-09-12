# Pocket Region

Real S3, SQS and DynamoDB, running inside your Node process or a browser tab. No Docker, no
container to start, no port to wait on: requests from the AWS SDK become function calls.

```js
import { createRegion, requestHandler } from 'pocket-region';
import { S3Client, CreateBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const region = await createRegion();

const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: 'http://localhost:4566', // never dialled; nothing listens
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  forcePathStyle: true,
  requestHandler: requestHandler(region),
});

await s3.send(new CreateBucketCommand({ Bucket: 'photos' }));
await s3.send(new PutObjectCommand({ Bucket: 'photos', Key: 'cat.txt', Body: 'meow' }));

await region.stop();
```

## In a browser

Serve the package's `vendor/` directory from your origin and point the browser entry at it.
Pyodide's own runtime comes from jsDelivr at the version the tree was built against, unless
you pass `indexURL`.

```js
import { createRegion } from 'pocket-region/browser';
import { requestHandler } from 'pocket-region/sdk';

const region = await createRegion({ assetsBaseUrl: '/vendor' });
```

There's a live demo at [pocket-region.dev](https://pocket-region.dev), and its source is in
[`demo/`](demo/index.html).

## Persistence

State lives in memory unless you give it somewhere to write. Nothing is saved on a timer —
you decide when, because you know when a good moment is.

```js
const region = await createRegion({ stateDir: './.region' });
// ... requests ...
await region.save();   // write the emulator's state to that directory
await region.stop();   // saves on the way out
```

A page has nowhere to write, so `save` is not offered there.

## What works

| Service | Status |
| --- | --- |
| S3 | Tested, including bucket notifications into SQS |
| SQS | Tested |
| DynamoDB | Tested |
| The rest of [ministack](https://pypi.org/project/ministack/)'s services | Unverified: they may answer, nothing here exercises them |

Not yet: scheduled EventBridge rules and the DynamoDB TTL reaper never fire, because Pyodide
has no threads and their loops are deferred. Lambda has a working runtime in this repository
but it is not part of the published API yet.

## How it works

[ministack](https://pypi.org/project/ministack/), a Python AWS emulator, runs under
[Pyodide](https://pyodide.org). Python cannot open a socket there, so JavaScript owns the
transport and calls the emulator's ASGI app in-process — which is why `dispatch` is the core
API and the SDK adapter needs no server:

```js
const response = await region.dispatch({
  method: 'GET',
  path: '/photos/cat.txt',
  headers: { host: 'localhost:4566', authorization: '...' },
});
```

The AWS wire protocol is the contract, so anything that speaks it works, and a service could
later be reimplemented without breaking callers.
