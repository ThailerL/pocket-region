# The emulator and the plumbing to call it. Python owns no socket under Pyodide, so the
# ASGI app is driven directly: every "request" is an in-process function call.
import asyncio
import glob
import os
import tempfile
from collections import namedtuple

# Temp files stay in MEMFS: under Vivari, writes through a node mount are corrupt
os.makedirs("/tmp", exist_ok=True)
tempfile.tempdir = "/tmp"

# STATE_ROOT is set by createRegion before this file runs. Object bodies persist through
# a switch of their own: with only PERSIST_STATE the buckets come back empty
STATE_DIR = f"{STATE_ROOT}/state"
S3_DATA_DIR = f"{STATE_ROOT}/objects"
os.makedirs(STATE_DIR, exist_ok=True)
os.makedirs(S3_DATA_DIR, exist_ok=True)
os.environ.update(
    PERSIST_STATE="1",
    STATE_DIR=STATE_DIR,
    S3_PERSIST="1",
    S3_DATA_DIR=S3_DATA_DIR,
    GATEWAY_PORT=str(REGION_PORT),
)

from ministack.core.persistence import load_state


def _move_aside(path):
    # Never overwrite an earlier quarantine: that is the loss this exists to prevent
    kept = path + ".refused"
    index = 2
    while os.path.exists(kept):
        kept = f"{path}.refused-{index}"
        index += 1
    os.rename(path, kept)
    print(f"state file {os.path.basename(path)} was not loaded; kept as {os.path.basename(kept)}")


# A file the emulator refuses leaves that service empty, and the next save would write that
# emptiness over it. load_state is asked rather than copied, so its rule stays its own; it
# says why on its own logger, and must run before the import below. Needs PERSIST_STATE
# set above: without it load_state refuses every file
def _quarantine_refused_state():
    for path in sorted(glob.glob(f"{STATE_DIR}/*.json")):
        if load_state(os.path.basename(path)[: -len(".json")]) is None:
            _move_aside(path)


_quarantine_refused_state()

# Each service reads its own state file as it imports, so this line is the restore
from ministack.app import app, _build_persistence_save_dict
from ministack.core.persistence import save_all


# _build_persistence_save_dict is private to ministack, but it is the same call its own
# lifespan shutdown makes; a patch release could move it
def region_save():
    save_all(_build_persistence_save_dict())


# The app expects one long-lived lifespan call, as a real ASGI server gives it: startup is
# delivered once and it then blocks on the queue until shutdown. Answering every receive()
# with startup instead puts it in an infinite loop
_lifespan_queue = asyncio.Queue()
_lifespan_reached = {}
_lifespan_task = None


async def _lifespan_send(message):
    # "lifespan.startup.complete" -> "startup"
    _lifespan_reached.setdefault(message["type"].split(".")[1], asyncio.Event()).set()


async def lifespan(phase):
    global _lifespan_task
    if _lifespan_task is None:
        _lifespan_task = asyncio.ensure_future(
            app({"type": "lifespan", "asgi": {"version": "3.0"}}, _lifespan_queue.get, _lifespan_send)
        )
    reached = _lifespan_reached.setdefault(phase, asyncio.Event())
    await _lifespan_queue.put({"type": f"lifespan.{phase}"})
    # No timeout: under Pyodide a cancelled asyncio timer still holds Node open for its delay
    await reached.wait()


Response = namedtuple("Response", ("status", "headers", "body"))


async def asgi_request(method, target, headers, body):
    path, _, query = target.partition("?")
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "path": path,
        "raw_path": path.encode(),
        "query_string": query.encode(),
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "client": ("127.0.0.1", 1),
        "server": ("127.0.0.1", 443),
        "scheme": "http",
    }
    sent = []

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message):
        sent.append(message)

    await app(scope, receive, send)
    start = next(m for m in sent if m["type"] == "http.response.start")
    payload = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return Response(start["status"], start.get("headers", []), payload)
