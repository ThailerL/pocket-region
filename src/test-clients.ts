// Test helpers that run in Node and in a page alike, so nothing here may import node:
import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { strToU8, zipSync } from 'fflate';
import type { Region } from './core.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Every client points at the same place with the same throwaway credentials: only the
// transport differs, so only that belongs at the call site
export const clientConfig = (extra: object = {}) => ({
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  ...extra,
});

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

export const zipOf = (name: string, content: string) => zipSync({ [name]: strToU8(content) });

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
