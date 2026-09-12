# Runs last: names from threads.py and helpers.py are already in this namespace
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


# Lifespan shutdown saves state on its way out
async def region_stop():
    await lifespan("shutdown")
