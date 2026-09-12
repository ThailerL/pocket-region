from js import Object
from pyodide.ffi import to_js

# One data-plane request, forwarded verbatim. headers and body arrive as a JS object and
# Uint8Array; the answer goes back as a plain JS object
async def region_dispatch(method, target, headers, body):
    response = await asgi_request(method, target, headers.to_py(), body.to_bytes())
    kept = {k.decode(): v.decode() for k, v in response.headers if k.lower() != b"content-length"}
    return to_js(
        {"status": response.status, "headers": kept, "body": response.body},
        dict_converter=Object.fromEntries,
    )
