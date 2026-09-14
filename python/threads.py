# Pyodide has no pthreads, so ministack's background workers cannot start. Run each one
# inline instead: fire-and-forget workers (S3 event fanout, SNS delivery) complete during
# the request that triggered them, and loop-forever workers hit the first sleep and are
# deferred. Must run before ministack is imported.
import asyncio
import functools
import sys
import threading
import time

from pyodide.ffi import run_sync


class _Deferred(BaseException):
    """Not an Exception: workers wrap their bodies in `except Exception`."""


# Each loops forever carrying nothing between passes and sleeping at least once per idle pass,
# so one allowed sleep bounds a tick. Re-read the loops at every ministack bump before adding
_TICKED = {
    "ministack.services.eventbridge._scheduler_loop",
    "ministack.services.scheduler._ticker_loop",
    "ministack.services.dynamodb._ttl_reaper",
}
_ticked = []
# Run after the ticked workers, by sources that follow this one
TICK_HOOKS = []

_real_sleep = time.sleep


# Returns whether the worker stopped at a sleep beyond its budget
def _run(name, target, sleeps):
    def budgeted_sleep(seconds):
        nonlocal sleeps
        if sleeps == 0:
            raise _Deferred(f"would sleep {seconds}s")
        sleeps -= 1

    outer_sleep = time.sleep
    time.sleep = budgeted_sleep
    try:
        target()
    except _Deferred:
        return True
    except Exception as error:
        print(f"Background worker {name} failed: {error!r}", file=sys.stderr)
    finally:
        time.sleep = outer_sleep
    return False


# What runs while this stack is suspended must not spend its sleep budget
def run_sync_suspended(awaitable):
    own_sleep = time.sleep
    time.sleep = _real_sleep
    try:
        return run_sync(awaitable)
    finally:
        time.sleep = own_sleep


def _qualified_name(target):
    return f"{getattr(target, '__module__', '')}.{getattr(target, '__qualname__', '')}"


def _inline_start(self):
    # Thread.run drops its target once it returns, so a second pass needs its own copy
    target = functools.partial(self._target, *self._args, **self._kwargs)
    ticked = _qualified_name(self._target) in _TICKED
    if _run(self.name, self.run, 0) and ticked:
        _ticked.append((self.name, target))


# (due time, coroutine function)
_later = []


# Started by the tick rather than a timer: a cancelled Pyodide timer holds Node for its full delay
def call_later(seconds, start):
    _later.append((time.time() + seconds, start))


# Called by the region on an interval. Async so a pass can wait on JS through run_sync
async def region_tick():
    for name, target in _ticked:
        _run(name, target, 1)
    now = time.time()
    due = [start for when, start in _later if when <= now]
    _later[:] = [entry for entry in _later if entry[0] > now]
    for start in due:
        asyncio.ensure_future(start())
    for hook in TICK_HOOKS:
        await hook()


# The worker already ran inside start(), but the stdlib refuses to join a thread it never
# saw start, and lifespan startup joins the container reaper
threading.Thread.start = _inline_start
threading.Thread.join = lambda self, timeout=None: None
threading.Thread.is_alive = lambda self: False
