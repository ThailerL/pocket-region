import http from 'node:http';
import { DEFAULT_PORT, type Dispatcher } from './core.ts';

export type ServeOptions = {
  // Defaults to the port the region mints its queue URLs with, so a client following one
  // arrives here
  port?: number;
  host?: string;
  maxBodyBytes?: number;
};

export type RegionServer = {
  url: string;
  port: number;
  close(): Promise<void>;
};

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;

const fail = (response: http.ServerResponse, status: number, message: string) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ message }));
};

// An endpoint for callers that cannot be handed a request handler: another process, another
// language, or the real AWS CLI with --endpoint-url
export function serve(
  region: Dispatcher & { port?: number },
  options: ServeOptions = {},
): Promise<RegionServer> {
  const { host = DEFAULT_HOST, maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = options;

  const server = http.createServer(async (request, response) => {
    const declared = Number(request.headers['content-length']);
    const tooLarge = (size: number) => {
      fail(response, 413, `request body is larger than ${maxBodyBytes} bytes`);
      request.destroy();
      return size;
    };
    // The declared length refuses an upload before reading it; the running total covers a
    // chunked body, which declares nothing
    if (declared > maxBodyBytes) return void tooLarge(declared);

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > maxBodyBytes) return void tooLarge(size);
      chunks.push(chunk);
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers[key] = value;
    }
    try {
      const answer = await region.dispatch({
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        headers,
        body: Buffer.concat(chunks),
      });
      response.writeHead(answer.status, answer.headers);
      response.end(answer.body);
    } catch (error) {
      fail(response, 500, (error as Error).message);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? region.port ?? DEFAULT_PORT, host, () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://${host}:${port}`,
        port,
        close: () =>
          new Promise((done, failed) => {
            // Keep-alive sockets from an SDK client would hold the close open
            server.closeAllConnections();
            server.close((error) => (error ? failed(error) : done()));
          }),
      });
    });
  });
}
