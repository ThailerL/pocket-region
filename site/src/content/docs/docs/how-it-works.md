---
title: How it works
description: MiniStack under Pyodide, dispatch in place of a socket, and Lambda crossing back out to JavaScript.
---

[MiniStack](https://ministack.org/) is a Python AWS emulator. Pocket Region runs it under
[Pyodide](https://github.com/pyodide/pyodide), CPython compiled to WebAssembly, in the same
JavaScript process as your code: Node's main thread, or a page's.

## No socket

Python can't open a socket under Pyodide. Instead of listening, the emulator's ASGI app is called
directly: `dispatch` turns a request into an ASGI call and resolves with the response. That is
why a page needs no server. `requestHandler`, `serve`, and `awsCli` are all built on `dispatch`.

The one exception is Lambda in Node. A handler runs in a child process, which can't make a
function call into its parent, so once a function's code is first deployed the region serves
itself over HTTP on its own port.

## No threads

Pyodide has no threads either, and MiniStack starts background threads for several jobs.
Pocket Region replaces thread start-up with an inline call:

- **Work that finishes straight away**, such as S3 notification fan-out or SNS delivery, completes
  inside the request that started it.
- **Loops that sleep between passes**, such as EventBridge's scheduler and DynamoDB's TTL reaper,
  are run one pass at a time by a timer once a second. See
  [scheduled work](/docs/services/#scheduled-work).
- **Work that sleeps before acting once** is dropped. That is why Step Functions executions stay
  `RUNNING`.

## Lambda

Lambda crosses the boundary the other way. MiniStack keeps the functions and answers the Lambda
API. When something invokes a function, the invocation comes back out to JavaScript, which runs
the handler in a child process or a Web Worker, enforces its timeout and concurrency, and hands
the result back to MiniStack. The handler's own SDK calls go through `dispatch` like any other
request, so a handler can call the region while its own invocation is still waiting.
