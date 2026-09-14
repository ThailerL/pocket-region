---
title: createRegion
description: The options a region boots with, and the port, dispatch, reset, save, and stop of the region it returns.
---

`createRegion` boots the emulator and resolves once it can answer requests. There are two
entries with the same name: one for Node and one for a page.

```ts
import { createRegion } from 'pocket-region/node';     // Node
createRegion(options?: NodeRegionOptions): Promise<Region>

import { createRegion } from 'pocket-region/browser';  // a page
createRegion(options: BrowserRegionOptions): Promise<PageRegion>
```

In Node, a region boots in about 500 ms, and later ones in the same process in about 350 ms.
Browser boot time hasn't been measured.

## Options

| Option | Type | Entry | Default | |
| --- | --- | --- | --- | --- |
| `port` | `number` | both | `4566` | The port the region writes into the URLs it hands out, such as SQS queue URLs. `serve` listens here by default. In Node, the region also serves itself on `127.0.0.1` at this port once a function's code is first deployed, so handlers in child processes can reach it. If the port is taken by your own `serve`, that server is used instead. |
| `stateDir` | `string` | Node | none | A directory to restore state from at boot, and to write to on `save` and `stop`. Without it, state lives in memory only. |
| `onOutput` | `(line: string, stream: 'stdout' \| 'stderr') => void` | both | none | Every line the emulator prints while loading and running, and every line a Lambda handler writes, as `stdout`. |
| `lambda` | `LambdaObserver` | both | none | Hooks for watching functions run. See [Lambda](/docs/lambda/#watching-functions-run). |
| `assetsBaseUrl` | `string` | browser | required | The URL `vendor/` is served from: `meta.json`, the wheels, and the Python standard library. A relative URL resolves against the page. |
| `indexURL` | `string` | both | see text | Where Pyodide's own runtime loads from. A page defaults to jsDelivr, at the Pyodide version the package was built with. In Node, set it only where Pyodide can't find itself from `import.meta.url`. |
| `packageCacheDir` | `string` | Node | the package's `vendor/` | The directory holding the wheels and `meta.json`. |

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

type PageRegion = Omit<Region, 'save'>;
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
An invocation still running fails with `Runtime.ExitError`. Asynchronous invocations, whether
running or waiting to retry, are dropped without reaching a dead-letter queue or failure
destination.

With a `stateDir`, a reset doesn't touch the disk. The files stay until the next `save` or
`stop`, which overwrites them with the empty state.

To start every test empty, boot one region per test file and reset it before each test:

```js
let region;
beforeAll(async () => { region = await createRegion(); });
beforeEach(() => region.reset());
afterAll(() => region.stop());
```

### `save()`

Writes every service's state, then mirrors it into `stateDir`, deleting files for state that no
longer exists. It does nothing without a `stateDir`, and nothing saves on its own. A page has no
`save`, since there is nowhere for it to write.

```js
const region = await createRegion({ stateDir: './.region' });
// ... requests ...
await region.save();   // writes the state to ./.region
await region.stop();   // saves too, then shuts down
```

The next region created with the same `stateDir` starts from that state. The files are MiniStack's
own per-service format. If a service can't read its file at boot, the file is renamed
`<service>.json.refused` and the service starts empty, rather than being saved over. A Pocket
Region release that updates MiniStack can also start a service empty, because MiniStack stamps a
format version on each file.

### `stop()`

Stops the once-a-second timer that runs [scheduled work](/docs/services/#scheduled-work) and
waits for a pass already running. Then it shuts the emulator down, mirrors state into `stateDir`
if there is one, and stops every Lambda environment. Asynchronous invocations waiting to retry
are dropped. Once it resolves, nothing the region started keeps Node running.
