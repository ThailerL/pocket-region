---
title: The region
description: The options a region boots with, and the port, dispatch, reset, save, and stop of the region it returns.
---

`createRegion` boots the emulator and resolves once it can answer requests. There are two
entries with the same name: one for Node and one for a page.

```ts
import { createRegion } from 'pocket-region/node';     // Node
createRegion(options?: NodeRegionOptions): Promise<Region>

import { createRegion } from 'pocket-region/browser';  // a page
createRegion(options?: BrowserRegionOptions): Promise<Region>
```

In Node, a region boots in about half a second.
In a browser, a first visit downloads about 15 MB, and after that a region boots in about half a
second.

In a page, the region runs in a Web Worker, so nothing the emulator does stalls the page, and the
`Region` you get back posts each call to it. The worker starts from a `blob:` URL that imports
`dist/region/worker.js` from wherever `dist/browser.js` was loaded. That needs three things from a
page: a Content Security Policy, if it has one, that allows `worker-src blob:` and the package's
origin in `script-src`; a server that answers `.wasm` files as `application/wasm`; and, from a
CDN, the plain `dist/browser.js` file rather than a bundled build such as jsDelivr's `+esm`, which
moves the file's URL.

## Options

| Option | Type | Entry | Default | |
| --- | --- | --- | --- | --- |
| `port` | `number` | both | `4566` | The port the region writes into the URLs it hands out, such as SQS queue URLs. `serve` listens here by default. In Node, the region also serves itself on `127.0.0.1` at this port once a function's code is first deployed, so handlers in child processes can reach it. If the port is taken by your own `serve`, that server is used instead. |
| `store` | `StateStore` | both | none | Where state is restored from at boot, and written to on `save` and `stop`. See [Stores](#stores). Without it, state lives in memory only. |
| `onOutput` | `(output: { text: string; stream: 'stdout' \| 'stderr' }) => void` | both | none | Every line the emulator prints while loading and running, and every line a Lambda handler writes, as `stdout`. The object is exported as `RegionOutput`. |
| `lambda` | `LambdaObserver` | both | none | Hooks for watching functions run. See [Lambda](/docs/lambda/#watching-functions-run). |
| `assetsBaseUrl` | `string` | browser | jsDelivr | The URL `vendor/` is served from: `meta.json`, the wheels, and the Python standard library. By default, what the page's import map maps `pocket-region/vendor/` to, and without a mapping, jsDelivr's copy of the installed release. Set either to serve `vendor/` from your own site, for example under a Content Security Policy. A relative URL resolves against the page. |
| `assetsDir` | `string` | Node | the package's `vendor/` | The directory holding `meta.json`, the wheels, and the Python standard library: Node's counterpart of `assetsBaseUrl`. |
| `indexURL` | `string` | both | see text | Where Pyodide's own runtime loads from. A page defaults to jsDelivr, at the Pyodide version the package was built with. In Node, set it only where Pyodide can't find itself from `import.meta.url`. |

`port`, `store`, `onOutput`, and `lambda` are exported from both entries as `RegionSettings`, for
code that builds options for either.

A page that can't fetch `meta.json` rejects with
`no region assets at <url> (meta.json answered <status>)`.

## The region

```ts
type Region = {
  port: number;
  dispatch(request: RegionRequest): Promise<RegionResponse>;
  reset(): Promise<void>;
  save(): Promise<void>;
  stop(): Promise<void>;
};
```

### `port`

The `port` option, or `4566`.

### `dispatch(request)`

Hands one AWS wire-protocol request to the emulator and resolves with its response. Every other
way of reaching a region is built on it. See [Connecting clients](/docs/clients/#dispatch).

### `reset()`

Empties every service, not only the ones [listed as running here](/docs/services/), using MiniStack's own reset. It takes under a
millisecond for a typical test and about 3.5 ms with 20 resources, measured in Node. It rejects
if the emulator answers with anything but `200`.

Lambda functions are deleted with everything else, and every execution environment is stopped.
An invocation still running fails with `Runtime.HandlerError`. Background work keeps running
through a reset, as it does in MiniStack: an asynchronous invocation waiting to retry still
retries, with the function it was invoked with, so its handler can write into the emptied region.

With a `store`, a reset doesn't touch the saved state. It stays until the next
`save` or `stop`, which overwrites it with the empty state.

To start every test empty, boot one region per test file and reset it before each test. A retry
one test leaves waiting can still run during the next:

```js
let region;
beforeAll(async () => { region = await createRegion(); });
beforeEach(() => region.reset());
afterAll(() => region.stop());
```

### `save()`

Writes every service's state and hands all of it to the `store`, which replaces what it held
before. It does nothing without a `store`, and nothing saves on its own.

```js
import { createRegion, directoryStore } from 'pocket-region/node';

const region = await createRegion({ store: directoryStore('./.region') });
// ... requests ...
await region.save();   // writes the state to ./.region
await region.stop();   // saves too, then shuts down
```

The next region created with the same store starts from that state. The files are MiniStack's
own per-service format. If a service can't read its file at boot, the file is renamed
`<service>.json.refused` and the service starts empty, rather than being saved over. A Pocket
Region release that updates MiniStack can also start a service empty, because MiniStack stamps a
format version on each file.

### `stop()`

Ends MiniStack's background work, including [scheduled work](/docs/services/#scheduled-work) and
asynchronous invocations waiting to retry. Then it shuts the emulator down, saves to the `store` if
there is one, and stops every Lambda environment. Once it resolves, nothing the region started
keeps Node running.

## Stores

```ts
type StateFiles = Map<string, Uint8Array>;

type StateStore = {
  load(): Promise<StateFiles>;
  replace(files: StateFiles): Promise<void>;
  close?(): Promise<void>;
};
```

Only the region calls a store's methods. Pass a store to `createRegion` and leave `load`,
`replace`, and `close` to it, the built-in stores included, since how a region uses its store may
change.

A store serves one region at a time. `createRegion` rejects with a store another region is using,
before it boots, and the store is free again once that region's `stop()` resolves or its boot
fails.

Each entry ships a store:

| Store | Entry | |
| --- | --- | --- |
| `directoryStore(dir)` | Node | Files in a directory, created if missing. A save writes each file and deletes the ones state no longer has, one file at a time. A `.lock` file names the process using it; a lock left by a process that has exited on the same machine is taken over. |
| `indexedDbStore(name)` | browser | An IndexedDB database of that name. A save replaces the previous one in a single transaction, so a tab closed partway through keeps the previous save. A [Web Lock](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) keeps other tabs and workers of the origin out, and closing the tab releases it. |

```js
import { createRegion, indexedDbStore } from 'pocket-region/browser';

const region = await createRegion({ store: indexedDbStore('my-app') });
await region.save();   // writes the state to the my-app database
```

A page can't wait for a save while it closes, so save after the changes you want to keep. A second
tab creating a region on the same database is refused until the first tab stops its region or
closes.

To keep state anywhere else, such as OPFS or a server, write your own store. `load` resolves with
everything the last `replace` was given, or an empty map before the first save. `replace` gets
every file, keyed by paths like `state/sqs.json`; any key it no longer receives was deleted and
has to go, or deleted resources come back at the next boot. Treat the keys as opaque, since a
release can change them. How safe a save interrupted partway is depends on the store. To keep
a second region out, reject in `load` while the store is held and release it in `close`; a store
without `close` isn't locked.

```js
let saved = new Map();
const store = {
  load: async () => new Map(saved),
  replace: async (files) => { saved = new Map(files); },
};
```
