# Runs last: names from threads.py and helpers.py are already in this namespace
import time

from js import Object
from pyodide.ffi import to_js

# One data-plane request, forwarded verbatim. headers and body arrive as a JS object and
# Uint8Array; the answer goes back as a plain JS object
async def region_dispatch(method, target, headers, body):
    response = await asgi_request(method, target, list(headers.to_py().items()), body.to_bytes())

    def text(value):
        return value.decode() if isinstance(value, bytes) else value

    kept = {text(k): text(v) for k, v in response.headers if text(k).lower() != "content-length"}
    return to_js(
        {"status": response.status, "headers": kept, "body": response.body},
        dict_converter=Object.fromEntries,
    )


async def region_start():
    await lifespan("startup")


# Read off ministack's private module-level stores, which a release could move
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


# Lifespan shutdown saves state on its way out
async def region_stop():
    await lifespan("shutdown")
