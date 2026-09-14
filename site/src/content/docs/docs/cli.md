---
title: The aws CLI
description: awsCli runs aws commands against a region and returns their output, for tests and for an AWS console in a page.
---

```ts
import { awsCli } from 'pocket-region/node';     // Node
import { awsCli } from 'pocket-region/browser';  // a page

awsCli(region: { dispatch: Region['dispatch'] }, options?: AwsCliOptions):
  (command: string | string[]) => Promise<CliResult>
```

`awsCli` returns a function that runs one `aws` command. The output is returned rather than
printed, so a test can assert on it and a page can render it.

```js
const aws = awsCli(region);
await aws('s3 mb s3://notes');
const { stdout } = await aws(['sqs', 'create-queue', '--queue-name', 'orders']);
```

## Commands

- **`<service> <operation> --flags`** calls the SDK operation of the same name. Any service
  works if its SDK client can be loaded, so `sqs create-queue` needs `@aws-sdk/client-sqs`.
  `s3api` uses the S3 client.
- **`s3 cp`, `s3 ls`, `s3 mb`, and `s3 rm`** are the high-level S3 commands. `cp` with a local
  path reads or writes through `files`.
- **`help`, `--help`, or an empty command** prints the usage text.

## Result

```ts
type CliResult = { stdout: string; stderr: string; code: number };
```

A failed command resolves with a non-zero `code` and the message on `stderr`, as the real CLI
exits. With `throwOnError`, it rejects with a `CliError` instead, whose `result` holds the same
`CliResult`.

## Options

| Option | Type | |
| --- | --- | --- |
| `throwOnError` | `boolean` | Reject on a non-zero exit, which is usually what a test wants. |
| `modules` | `Record<string, SdkModule>` | SDK client packages, keyed by SDK name, so `s3` also covers `s3api`. Without it, a client is imported the first time a command needs it. Bundlers can't follow that import, so a bundle, page, or worker must pass these. |
| `client` | `object` | Merged into every client's configuration, such as your own credentials or endpoint. S3 stays path-style whatever this says. |
| `files` | `{ read(path): Promise<Uint8Array>; write(path, bytes): Promise<void> }` | Where `s3 cp` reads and writes local paths. Node uses the file system. A page has none, and `cp` with a local path fails without this. |
| `note` | `string` | Appended to the usage text. |

```js
import * as s3 from '@aws-sdk/client-s3';
import * as sqs from '@aws-sdk/client-sqs';

const aws = awsCli(region, {
  modules: { s3, sqs },
  client: { credentials: { accessKeyId: 'node-7', secretAccessKey: 'shh' } },
});
```

A command for a service whose client can't be loaded fails with a message naming the package to
install, and the `modules` entry to pass instead.

## A region in another process

`awsCli` only calls `dispatch`, so it can reach a region running somewhere else. Serve the region
in its own process with [`serve`](/docs/clients/#serve), and give the CLI a `dispatch` that
sends each request there over HTTP:

```js
import { awsCli } from 'pocket-region/node';

const endpoint = 'http://127.0.0.1:4566';

const dispatch = async ({ method, path, headers, body }) => {
  const response = await fetch(endpoint + path, { method, headers, body });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: new Uint8Array(await response.arrayBuffer()),
  };
};

const aws = awsCli({ dispatch }, {
  client: { endpoint, credentials: { accessKeyId: 'node-7', secretAccessKey: 'x' } },
});

const { stdout, stderr, code } = await aws(process.argv.slice(2));
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = code;
```

Run as a script, this is an `aws` command for that region. The access key in `client` is
whatever the caller should be known as, which is how a region serving several callers can tell
them apart.
