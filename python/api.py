# The function surface the JS bridge calls. Runs last: everything defined by the other
# python files is already in this namespace.
import glob
import time

from pyodide.ffi import to_js

# One data-plane request: the caller's method/path/headers/body, forwarded verbatim. body
# arrives as a JS Uint8Array; the return converts to a JS array of
# [status, headers JSON, body Uint8Array] via to_js
async def gg_dispatch(method, target, headers_json, body):
    data = body.to_bytes() if body is not None else b""
    headers = list(json.loads(headers_json).items())
    response = await asgi_request(method, target, headers, data)

    def text(value):
        return value.decode() if isinstance(value, bytes) else value

    kept = [
        [text(k), text(v)] for k, v in response.headers if text(k).lower() != "content-length"
    ]
    return to_js([response.status, json.dumps(kept), response.body])


# stateFiles is what was on disk to load, not proof each one loaded: the emulator refuses a
# file whose format version it does not recognise and starts that service empty, saying so
async def gg_start():
    await lifespan("startup")
    state_files = sorted(
        os.path.basename(path)[: -len(".json")] for path in glob.glob(f"{STATE_DIR}/*.json")
    )
    return json.dumps({"stateFiles": state_files, "deferred": DEFERRED, "failed": FAILED})


# What each resource is holding, for the metrics its node shows, as [value, unit] pairs. Read
# off the backends rather than through the data plane, so sampling never counts as traffic
# the user caused. The
# module-level stores are private to ministack, like the persistence call above: a release
# could move them
async def gg_stats():
    from ministack.services.s3 import _buckets
    from ministack.services.sqs import _queues
    from ministack.services.dynamodb import _tables

    buckets = {}
    for name, bucket in _buckets.items():
        objects = bucket.get("objects") or {}
        total = sum(entry.get("size", 0) for entry in objects.values())
        buckets[name] = {"objects": [len(objects), "Count"], "size": [total / 1e6, "Megabytes"]}

    # A message is in flight once it has been received and its visibility timeout has not
    # yet lapsed; until then it is waiting to be picked up
    now = time.time()
    queues = {}
    for queue in _queues.values():
        messages = queue.get("messages") or []
        in_flight = sum(
            1 for m in messages if m.get("receipt_handle") and m.get("visible_at", 0) > now
        )
        queues[queue["name"]] = {
            "messages": [len(messages) - in_flight, "Count"],
            "in flight": [in_flight, "Count"],
        }

    # items is keyed by partition value, then by sort value, so the item count is the sum of
    # the inner maps rather than the size of the outer one
    tables = {}
    for name, table in _tables.items():
        items = table.get("items") or {}
        tables[name] = {"items": [sum(len(rows) for rows in items.values()), "Count"]}

    return json.dumps({"s3": buckets, "sqs": queues, "dynamodb": tables})


# Lifespan shutdown persists on its way out; the bridge copies the files afterwards
async def gg_stop():
    await lifespan("shutdown")
