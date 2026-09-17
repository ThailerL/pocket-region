---
title: Connecting clients
description: requestHandler for AWS SDK clients, serve for anything that needs an endpoint, and dispatch underneath both.
---

A region has no endpoint of its own. There are three ways to reach it:

| | Use it for |
| --- | --- |
| `requestHandler(region)` | AWS SDK v3 clients in the same process or page |
| `serve(region, options?)` | Anything that needs a URL: another process, another language, the real AWS CLI. Node only |
| `region.dispatch(request)` | Raw wire-protocol requests, and wrapping a region |

All three accept any object with a `dispatch` method, not only a region: a
[`Dispatcher`](#dispatch).

## `requestHandler`

```ts
requestHandler(region: Dispatcher): RegionRequestHandler
```

Pass the result as `requestHandler` to any AWS SDK v3 client. Requests become function calls,
so nothing listens and nothing is dialed.

```js
import { requestHandler } from 'pocket-region/node';
import { S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({ requestHandler: requestHandler(region) });
```

- **`region` and `credentials`** are still required, because the SDK refuses to build a request
  without them, but any values do. The emulator routes a request by the credential scope in its
  `Authorization` header and never checks the signature. In Node they can come from the
  environment or `~/.aws` as usual; a page has to pass them, or use `clientConfig(region)`,
  which is `requestHandler` plus `us-east-1` and throwaway credentials, as one config to pass or
  spread.
- **`endpoint`** isn't needed. Without one, the SDK addresses AWS's own host names, such as
  `photos.s3.us-east-1.amazonaws.com`, which the emulator understands, and nothing is dialed.
- **With an `endpoint`** such as `http://localhost:4566`, S3 also needs `forcePathStyle: true`.
  Otherwise the bucket name moves into a host name like `photos.localhost`, which the emulator
  rejects as an invalid bucket.

Request bodies can be a string, a `Uint8Array`, a Node `Readable`, or a web `ReadableStream`.
Streams are read to the end before the request is handed over. Response bodies come back as a
`ReadableStream`, which is what the SDK expects for streaming responses such as `GetObject`.

## `serve`

```ts
serve(region: Dispatcher & { port?: number }, options?: ServeOptions): Promise<RegionServer>
```

```js
import { createRegion, serve } from 'pocket-region/node';

const region = await createRegion();
const server = await serve(region);
// aws --endpoint-url http://127.0.0.1:4566 s3 ls
await server.close();
```

| Option | Default | |
| --- | --- | --- |
| `port` | `region.port`, else `4566` | Listening on the region's own port means a client following an SQS queue URL arrives here. |
| `host` | `'127.0.0.1'` | |
| `maxBodyBytes` | 64 MiB | A larger body gets `413`. A declared `Content-Length` is refused before any of it is read. |

It resolves with:

| | |
| --- | --- |
| `url` | `http://<host>:<port>` |
| `port` | The port it listens on, useful after passing `0` |
| `unref()` | Lets Node exit while the server is still listening |
| `close()` | Closes open keep-alive connections, then the server |

If `dispatch` throws, the caller gets `500` with `{ "message": ... }`.

## `dispatch`

```ts
type RegionRequest = {
  method: string;
  path: string;                       // including the query string
  headers: Record<string, string>;
  body?: Uint8Array;
};

type RegionResponse = {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
};

type Dispatch = (request: RegionRequest) => Promise<RegionResponse>;
type Dispatcher = { dispatch: Dispatch };
```

```js
const response = await region.dispatch({
  method: 'GET',
  path: '/photos/cat.txt',
  headers: {
    host: 'localhost:4566',
    authorization: 'AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=x',
  },
});
```

A request needs a `host` header and an `authorization` header shaped like SigV4, since the
emulator routes on the service named in its credential scope. The signature itself can be
anything.

### Wrapping a region

`requestHandler`, `serve`, and `awsCli` only ever call `dispatch`. An object with its own
`dispatch` can refuse, log, or count requests before they reach the emulator:

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
