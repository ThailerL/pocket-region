# Pocket Region

Pocket Region runs S3, SQS, DynamoDB, and Lambda inside your Node process or a browser tab,
and you call them with the ordinary AWS SDK. Requests reach the emulator without a socket, so
there's no container to start and no server to reach. Lambda
handlers run in child processes or Web Workers, and a region resets to empty in under a
millisecond, so every test can start clean. In Node, a region is ready in half a second, and
later ones in the same process in about 350 ms.

The AWS APIs come from [MiniStack](https://ministack.org/), a Python AWS emulator that runs
here under [Pyodide](https://github.com/pyodide/pyodide).

```js
import { createRegion, requestHandler } from 'pocket-region';
import { S3Client, CreateBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const region = await createRegion();

const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: 'http://localhost:4566', // not used, since nothing listens here
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  forcePathStyle: true,
  requestHandler: requestHandler(region),
});

await s3.send(new CreateBucketCommand({ Bucket: 'photos' }));
await s3.send(new PutObjectCommand({ Bucket: 'photos', Key: 'cat.txt', Body: 'meow' }));

await region.stop();
```

## In a browser

The browser entry loads the emulator from the package's `vendor/` directory, served from your
site at the address you give it. Pyodide itself loads from jsDelivr, at the version the package was built with, unless
you pass `indexURL`. A first visit downloads about 12 MB: 8 MB of wheels and Python standard
library from your site, which are already compressed, and 3.7 MB of Pyodide from jsDelivr.

```js
import { createRegion } from 'pocket-region/browser';
import { requestHandler } from 'pocket-region/sdk';

const region = await createRegion({ assetsBaseUrl: '/vendor' });
```

Everything below works the same in a page, Lambda included, where functions run in Web
Workers instead of child processes.

Try it at [pocket-region.dev/demo](https://pocket-region.dev/demo).

## Lambda

Functions are created from a zipped deployment package and invoked with `InvokeCommand`.
Handlers run in Node child processes, or in Web Workers in a browser.

```js
import { createRegion, requestHandler } from 'pocket-region';
import { LambdaClient, CreateFunctionCommand, InvokeCommand } from '@aws-sdk/client-lambda';

const region = await createRegion();
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

The handler's environment has `AWS_ENDPOINT_URL`, `AWS_REGION`, and test credentials. In Node,
an SDK client created with no options reaches the region. In a browser, pass them to the client
yourself. `Timeout`,
`ReservedConcurrentExecutions`, `Environment`, `InvocationType: 'Event'`, and
`LogType: 'Tail'` work as they do on Lambda, and a thrown error comes back as
`FunctionError: 'Unhandled'`.

Only Node runtimes work, and the AWS SDK isn't preinstalled, so bundle it with your code. In a
browser the package must be a single ES module, since CommonJS and relative imports don't
load there, though imports from a full URL such as jsDelivr do. Asynchronous events are delivered once, with no retries or dead-letter queues,
and SQS event source mappings don't poll yet.

## The `aws` CLI

`awsCli` runs `aws` commands, so you can put an AWS console in your own page, where people
paste commands from AWS's documentation. It returns the output instead of printing it, so you
decide where it shows.

```js
import { awsCli } from 'pocket-region/cli';

const aws = awsCli(region);
await aws('s3api create-bucket --bucket notes');
const { stdout } = await aws('sqs create-queue --queue-name orders');
```

Pass a command as a string or as an array of arguments. It resolves to
`{ stdout, stderr, code }`. A failed command gives a non-zero `code`, like the real CLI,
unless you pass `{ throwOnError: true }` to make it throw. Any service works if its SDK client
is installed. An `sns` command needs `@aws-sdk/client-sns`, and tells you if it's missing.

### Supplying the clients yourself

The CLI imports each client the first time a command uses it. Bundlers can't see those
imports, so in a bundle, a page or a worker, pass the client modules in yourself. Key them by
SDK name, so `s3` also covers `s3api`. Anything in `client` is added to every client's config,
such as your own endpoint and credentials.

```js
import * as s3 from '@aws-sdk/client-s3';
import * as sqs from '@aws-sdk/client-sqs';

const aws = awsCli(region, {
  modules: { s3, sqs },
  client: { credentials: { accessKeyId: 'node-7', secretAccessKey: 'shh' } },
});
```

You can pass either, both or neither. S3 always uses path-style addressing, whatever you
put in `client`.

## Persistence

State is kept in memory unless you give the region a directory. It never saves on its own,
so call `save` when you want the state written.

```js
const region = await createRegion({ stateDir: './.region' });
// ... requests ...
await region.save();   // writes the state to ./.region
await region.stop();   // saves, then shuts down
```

A browser has nowhere to write, so the browser region has no `save`.

## A clean region per test

One region can serve a whole test file, reset to empty before each test. `reset` calls
MiniStack's own reset, so every service comes back empty, not only the tested ones. A reset takes under
a millisecond for a typical test and about 3.5 ms with 20 resources, while booting a region
takes 350-500 ms.

```js
let region;
beforeAll(async () => { region = await createRegion(); });
beforeEach(() => region.reset());
afterAll(() => region.stop());
```

If the region has a `stateDir`, its files stay on disk until the next `save` or `stop`, which
overwrites them with the empty state.

## Over HTTP

Some callers can't be handed a request handler, such as another process, a program in
another language, or the real AWS CLI. `serve` gives them an endpoint to call.

```js
import { createRegion, serve } from 'pocket-region';

const region = await createRegion();
const server = await serve(region);
// aws --endpoint-url http://127.0.0.1:4566 s3 ls
await server.close();
```

It listens on the port the region builds its queue URLs with, 4566 unless you gave
`createRegion` a `port`, so a client following a queue URL arrives at the server. Pass
`{ port }` to listen somewhere else. A browser can't listen on a port, so `serve` is only in
the Node entry.

## What works

| Service | Status |
| --- | --- |
| S3 | Tested, including bucket notifications into SQS |
| SQS | Tested |
| DynamoDB | Tested |
| Lambda | Tested with Node functions, synchronous and `Event` invokes, in Node and in a page |
| The rest of [MiniStack](https://ministack.org/)'s services | Untested. They may respond, but nothing here checks them |

Scheduled EventBridge rules and the DynamoDB TTL reaper never run. Pyodide has no threads, so
the loops that drive them never start.

## How it works

[MiniStack](https://ministack.org/), a Python AWS emulator, runs under
[Pyodide](https://github.com/pyodide/pyodide). Python can't open a socket under Pyodide, so JavaScript takes
each request and passes it to the emulator directly. That call is `dispatch`. The SDK adapter
is built on it, which is why no server is needed.

```js
const response = await region.dispatch({
  method: 'GET',
  path: '/photos/cat.txt',
  headers: { host: 'localhost:4566', authorization: '...' },
});
```

Anything that speaks the AWS wire protocol works with it, and a service could later be
rewritten without changing how you call it.

Lambda crosses the boundary the other way. MiniStack keeps the functions and answers the
Lambda API, and when something invokes a function, the invocation comes back out to
JavaScript. Pocket Region runs the handler in a child process or a Web Worker, enforces its
timeout and concurrency, and hands the result back to MiniStack, while the handler's own SDK
calls go through `dispatch` like any other request.

`requestHandler`, `awsCli` and `serve` only ever call `dispatch`, so any object with a
`dispatch` method works in place of a region. Wrap one to refuse, log or count requests before
they reach the emulator.

```js
const guarded = {
  dispatch(request) {
    if (request.method === 'DELETE') {
      return { status: 403, headers: {}, body: new TextEncoder().encode('no DELETE requests') };
    }
    return region.dispatch(request);
  },
};

const server = await serve(guarded);
```

## In a real app

[Glass Garden](https://glass.garden/) runs on Pocket Region. It opens on a working project, a
load balancer in front of an instance group, and you can drag S3, SQS, DynamoDB, and Lambda
onto the canvas and watch requests move through real code. Pocket Region started there as its
AWS region and was pulled out so the same region can run in a test or any other page.
