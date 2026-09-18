# Pocket Region

Pocket Region runs AWS services like S3, DynamoDB, and Lambda inside your Node process or a
browser tab, and you call them with the ordinary AWS SDK. Your SDK calls reach the emulator as
function calls, without a socket, so there's no container to start and no server to reach.
Lambda handlers run in child processes or Web Workers.

```js
import { clientConfig, createRegion } from 'pocket-region/node';
import { S3Client, CreateBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const region = await createRegion();
const s3 = new S3Client(clientConfig(region));

await s3.send(new CreateBucketCommand({ Bucket: 'photos' }));
await s3.send(new PutObjectCommand({ Bucket: 'photos', Key: 'cat.txt', Body: 'meow' }));

await region.stop();
```

It needs WebAssembly JSPI: Node 24.20 or later, or a browser that supports it.

The AWS APIs come from [MiniStack](https://ministack.org/), a Python AWS emulator that runs
here under [Pyodide](https://github.com/pyodide/pyodide).

In Node, a region is ready in about half a second. Resetting a region to empty takes about a millisecond for a typical test, so
every test can start clean without booting a new one.

Read the docs at [pocket-region.dev/docs](https://pocket-region.dev/docs/), where you can edit
and run the examples in your browser tab, or try the [demo](https://pocket-region.dev/demo).

## Features

- **[Node and the browser](https://pocket-region.dev/docs/):** the same region runs in a Node
  process or a page, which loads the emulator from jsDelivr with no files to copy.
- **[Services](https://pocket-region.dev/docs/services/):** CloudWatch Logs, DynamoDB,
  EventBridge, Kinesis, KMS, S3, Secrets Manager, SNS, SQS, and SSM Parameter Store behave as
  they do in MiniStack, with a runnable example for each. Others, such as RDS and ECS, answer as
  stubs with nothing running behind them, or are untested here.
- **[Lambda](https://pocket-region.dev/docs/lambda/):** Node functions run from a zipped
  deployment package, in child processes or Web Workers, with event source mappings.
- **[Resets and saves](https://pocket-region.dev/docs/region/):** empty a region between tests,
  or save its state to a store and boot from it later.
- **[Clients](https://pocket-region.dev/docs/clients/):** `requestHandler` for AWS SDK clients,
  and `serve` for anything that needs an endpoint.
- **[The `aws` CLI](https://pocket-region.dev/docs/cli/):** `awsCli` runs `aws` commands and
  returns their output, for tests or an AWS console in your own page.
- **[Examples in your docs](https://pocket-region.dev/docs/runner/):** add a Run button to
  code examples written for real AWS. `createRunner` runs them in the reader's tab without any
  Pocket Region setup in the example.

## In a real app

[Glass Garden](https://glass.garden/) runs on Pocket Region. It opens on a working project, a
load balancer in front of an instance group, and you can drag S3, SQS, DynamoDB, and Lambda
onto the canvas and watch requests move through real code. Pocket Region started there as its
AWS region and was pulled out so the same region can run in a test or any other page.
