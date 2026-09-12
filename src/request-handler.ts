import type { Dispatcher } from './core.ts';

// Only dispatch is needed, so a page's region fits too

// The AWS SDK's shapes, structurally: taking @smithy/types as a dependency would put the
// SDK's release cadence in front of this package's
type SdkHttpRequest = {
  method: string;
  path: string;
  query?: Record<string, string | string[] | null>;
  headers: Record<string, string>;
  body?: unknown;
};

type SdkHttpResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array>;
};

export type RegionRequestHandler = {
  handle(request: SdkHttpRequest): Promise<{ response: SdkHttpResponse }>;
  updateHttpClientConfig(): void;
  httpHandlerConfigs(): Record<string, never>;
};

function queryString(query: SdkHttpRequest['query']) {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query ?? {})) {
    const name = encodeURIComponent(key);
    if (value === null) parts.push(name);
    else for (const item of Array.isArray(value) ? value : [value]) {
      parts.push(`${name}=${encodeURIComponent(item)}`);
    }
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

async function requestBytes(body: unknown): Promise<Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (body instanceof Uint8Array) return body;
  const chunks: BlobPart[] = [];
  if (typeof body === 'string') chunks.push(body);
  // A stream upload: Node's Readable and a web ReadableStream are both async iterable
  else for await (const chunk of body as AsyncIterable<BlobPart>) chunks.push(chunk);
  return new Blob(chunks).bytes();
}

// The SDK reads a streaming response (GetObject) through Stream.Readable in Node or a
// ReadableStream in a page; a bare Uint8Array is rejected in both
const streamOf = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

// Pass as `requestHandler` to any AWS SDK v3 client: its requests reach the region as
// function calls, so page code needs no socket and no endpoint is listening
export function requestHandler(region: Dispatcher): RegionRequestHandler {
  return {
    async handle(request) {
      const response = await region.dispatch({
        method: request.method,
        path: request.path + queryString(request.query),
        headers: request.headers,
        body: await requestBytes(request.body),
      });
      return {
        response: {
          statusCode: response.status,
          headers: response.headers,
          body: streamOf(response.body),
        },
      };
    },
    updateHttpClientConfig() {},
    httpHandlerConfigs() {
      return {};
    },
  };
}
