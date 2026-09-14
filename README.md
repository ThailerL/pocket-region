# Pocket Region

Pocket Region runs AWS services like S3, DynamoDB, and Lambda inside your Node process or a
browser tab, and you call them with the ordinary AWS SDK. Your SDK calls reach the emulator as
function calls, without a socket, so there's no container to start and no server to reach.
Lambda handlers run in child processes or Web Workers.

A region resets to empty in under a millisecond, so every test can start clean. In Node, a
region is ready in half a second, and later ones in the same process in about 350 ms.

The AWS APIs come from [MiniStack](https://ministack.org/), a Python AWS emulator that runs
here under [Pyodide](https://github.com/pyodide/pyodide).

Read the docs at [pocket-region.dev/docs](https://pocket-region.dev/docs/), where you can edit
and run the examples in your browser tab.

It needs WebAssembly JSPI: Node 24.20 or later, or a browser that supports it, which Safari
doesn't yet.

```js
import { createRegion, requestHandler } from 'pocket-region/node';
import { S3Client, CreateBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const region = await createRegion();
const s3 = new S3Client({
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
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
import { createRegion, requestHandler } from 'pocket-region/browser';

const region = await createRegion({ assetsBaseUrl: '/vendor' });
```

Everything below works the same in a page, Lambda included, where functions run in Web
Workers instead of child processes.

Try it at [pocket-region.dev/demo](https://pocket-region.dev/demo).

## Lambda

Functions are created from a zipped deployment package and invoked with `InvokeCommand`.
Handlers run in Node child processes, or in Web Workers in a browser.

```js
import { createRegion, requestHandler } from 'pocket-region/node';
import { LambdaClient, CreateFunctionCommand, InvokeCommand } from '@aws-sdk/client-lambda';

const region = await createRegion();
const lambda = new LambdaClient({
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  requestHandler: requestHandler(region),
});
await lambda.send(new CreateFunctionCommand({
  FunctionName: 'hello',
  Runtime: 'nodejs22.x',
  Handler: 'index.handler',
  Role: 'arn:aws:iam::000000000000:role/lambda',
  Code: { ZipFile: zipOfYourCode },
}));
const { Payload } = await lambda.send(new InvokeCommand({ FunctionName: 'hello', Payload: '{}' }));
```

## The `aws` CLI

`awsCli` runs `aws` commands, so you can put an AWS console in your own page. It returns the output instead of printing it, so you decide where it shows.

```js
import { awsCli } from 'pocket-region/browser';

const aws = awsCli(region);
await aws('s3api create-bucket --bucket notes');
const { stdout } = await aws('sqs create-queue --queue-name orders');
```

## What works

MiniStack emulates each service's behaviour, not just its API. These work as they do in MiniStack,
and the [Services](https://pocket-region.dev/docs/services/) page has a runnable example for each:
CloudWatch Logs, DynamoDB, EventBridge, Kinesis, KMS, S3, Secrets Manager, SNS, SQS, and SSM
Parameter Store.

| Service | Status |
| --- | --- |
| Lambda | Node functions, run by Pocket Region in Node and in a page |
| Step Functions | A `Pass` state machine is tested. The rest works as it does in MiniStack, untested here |
| RDS, ElastiCache, ECS, EKS, Batch, OpenSearch, Athena | Stubs: they answer, but nothing runs behind them |
| The rest of [MiniStack's services](https://ministack.org/docs/services/) | Not run here yet. They may work, but nothing here checks them |

## In a real app

[Glass Garden](https://glass.garden/) runs on Pocket Region. It opens on a working project, a
load balancer in front of an instance group, and you can drag S3, SQS, DynamoDB, and Lambda
onto the canvas and watch requests move through real code. Pocket Region started there as its
AWS region and was pulled out so the same region can run in a test or any other page.
