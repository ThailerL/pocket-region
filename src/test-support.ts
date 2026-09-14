// Shared by the test files; excluded from the build, since it names devDependencies
import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { WORKER_RUNTIME_SOURCE } from './lambda/worker-runtime.generated.ts';

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

// A region has to be told its port before it mints a queue URL, which is before a server
// over it exists, so the port is claimed and released first
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const VENDOR = fileURLToPath(new URL('../vendor', import.meta.url));

// The page's fetch path, in Node: meta.json, the wheels and the stdlib all arrive over HTTP.
// Only Pyodide's own runtime differs, since Node resolves indexURL as a directory
export async function serveVendor() {
  const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://x');
    const file = path.join(VENDOR, pathname.replace(/^\/vendor\/?/, ''));
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
      response.writeHead(404).end();
      return;
    }
    // Nothing downstream reads content-type: fetch parses JSON regardless, and Pyodide
    // never inspects it
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };
  return {
    assetsBaseUrl: `http://127.0.0.1:${port}/vendor`,
    indexURL: fileURLToPath(new URL('../node_modules/pyodide', import.meta.url)),
    close: () => void server.close(),
  };
}

// What the worker runtime uses of a DedicatedWorkerGlobalScope, over parentPort
const WORKER_PRELUDE = `import { parentPort } from 'node:worker_threads';
const exit = process.exit.bind(process);
globalThis.self = globalThis;
globalThis.postMessage = (message) => parentPort.postMessage(message);
globalThis.close = () => exit(0);
parentPort.on('message', (data) => globalThis.onmessage?.({ data }));
`;

// The web Worker API over worker_threads, as much of it as worker-host.ts uses: postMessage
// both ways, onerror and terminate. The one script it ever runs is the embedded runtime
export function installWorkerShim() {
  const script = new URL(`data:text/javascript,${encodeURIComponent(WORKER_PRELUDE + WORKER_RUNTIME_SOURCE)}`);
  class WorkerShim {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    private readonly thread: ThreadWorker;

    constructor() {
      // The runtime forwards console output itself; a page would show this in devtools
      this.thread = new ThreadWorker(script, { stdout: true, stderr: true });
      this.thread.stdout.resume();
      this.thread.stderr.resume();
      this.thread.on('message', (data) => this.onmessage?.({ data }));
      this.thread.on('error', (error) => this.onerror?.({ message: error.message }));
    }

    postMessage(message: unknown) {
      this.thread.postMessage(message);
    }

    terminate() {
      void this.thread.terminate();
    }
  }
  (globalThis as { Worker?: unknown }).Worker = WorkerShim;
}
