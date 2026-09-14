---
title: Lambda
description: Where Pocket Region's Lambda differs from AWS, what a handler sees, event source mappings, and the observer.
---

MiniStack stores functions and answers the Lambda API. Each invocation runs a Node handler in an
**execution environment**: a child process in Node, or a module Web Worker in a page. Create and
invoke functions with the ordinary SDK. What isn't covered here behaves as it does on AWS.

```js
import { LambdaClient, CreateFunctionCommand, InvokeCommand } from '@aws-sdk/client-lambda';

const lambda = new LambdaClient({ /* as in Getting started */ requestHandler: requestHandler(region) });
await lambda.send(new CreateFunctionCommand({
  FunctionName: 'hello',
  Runtime: 'nodejs22.x',
  Handler: 'index.handler',
  Role: 'arn:aws:iam::000000000000:role/lambda',
  Code: { ZipFile: zipOfYourCode },
}));
const { Payload } = await lambda.send(new InvokeCommand({ FunctionName: 'hello', Payload: '{}' }));
```

## Runtimes and packages

Only `nodejs*` runtimes run. Any other runtime, and container images, fail each invocation with
`Runtime.Unsupported`. The AWS SDK isn't preinstalled, so bundle it with your code.

| | Node | Page |
| --- | --- | --- |
| `Handler: 'index.handler'` loads | `index.mjs`, `index.js`, or `index.cjs` | `index.mjs` or `index.js` |
| CommonJS | Works, with exports read from `default` | Doesn't work |
| Relative imports | Work | Don't work: the handler must be a single ES module. Imports from a full URL, such as jsDelivr, work |
| Parent environment variables | Only `PATH` | None |

## What a handler sees

Lambda's standard `AWS_LAMBDA_*` variables are set, along with the function's own
`Environment.Variables`, which win. These point the handler at the region:

| Variable | Value |
| --- | --- |
| `AWS_ENDPOINT_URL` | The region: `http://127.0.0.1:<port>` in Node, `http://localhost:<port>` in a page |
| `AWS_REGION`, `AWS_DEFAULT_REGION` | `us-east-1` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `test` |

So an SDK client created inside a handler with no options reaches the region. In a page,
`process.env` is provided for these, and `fetch` calls to the region's port on `localhost`,
`127.0.0.1`, or `[::1]` are routed to the region. Every other `fetch` goes out as normal.

## Limits

| | Behaviour |
| --- | --- |
| `Timeout` | Past it, the invocation fails with `Sandbox.Timedout`, and that environment is stopped rather than reused |
| Concurrency | `ReservedConcurrentExecutions`, or 10 without one |
| An idle environment | Stopped after 60 s |
| A code or configuration change | New invocations get fresh environments. The old ones finish what they're running |

## Asynchronous invocations

A failed `Event` invocation is retried twice by default, or up to the function's
`MaximumRetryAttempts`, with backoff of 1 s then 2 s, capped at 30 s, rather than AWS's minutes.
Retries start up to a second late, because they wait on the region's once-a-second timer. When
retries run out, the event goes to the `OnFailure` destination or the `DeadLetterConfig` target.
SQS targets are tested, SNS targets aren't.

EventBridge rules that target Lambda don't reach the handler at all, found by reading
MiniStack's source and not yet run.

## Event source mappings

SQS mappings hand a function batches from a queue, as many at once as its concurrency allows.
`ReportBatchItemFailures` is untested. Kinesis and DynamoDB Streams mappings are accepted but
don't poll yet.

## Watching functions run

Pass `lambda` to `createRegion`. `onOutput` gets every line a handler writes, including the
`START`, `END`, and `REPORT` lines. The region's own `onOutput` hears the same lines, untagged.
`onEvent` gets one of:

| `kind` | `phase` | Fields |
| --- | --- | --- |
| `environment` | `started`, `stopped` | `functionName`, `environment`, and `reason` when stopped |
| `invocation` | `started` | `functionName`, `environment`, `requestId`, `event` (JSON text), `coldStart` |
| `invocation` | `completed` | `functionName`, `environment`, `requestId`, `durationMs`, `initMs` (first invocation only), `failed` |
| `throttled` | | `functionName` |

```js
const region = await createRegion({
  lambda: {
    onOutput: (line, { functionName, environment }) => console.log(`[${functionName} ${environment}] ${line}`),
    onEvent: (event) => { if (event.kind === 'throttled') console.warn(`${event.functionName} throttled`); },
  },
});
```
