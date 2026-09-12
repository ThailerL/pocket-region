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

## The `aws` CLI

Commands are the real CLI's, so they paste out of AWS documentation. Output comes back rather
than being printed, because a terminal renders it and a test asserts on it.

```js
import { awsCli } from 'pocket-region/cli';

const aws = awsCli(region);
await aws('s3api create-bucket --bucket notes');
const { stdout } = await aws('sqs create-queue --queue-name orders');
```

It takes a typed line or an argument array, and resolves `{ stdout, stderr, code }` — a bad
command is a non-zero `code`, as it is in the real CLI, or pass `{ throwOnError: true }`.
Any service works as long as its client is installed: a command naming `sns` needs
`@aws-sdk/client-sns`, and says so if it is missing.

### Supplying the clients yourself

A client is imported when a command first names it, and no bundler can follow an import like
that — so in a bundle, a page or a worker, hand the modules over instead. They are keyed by
the *resolved* SDK name, so `s3` covers `s3api` too. `client` is merged into every client's
config, for an endpoint and credentials of your own:

```js
import * as s3 from '@aws-sdk/client-s3';
import * as sqs from '@aws-sdk/client-sqs';

const aws = awsCli(region, {
  modules: { s3, sqs },
  client: { credentials: { accessKeyId: 'node-7', secretAccessKey: 'shh' } },
});
```

Both are optional, and neither can lose the addressing a service needs — S3 stays path-style.

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

## A clean region per test

Boot once, then reset between tests. A reset empties every service in well under a
millisecond for a typical test and about 3 ms for a region holding 20 resources, where a boot
takes 300-500 ms.

```js
let region;
beforeAll(async () => { region = await createRegion(); });
beforeEach(() => region.reset());
afterAll(() => region.stop());
```

A region with a `stateDir` keeps its files until the next `save` or `stop`, which writes the
empty state over them.

## Lambda

Create a function the way you would on AWS, with a zipped deployment package, and invoke it.
The handler runs in a Node child process, one per concurrent invocation, kept warm for a
minute of idleness.

```js
import { createRegion, requestHandler, serve } from 'pocket-region';
import { LambdaClient, CreateFunctionCommand, InvokeCommand } from '@aws-sdk/client-lambda';

const region = await createRegion();
// A handler runs in another process, so its own SDK calls need an endpoint to dial
const server = await serve(region);

const lambda = new LambdaClient({ /* as above */ requestHandler: requestHandler(region) });
await lambda.send(new CreateFunctionCommand({
  FunctionName: 'hello',
  Runtime: 'nodejs22.x',
  Handler: 'index.handler',
  Role: 'arn:aws:iam::000000000000:role/lambda',
  Code: { ZipFile: zipOfYourCode },
}));
const { Payload } = await lambda.send(new InvokeCommand({ FunctionName: 'hello', Payload: '{}' }));
```

Inside the handler `AWS_ENDPOINT_URL`, `AWS_REGION` and test credentials are set, so an SDK
client built with no arguments reaches the region. `Timeout`, `ReservedConcurrentExecutions`,
`Environment`, `InvocationType: 'Event'` and `LogType: 'Tail'` behave as on Lambda; a thrown
handler comes back as `FunctionError: 'Unhandled'`.

Node runtimes only, and only in Node — a page has no processes to run a handler in. The
deployment package is used as is: the AWS SDK is not preinstalled for it the way Lambda's
runtime provides it, so bundle it or ship `node_modules` in the zip. Event sources (S3
notifications, SNS, EventBridge) deliver once, with no retries or dead-lettering yet; SQS
event source mappings do not poll.

## What works

| Service | Status |
| --- | --- |
| S3 | Tested, including bucket notifications into SQS |
| SQS | Tested |
| DynamoDB | Tested |
| Lambda | Tested: Node functions, synchronous and `Event` invokes, in Node only |
| The rest of [ministack](https://pypi.org/project/ministack/)'s services | Unverified: they may answer, nothing here exercises them |

Not yet: scheduled EventBridge rules and the DynamoDB TTL reaper never fire, because Pyodide
has no threads and their loops are deferred.

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
