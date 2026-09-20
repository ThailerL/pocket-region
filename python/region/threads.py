# Pyodide has no pthreads. A started thread runs as an event-loop callback instead, and under
# JSPI its sleeps and waits suspend it rather than the loop. Must run before ministack is imported.
# REGION_SLEEP is set by bootRegion
import _thread
import asyncio
import contextvars
import gc
import queue
import sys
import threading
import time

from pyodide.ffi import run_sync

# Automatic collection walks a suspended task's frames, which Pyodide has reused
# https://github.com/pyodide/pyodide/issues/6464
gc.disable()


# How many tracked objects a full collection freed, which automatic collection would have
def collect_garbage():
    before = len(gc.get_objects())
    gc.collect()
    return before - len(gc.get_objects())


class _Ended(BaseException):
    """Not an Exception: workers wrap their bodies in `except Exception`."""


# Whether a worker is running. Not a ContextVar: ministack runs thread bodies under contexts of its own
_in_worker = False
_stopping = False


def end_workers():
    global _stopping
    _stopping = True


# A worker the region's stop ended unwinds here. A reset leaves workers running, as ministack's threads do
def suspend(awaitable):
    global _in_worker
    in_worker, _in_worker = _in_worker, False
    try:
        return run_sync(awaitable)
    finally:
        _in_worker = in_worker
        if in_worker and _stopping:
            raise _Ended()


def _sleep(seconds):
    suspend(REGION_SLEEP(max(seconds, 0)))


# Whether done() came true within timeout, checked every 50 ms
def _wait_until(done, timeout):
    deadline = None if timeout is None else time.monotonic() + timeout
    while not done():
        remaining = None if deadline is None else deadline - time.monotonic()
        if remaining is not None and remaining <= 0:
            return False
        _sleep(0.05 if remaining is None else min(0.05, remaining))
    return True


# A Condition's waiter. An untimed acquire of a held lock never returns in Pyodide
class _PollingLock:
    def __init__(self):
        self._lock = _thread.allocate_lock()

    def acquire(self, blocking=True, timeout=-1):
        if not blocking:
            return self._lock.acquire(False)
        return _wait_until(lambda: self._lock.acquire(False), None if timeout < 0 else timeout)

    def release(self):
        self._lock.release()


def _start(self):
    self._region_done = False

    def run():
        global _in_worker
        _in_worker = True
        try:
            self.run()
        except _Ended:
            pass
        except Exception as error:
            print(f"Background worker {self.name} failed: {error!r}", file=sys.stderr)
        finally:
            _in_worker = False
            self._region_done = True

    # A real thread starts with an empty context
    asyncio.get_event_loop().call_soon(run, context=contextvars.Context())


# Outside a worker nothing can suspend, and lifespan startup joins a reaper that never ends
def _join(self, timeout=None):
    if _in_worker:
        _wait_until(lambda: self._region_done, timeout)


time.sleep = _sleep
threading._allocate_lock = _PollingLock
# The C one blocks in C. ThreadPoolExecutor's workers wait on one
queue.SimpleQueue = queue._PySimpleQueue
# A thread never started counts as done, as the stdlib's is_alive has it
threading.Thread._region_done = True
threading.Thread.start = _start
threading.Thread.join = _join
threading.Thread.is_alive = lambda self: not self._region_done
