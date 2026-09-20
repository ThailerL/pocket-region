// Test helpers that run in Node and in a page alike, so nothing here may import node:
import { CreateStateMachineCommand, DescribeExecutionCommand, type SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { strToU8, zipSync } from 'fflate';
import { AWS_DEFAULTS } from './client-config.ts';
import type { Region } from './core.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Every client points at the same place with the same throwaway credentials: only the
// transport differs, so only that belongs at the call site
export const clientConfig = (extra: object = {}) => ({
  ...AWS_DEFAULTS,
  endpoint: 'http://localhost:4566',
  ...extra,
});

export const allow = (Action: string, Resource = '*') =>
  JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action, Resource }] });

// SigV4's shape without a signature: the region routes on the credential scope and never
// verifies one
export const authorization = (service: string) =>
  `AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/${service}/aws4_request, SignedHeaders=host, Signature=test`;

export function s3(method: string, key: string, body: string | undefined, target: Region) {
  return target.dispatch({
    method,
    path: key,
    headers: { host: 'localhost:4566', authorization: authorization('s3') },
    body: body === undefined ? undefined : encoder.encode(body),
  });
}

export async function jsonApi(service: 'sqs' | 'dynamodb', operation: string, body: object, target: Region) {
  const response = await target.dispatch({
    method: 'POST',
    path: '/',
    headers: {
      host: 'localhost:4566',
      authorization: authorization(service),
      'content-type': 'application/x-amz-json-1.0',
      'x-amz-target': operation,
    },
    body: encoder.encode(JSON.stringify(body)),
  });
  return { status: response.status, body: JSON.parse(decoder.decode(response.body)) };
}

export const zipOfFiles = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)])));
export const zipOf = (name: string, content: string) => zipOfFiles({ [name]: content });

export async function createQueue(sqs: SQSClient, QueueName: string, Attributes?: Record<string, string>) {
  const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName, Attributes }));
  const { Attributes: created } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }),
  );
  return { QueueUrl: QueueUrl!, QueueArn: created!.QueueArn! };
}

// Received messages stay invisible for the queue's visibility timeout, so a poll sees each once
export async function bodies(sqs: SQSClient, QueueUrl: string) {
  const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10 }));
  return Messages.map((message) => JSON.parse(message.Body!));
}

export async function startExecution(sfn: SFNClient, name: string, definition: object, input: object = {}) {
  const { stateMachineArn } = await sfn.send(
    new CreateStateMachineCommand({ name, roleArn: 'arn:aws:iam::000000000000:role/states', definition: JSON.stringify(definition) }),
  );
  const { executionArn } = await sfn.send(new StartExecutionCommand({ stateMachineArn, input: JSON.stringify(input) }));
  return executionArn!;
}

export async function finished(sfn: SFNClient, executionArn: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { status, output } = await sfn.send(new DescribeExecutionCommand({ executionArn }));
    if (status !== 'RUNNING') return { status, output: output === undefined ? undefined : JSON.parse(output) };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${executionArn} still RUNNING after ${timeout} ms`);
}

export const execute = async (sfn: SFNClient, name: string, definition: object, input?: object) =>
  finished(sfn, await startExecution(sfn, name, definition, input));
