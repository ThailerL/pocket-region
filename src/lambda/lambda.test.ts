import {
  CreateEventSourceMappingCommand,
  CreateFunctionCommand,
  GetEventSourceMappingCommand,
  InvokeCommand,
  LambdaClient,
  PutFunctionConcurrencyCommand,
  PutFunctionEventInvokeConfigCommand,
  ResourceNotFoundException,
  TooManyRequestsException,
  UpdateFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';
import { CreateTableCommand, DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand, PutRuleCommand, PutTargetsCommand } from '@aws-sdk/client-eventbridge';
import { CreateStreamCommand, DescribeStreamCommand, KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { SFNClient } from '@aws-sdk/client-sfn';
import { GetQueueAttributesCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LambdaEvent, LambdaObserver, LambdaOutput, Region } from '../core.ts';
import { requestHandler } from '../request-handler.ts';
import { authorization, bodies, clientConfig, createQueue, execute, zipOf, zipOfFiles } from '../test-clients.ts';
import { createTestRegion, regionPort } from '../test-region.ts';

const decoder = new TextDecoder();

const HANDLER = `
let calls = 0;
export const handler = async (event, context) => {
  calls++;
  console.log('handling ' + JSON.stringify(event));
  if (event.throw) throw new Error('handler failed');
  if (event.sleep) await new Promise((resolve) => setTimeout(resolve, event.sleep));
  if (event.bucket) {
    const url = process.env.AWS_ENDPOINT_URL + '/' + event.bucket;
    const response = await fetch(url, { method: 'PUT', headers: { authorization: ${JSON.stringify(authorization('s3'))} } });
    return { created: response.status };
  }
  return { calls, functionName: context.functionName, remaining: context.getRemainingTimeInMillis() > 0, runtime: process.env.AWS_EXECUTION_ENV, event };
};
`;

const PYTHON_HANDLER = `
import json
import os

calls = 0


def handler(event, context):
    global calls
    calls += 1
    print("handling " + json.dumps(event))
    if event.get("raise"):
        raise ValueError("handler failed")
    return {
        "calls": calls,
        "functionName": context.function_name,
        "requestId": context.aws_request_id,
        "remaining": context.get_remaining_time_in_millis() > 0,
        "runtime": os.environ["AWS_EXECUTION_ENV"],
        "event": event,
    }
`;

// boto3 as a handler uses it: a client made at init with no options
const BOTO3_HANDLER = `
import boto3

s3 = boto3.client("s3")


def handler(event, context):
    s3.create_bucket(Bucket=event["bucket"])
    s3.put_object(Bucket=event["bucket"], Key="greeting.txt", Body="hello from boto3")
    return {"body": s3.get_object(Bucket=event["bucket"], Key="greeting.txt")["Body"].read().decode()}
`;

// Each record's body names a bucket to create, then optionally "fail" to throw after it
const CONSUMER = `
export const handler = async (event) => {
  for (const record of event.Records) {
    const [bucket, outcome] = record.body.split(' ');
    await fetch(process.env.AWS_ENDPOINT_URL + '/' + bucket, { method: 'PUT', headers: { authorization: ${JSON.stringify(authorization('s3'))} } });
    if (outcome === 'fail') throw new Error('batch failed');
  }
};
`;

let region: Region;
let lambda: LambdaClient;
let s3: S3Client;
let sqs: SQSClient;

const observed: LambdaEvent[] = [];
const tagged: LambdaOutput[] = [];
const observer: LambdaObserver = {
  onEvent: (event) => observed.push(event),
  onOutput: (output) => tagged.push(output),
};
const eventsOf = (functionName: string) => observed.filter((event) => event.functionName === functionName);

const createFunction = (FunctionName: string, extra: object = {}, code = HANDLER) =>
  lambda.send(
    new CreateFunctionCommand({
      FunctionName,
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
      Role: 'arn:aws:iam::000000000000:role/lambda',
      Code: { ZipFile: zipOf('index.mjs', code) },
      ...extra,
    }),
  );

async function invoke(FunctionName: string, event: object, extra: object = {}) {
  const response = await lambda.send(
    new InvokeCommand({ FunctionName, Payload: JSON.stringify(event), ...extra }),
  );
  return {
    status: response.StatusCode,
    error: response.FunctionError,
    payload: response.Payload ? JSON.parse(decoder.decode(response.Payload)) : undefined,
    log: response.LogResult ? atob(response.LogResult) : undefined,
  };
}

// A queue mapped to the consumer function, holding one message
async function mapQueue(QueueName: string, MessageBody: string) {
  const { QueueUrl, QueueArn } = await createQueue(sqs, QueueName, { VisibilityTimeout: '30' });
  const { UUID } = await lambda.send(
    new CreateEventSourceMappingCommand({ FunctionName: 'consumer', EventSourceArn: QueueArn, BatchSize: 1 }),
  );
  await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody }));
  return { UUID: UUID!, QueueUrl };
}

const lastProcessingResult = (UUID: string) =>
  lambda.send(new GetEventSourceMappingCommand({ UUID })).then((mapping) => mapping.LastProcessingResult);

async function nextMessage(QueueUrl: string) {
  let found: unknown;
  await expect.poll(async () => (found = (await bodies(sqs, QueueUrl))[0]), { timeout: 15_000 }).toBeDefined();
  return found;
}

const invocationsOf = (functionName: string, phase: 'started' | 'completed') =>
  eventsOf(functionName).filter((event) => event.kind === 'invocation' && event.phase === phase);

// A first retry's 1 s backoff, with margin
const pastFirstRetry = () => new Promise((resolve) => setTimeout(resolve, 2_500));

const bucketExists = (Bucket: string) => s3.send(new HeadBucketCommand({ Bucket })).then(() => true, () => false);

async function messagesLeft(QueueUrl: string) {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(Attributes!.ApproximateNumberOfMessages) + Number(Attributes!.ApproximateNumberOfMessagesNotVisible);
}

describe('Lambda', () => {
  beforeAll(async () => {
    region = await createTestRegion({ port: await regionPort(), lambda: observer });
    const config = clientConfig({ requestHandler: requestHandler(region) });
    // One attempt, so a throttle is seen rather than retried until it clears
    lambda = new LambdaClient({ ...config, maxAttempts: 1 });
    s3 = new S3Client({ ...config, forcePathStyle: true });
    sqs = new SQSClient(config);
  }, 60_000);

  afterAll(async () => {
    await region?.stop();
  });

  it('runs a function created with the SDK, warm on the second call', async () => {
    await createFunction('echo');
    const first = await invoke('echo', { hello: 'world' });
    expect(first.status).toBe(200);
    expect(first.error).toBeUndefined();
    expect(first.payload).toEqual({ calls: 1, functionName: 'echo', remaining: true, runtime: 'AWS_Lambda_nodejs22.x', event: { hello: 'world' } });
    expect((await invoke('echo', {})).payload.calls).toBe(2);
  }, 30_000);

  it('tells an observer about the environment and each invocation, cold then warm', async () => {
    await createFunction('observed');
    await invoke('observed', { first: 1 });
    await invoke('observed', {});
    const [started, cold, coldDone, warm, warmDone, ...rest] = eventsOf('observed');
    expect(rest).toEqual([]);
    expect(started).toEqual({ kind: 'environment', functionName: 'observed', environment: expect.any(String), phase: 'started' });
    const environment = (started as { environment: string }).environment;
    expect(cold).toMatchObject({ kind: 'invocation', phase: 'started', environment, event: '{"first": 1}', coldStart: true });
    expect(coldDone).toMatchObject({ kind: 'invocation', phase: 'completed', environment, failed: false, initMs: expect.any(Number) });
    expect(warm).toMatchObject({ kind: 'invocation', phase: 'started', environment, coldStart: false });
    expect(warmDone).toMatchObject({ kind: 'invocation', phase: 'completed', environment, failed: false, initMs: undefined });
    expect(tagged).toContainEqual({ text: expect.stringContaining('handling {"first":1}'), functionName: 'observed', environment });
  }, 30_000);

  it('gives a function fresh environments after its configuration changes', async () => {
    const code = 'export const handler = async () => ({ greeting: process.env.GREETING });';
    await createFunction('configured', { Environment: { Variables: { GREETING: 'before' } } }, code);
    expect((await invoke('configured', {})).payload).toEqual({ greeting: 'before' });
    await lambda.send(
      new UpdateFunctionConfigurationCommand({ FunctionName: 'configured', Environment: { Variables: { GREETING: 'after' } } }),
    );
    expect((await invoke('configured', {})).payload).toEqual({ greeting: 'after' });
  }, 30_000);

  it('runs a handler that imports its neighbours', async () => {
    const files = {
      'index.mjs': "import { greet } from './lib/greet.mjs';\nexport const handler = async (event) => ({ greeting: greet(event.name) });",
      'lib/greet.mjs': "import { mark } from '../mark.mjs';\nexport const greet = (name) => `hello ${name}${mark}`;",
      'mark.mjs': "export const mark = '!';",
    };
    await createFunction('neighbours', { Code: { ZipFile: zipOfFiles(files) } });
    const { error, payload } = await invoke('neighbours', { name: 'world' });
    expect(error).toBeUndefined();
    expect(payload).toEqual({ greeting: 'hello world!' });
  }, 30_000);

  // DynamoDB, since a client made with no options can't be told S3's path-style addressing
  it('gives a handler the SDK it imports bare, pointed at the region', async () => {
    const code = `import { DynamoDBClient, CreateTableCommand, ListTablesCommand } from '@aws-sdk/client-dynamodb';
export const handler = async (event) => {
  const dynamodb = new DynamoDBClient({});
  await dynamodb.send(new CreateTableCommand({
    TableName: event.table,
    AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    BillingMode: 'PAY_PER_REQUEST',
  }));
  const { TableNames } = await dynamodb.send(new ListTablesCommand({}));
  return TableNames;
};`;
    await createFunction('bare-sdk', {}, code);
    const { error, payload } = await invoke('bare-sdk', { table: 'from-a-bare-client' });
    expect(error).toBeUndefined();
    expect(payload).toContain('from-a-bare-client');
  }, 30_000);

  it('answers ResourceNotFoundException for an unknown function', async () => {
    await expect(invoke('absent', {})).rejects.toBeInstanceOf(ResourceNotFoundException);
  });

  it('lets a handler call the region while its own invocation is pending', async () => {
    expect((await invoke('echo', { bucket: 'made-by-lambda' })).payload).toEqual({ created: 200 });
    await expect(s3.send(new HeadBucketCommand({ Bucket: 'made-by-lambda' }))).resolves.toBeDefined();
  });

  it("reports a thrown handler as an unhandled function error, with the handler's own error type and stack", async () => {
    const thrown = await invoke('echo', { throw: true });
    expect(thrown.status).toBe(200);
    expect(thrown.error).toBe('Unhandled');
    expect(thrown.payload).toEqual({ errorType: 'Error', errorMessage: 'handler failed', stackTrace: expect.any(Array) });
    // V8 starts a stack with the message and Firefox doesn't, but both name the throwing function
    expect(thrown.payload.stackTrace).toContainEqual(expect.stringContaining('handler'));
  });

  it("returns the handler's log with LogType Tail", async () => {
    const tailed = await invoke('echo', { tail: 1 }, { LogType: 'Tail' });
    expect(tailed.log).toContain('handling {"tail":1}');
  });

  it('times out with Lambda’s message, and the next invocation still runs', async () => {
    await createFunction('slow', { Timeout: 1 });
    const late = await invoke('slow', { sleep: 1500 });
    expect(late.error).toBe('Unhandled');
    expect(late.payload).toEqual({ errorType: 'Runtime.ExitError', errorMessage: 'Task timed out after 1.00 seconds' });
    // A fresh environment: the timed-out one was not reused
    expect((await invoke('slow', {})).payload.calls).toBe(1);
    expect(eventsOf('slow')).toContainEqual(expect.objectContaining({ phase: 'completed', failed: true }));
    await expect
      .poll(() => eventsOf('slow').filter((event) => event.kind === 'environment' && event.phase === 'stopped'))
      .toEqual([expect.objectContaining({ reason: expect.any(String) })]);
  }, 30_000);

  it('throttles past the reserved concurrency', async () => {
    await createFunction('single');
    await lambda.send(
      new PutFunctionConcurrencyCommand({ FunctionName: 'single', ReservedConcurrentExecutions: 1 }),
    );
    const outcomes = await Promise.allSettled([
      invoke('single', { sleep: 500 }),
      invoke('single', { sleep: 500 }),
    ]);
    const refused = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toBeInstanceOf(TooManyRequestsException);
  }, 30_000);

  it('accepts an Event invocation before the handler runs it', async () => {
    const accepted = await invoke('echo', { bucket: 'made-asynchronously' }, { InvocationType: 'Event' });
    expect(accepted.status).toBe(202);
    await expect.poll(() => bucketExists('made-asynchronously'), { timeout: 10_000 }).toBe(true);
  });

  it('retries a failed Event invocation twice, then sends it to the dead-letter queue', async () => {
    const { QueueUrl, QueueArn } = await createQueue(sqs, 'dead-letters');
    await createFunction('doomed', { DeadLetterConfig: { TargetArn: QueueArn } });
    await invoke('doomed', { throw: true }, { InvocationType: 'Event' });
    expect(await nextMessage(QueueUrl)).toMatchObject({
      requestContext: { condition: 'RetriesExhausted' },
      requestPayload: { throw: true },
      responseContext: { functionError: 'Unhandled' },
    });
    expect(invocationsOf('doomed', 'completed')).toHaveLength(3);
  }, 30_000);

  it.each([
    { put: 'without a qualifier', queue: 'on-failure', name: 'once', qualifier: {} },
    { put: 'for $LATEST', queue: 'latest-failures', name: 'latest', qualifier: { Qualifier: '$LATEST' } },
  ])('sends a failed Event invocation to the OnFailure destination of a config put $put', async ({ queue, name, qualifier }) => {
    const { QueueUrl, QueueArn } = await createQueue(sqs, queue);
    await createFunction(name);
    await lambda.send(
      new PutFunctionEventInvokeConfigCommand({
        FunctionName: name,
        ...qualifier,
        MaximumRetryAttempts: 0,
        DestinationConfig: { OnFailure: { Destination: QueueArn } },
      }),
    );
    await invoke(name, { throw: true }, { InvocationType: 'Event' });
    expect(await nextMessage(QueueUrl)).toMatchObject({ requestPayload: { throw: true } });
    expect(invocationsOf(name, 'completed')).toHaveLength(1);
  }, 30_000);

  it('stops retrying an Event invocation once an attempt succeeds', async () => {
    const { QueueUrl, QueueArn } = await createQueue(sqs, 'never-used');
    const code = `
      export const handler = async () => {
        const url = process.env.AWS_ENDPOINT_URL + '/retried-once';
        const headers = { authorization: ${JSON.stringify(authorization('s3'))} };
        if ((await fetch(url, { method: 'HEAD', headers })).status !== 404) return;
        await fetch(url, { method: 'PUT', headers });
        throw new Error('first attempt');
      };
    `;
    await createFunction('flaky', { DeadLetterConfig: { TargetArn: QueueArn } }, code);
    await invoke('flaky', {}, { InvocationType: 'Event' });
    await expect.poll(() => invocationsOf('flaky', 'completed').length, { timeout: 15_000 }).toBe(2);
    expect(invocationsOf('flaky', 'completed')).toMatchObject([{ failed: true }, { failed: false }]);
    expect(await messagesLeft(QueueUrl)).toBe(0);
  }, 30_000);

  it('runs a function from an SQS event source mapping, deleting only a batch that succeeded', async () => {
    await createFunction('consumer', {}, CONSUMER);
    const [ok, failed] = await Promise.all([
      mapQueue('orders', 'made-by-mapping'),
      mapQueue('refunds', 'made-before-failing fail'),
    ]);

    await expect.poll(() => lastProcessingResult(ok.UUID), { timeout: 10_000 }).toBe('OK - 1 records');
    await expect.poll(() => lastProcessingResult(failed.UUID), { timeout: 10_000 }).toBe('FAILED');
    await expect(s3.send(new HeadBucketCommand({ Bucket: 'made-by-mapping' }))).resolves.toBeDefined();
    await expect(s3.send(new HeadBucketCommand({ Bucket: 'made-before-failing' }))).resolves.toBeDefined();
    expect(await messagesLeft(ok.QueueUrl)).toBe(0);
    expect(await messagesLeft(failed.QueueUrl)).toBe(1);
  }, 30_000);

  it('runs mapped batches concurrently, up to the reserved concurrency', async () => {
    await createFunction('drainer', {}, 'export const handler = () => new Promise((resolve) => setTimeout(resolve, 300));');
    await lambda.send(new PutFunctionConcurrencyCommand({ FunctionName: 'drainer', ReservedConcurrentExecutions: 5 }));
    const { QueueUrl, QueueArn } = await createQueue(sqs, 'backlog');
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: String(index) }))),
    );
    await lambda.send(
      new CreateEventSourceMappingCommand({ FunctionName: 'drainer', EventSourceArn: QueueArn, BatchSize: 1 }),
    );

    await expect.poll(() => eventsOf('drainer').length, { timeout: 5_000 }).toBeGreaterThan(0);
    const started = performance.now();
    await expect.poll(() => messagesLeft(QueueUrl), { timeout: 10_000, interval: 20 }).toBe(0);
    expect(performance.now() - started).toBeLessThan(1_500);

    let running = 0;
    let peak = 0;
    for (const event of eventsOf('drainer')) {
      if (event.kind !== 'invocation') continue;
      running += event.phase === 'started' ? 1 : -1;
      peak = Math.max(peak, running);
    }
    expect(peak).toBe(5);
  }, 30_000);

  it('keeps only the messages a handler reports as batch item failures', async () => {
    const code = `
      export const handler = async (event) => ({
        batchItemFailures: event.Records.filter((record) => record.body === 'fail').map((record) => ({ itemIdentifier: record.messageId })),
      });
    `;
    await createFunction('partial', {}, code);
    const { QueueUrl, QueueArn } = await createQueue(sqs, 'partly-failing', { VisibilityTimeout: '30' });
    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'ok' }));
    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'fail' }));
    const { UUID } = await lambda.send(
      new CreateEventSourceMappingCommand({
        FunctionName: 'partial',
        EventSourceArn: QueueArn,
        BatchSize: 2,
        FunctionResponseTypes: ['ReportBatchItemFailures'],
      }),
    );

    await expect.poll(() => lastProcessingResult(UUID!), { timeout: 10_000 }).toBe('OK - 1 records, 1 partial failures');
    expect(await messagesLeft(QueueUrl)).toBe(1);
  }, 30_000);

  it('runs the function an EventBridge rule targets', async () => {
    const events = new EventBridgeClient(clientConfig({ requestHandler: requestHandler(region) }));
    const { FunctionArn } = await createFunction('ruled');
    await events.send(new PutRuleCommand({ Name: 'to-echo', EventPattern: JSON.stringify({ source: ['orders'] }) }));
    await events.send(
      new PutTargetsCommand({ Rule: 'to-echo', Targets: [{ Id: 'ruled', Arn: FunctionArn, Input: JSON.stringify({ bucket: 'made-by-a-rule' }) }] }),
    );
    await events.send(new PutEventsCommand({ Entries: [{ Source: 'orders', DetailType: 'placed', Detail: '{}' }] }));
    await expect.poll(() => bucketExists('made-by-a-rule'), { timeout: 10_000 }).toBe(true);
  });

  it('runs the function a Step Functions Task names, and catches its error', async () => {
    const sfn = new SFNClient(clientConfig({ requestHandler: requestHandler(region) }));
    const { FunctionArn } = await createFunction('stepped');
    const definition = {
      StartAt: 'Run',
      States: {
        Run: { Type: 'Task', Resource: FunctionArn, Catch: [{ ErrorEquals: ['Error'], Next: 'Caught' }], End: true },
        Caught: { Type: 'Pass', End: true },
      },
    };
    expect(await execute(sfn, 'stepped', definition, { step: 1 })).toEqual({
      status: 'SUCCEEDED',
      output: expect.objectContaining({ functionName: 'stepped', event: { step: 1 } }),
    });
    expect(await execute(sfn, 'stepped-throws', definition, { throw: true })).toEqual({
      status: 'SUCCEEDED',
      output: { Error: 'Error', Cause: expect.stringContaining('handler failed') },
    });
  }, 30_000);

  it('runs a function from a Kinesis event source mapping', async () => {
    const kinesis = new KinesisClient(clientConfig({ requestHandler: requestHandler(region) }));
    const code = `
      export const handler = async (event) => {
        for (const record of event.Records) {
          const bucket = atob(record.kinesis.data);
          await fetch(process.env.AWS_ENDPOINT_URL + '/' + bucket, { method: 'PUT', headers: { authorization: ${JSON.stringify(authorization('s3'))} } });
        }
      };
    `;
    await createFunction('streamer', {}, code);
    await kinesis.send(new CreateStreamCommand({ StreamName: 'clicks', ShardCount: 1 }));
    const { StreamDescription } = await kinesis.send(new DescribeStreamCommand({ StreamName: 'clicks' }));
    await lambda.send(
      new CreateEventSourceMappingCommand({
        FunctionName: 'streamer',
        EventSourceArn: StreamDescription!.StreamARN,
        StartingPosition: 'TRIM_HORIZON',
        BatchSize: 1,
      }),
    );
    await kinesis.send(new PutRecordCommand({ StreamName: 'clicks', PartitionKey: 'user', Data: new TextEncoder().encode('made-by-a-stream') }));
    await expect.poll(() => bucketExists('made-by-a-stream'), { timeout: 15_000 }).toBe(true);
  }, 30_000);

  it('runs a function from a DynamoDB Streams event source mapping', async () => {
    const dynamodb = new DynamoDBClient(clientConfig({ requestHandler: requestHandler(region) }));
    const code = `
      export const handler = async (event) => {
        for (const record of event.Records) {
          const bucket = record.dynamodb.NewImage.bucket.S;
          await fetch(process.env.AWS_ENDPOINT_URL + '/' + bucket, { method: 'PUT', headers: { authorization: ${JSON.stringify(authorization('s3'))} } });
        }
      };
    `;
    await createFunction('table-watcher', {}, code);
    const { TableDescription } = await dynamodb.send(
      new CreateTableCommand({
        TableName: 'watched',
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
        StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' },
      }),
    );
    await lambda.send(
      new CreateEventSourceMappingCommand({
        FunctionName: 'table-watcher',
        EventSourceArn: TableDescription!.LatestStreamArn,
        StartingPosition: 'TRIM_HORIZON',
        BatchSize: 1,
      }),
    );
    await dynamodb.send(new PutItemCommand({ TableName: 'watched', Item: { id: { S: '1' }, bucket: { S: 'made-by-a-table' } } }));
    await expect.poll(() => bucketExists('made-by-a-table'), { timeout: 15_000 }).toBe(true);
  }, 30_000);

  const createPythonFunction = (FunctionName: string, code = PYTHON_HANDLER, extra: object = {}) =>
    createFunction(FunctionName, { Runtime: 'python3.13', Handler: 'index.handler', Code: { ZipFile: zipOf('index.py', code) }, ...extra });

  it("runs a Python function, warm on the second call, with Lambda's context and its prints in the log", async () => {
    await createPythonFunction('snake');
    const first = await invoke('snake', { hello: 'world' }, { LogType: 'Tail' });
    expect(first.error).toBeUndefined();
    expect(first.payload).toEqual({
      calls: 1,
      functionName: 'snake',
      requestId: expect.any(String),
      remaining: true,
      runtime: 'AWS_Lambda_python3.13',
      event: { hello: 'world' },
    });
    expect(first.log).toContain('handling {"hello": "world"}');
    expect((await invoke('snake', {})).payload.calls).toBe(2);
  }, 30_000);

  it('gives a Python handler boto3, pointed at the region', async () => {
    await createPythonFunction('boto', BOTO3_HANDLER);
    const { error, payload } = await invoke('boto', { bucket: 'made-by-boto3' });
    expect(error).toBeUndefined();
    expect(payload).toEqual({ body: 'hello from boto3' });
    expect(await bucketExists('made-by-boto3')).toBe(true);
  }, 30_000);

  it('reports a raised Python exception as an unhandled function error, with its type and traceback', async () => {
    const thrown = await invoke('snake', { raise: true }, { LogType: 'Tail' });
    expect(thrown.error).toBe('Unhandled');
    expect(thrown.payload).toEqual({ errorType: 'ValueError', errorMessage: 'handler failed', stackTrace: expect.any(Array) });
    expect(thrown.payload.stackTrace.join('')).toContain('raise ValueError("handler failed")');
    expect(thrown.log).toContain('[ERROR] ValueError: handler failed');
    expect(thrown.log).toContain('raise ValueError("handler failed")');
  }, 30_000);

  it('runs a Python handler named by a path, which imports from the package root', async () => {
    const files = {
      'src/app.py': 'from helpers import greet\n\n\ndef handler(event, context):\n    return {"greeting": greet(event["name"])}\n',
      'helpers.py': 'def greet(name):\n    return f"hello {name}!"\n',
    };
    await createPythonFunction('snake-neighbours', '', { Handler: 'src/app.handler', Code: { ZipFile: zipOfFiles(files) } });
    const { error, payload } = await invoke('snake-neighbours', { name: 'world' });
    expect(error).toBeUndefined();
    expect(payload).toEqual({ greeting: 'hello world!' });
  }, 30_000);

  it("fails an invocation whose Python handler cannot load, in Lambda's words", async () => {
    await createPythonFunction('snake-import', 'import nothing_here\n');
    const failed = await invoke('snake-import', {});
    expect(failed.error).toBe('Unhandled');
    expect(failed.payload.errorMessage).toBe("Unable to import module 'index': No module named 'nothing_here'");
    await createPythonFunction('snake-missing', 'x = 1\n');
    expect((await invoke('snake-missing', {})).payload.errorMessage).toBe("Handler 'handler' missing on module 'index'");
  }, 60_000);

  it('refuses a custom runtime, whose bootstrap MiniStack would spawn', async () => {
    await createFunction('custom', { Runtime: 'provided.al2023', Handler: 'bootstrap', Code: { ZipFile: zipOf('bootstrap', '#!/bin/sh') } });
    const refused = await invoke('custom', {});
    expect(refused.error).toBe('Unhandled');
    expect(refused.payload.errorMessage).toContain('provided.al2023');
  });

  it('fails an invocation whose handler cannot load', async () => {
    await createFunction('broken', {}, 'export const notHandler = 1');
    const failed = await invoke('broken', {});
    expect(failed.error).toBe('Unhandled');
    expect(failed.payload.errorMessage).toContain('does not export a function named "handler"');
  });

  // Last in the block: the reset empties the region the tests above share
  it('still retries an Event invocation that was waiting when the region reset, as MiniStack does', async () => {
    await createFunction('remembered');
    await invoke('remembered', { throw: true }, { InvocationType: 'Event' });
    await expect.poll(() => invocationsOf('remembered', 'completed').length, { timeout: 10_000 }).toBe(1);
    await region.reset();
    await pastFirstRetry();
    expect(invocationsOf('remembered', 'completed')).toHaveLength(2);
  }, 30_000);

  it('fails an invocation running when the region resets, and cold-starts the next', async () => {
    await createFunction('interrupted');
    const running = invoke('interrupted', { sleep: 5_000 });
    await expect.poll(() => invocationsOf('interrupted', 'started').length, { timeout: 10_000 }).toBe(1);
    await region.reset();
    const failed = await running;
    expect(failed.error).toBe('Unhandled');
    expect(failed.payload).toEqual({ errorType: 'Runtime.HandlerError', errorMessage: 'Runtime exited with error: the region reset' });
    await createFunction('interrupted');
    expect((await invoke('interrupted', {})).payload.calls).toBe(1);
  }, 30_000);

  it('stops a mapped batch the reset interrupts before it writes to the fresh region', async () => {
    const code = `
      export const handler = async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await fetch(process.env.AWS_ENDPOINT_URL + '/written-after-reset', { method: 'PUT', headers: { authorization: ${JSON.stringify(authorization('s3'))} } });
      };
    `;
    await createFunction('late-writer', {}, code);
    const { QueueUrl, QueueArn } = await createQueue(sqs, 'late-writes');
    await lambda.send(new CreateEventSourceMappingCommand({ FunctionName: 'late-writer', EventSourceArn: QueueArn, BatchSize: 1 }));
    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: 'go' }));
    await expect.poll(() => invocationsOf('late-writer', 'started').length, { timeout: 10_000 }).toBe(1);
    await region.reset();
    // Already stopped when reset resolves, so the write that follows the sleep never comes
    expect(eventsOf('late-writer')).toContainEqual(expect.objectContaining({ phase: 'stopped', reason: 'the region reset' }));
    await expect(s3.send(new HeadBucketCommand({ Bucket: 'written-after-reset' }))).rejects.toThrow();
  }, 30_000);
});
