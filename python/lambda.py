# LAMBDA_EXECUTOR is set by bootRegion, and None where functions cannot run
import asyncio
import importlib.abc
import importlib.util
import io
import json
import sys
import time
import uuid
import zipfile

from js import Object
from pyodide.ffi import can_run_sync, to_js

_LAMBDA_MODULE = "ministack.services.lambda_svc"


def _code_entries(code_zip):
    entries = []
    with zipfile.ZipFile(io.BytesIO(code_zip)) as archive:
        for info in archive.infolist():
            if not info.is_dir():
                entries.append([info.filename, archive.read(info), (info.external_attr >> 16) & 0o777])
    return entries


# ministack stores it as an int or a dict, depending on the call that set it
def _reserved_concurrency(func):
    reserved = func.get("concurrency")
    if isinstance(reserved, dict):
        reserved = reserved.get("ReservedConcurrentExecutions")
    return reserved


def _invocation(func, config, event, request_id):
    invocation = {
        "requestId": request_id,
        "config": config,
        "reservedConcurrency": _reserved_concurrency(func),
        "event": json.dumps(event),
    }
    # The zip crosses to JS once per code hash
    if func.get("code_zip") and LAMBDA_EXECUTOR.needsCode(config.get("CodeSha256", "")):
        invocation["code"] = _code_entries(func["code_zip"])
    return to_js(invocation, dict_converter=Object.fromEntries)


# Returns the result dict ministack's _execute_function would have
async def _execute(lambda_svc, func, event):
    config = func.get("config") or func
    request_id = str(uuid.uuid4())
    started = time.time()
    outcome = (await LAMBDA_EXECUTOR.execute(_invocation(func, config, event, request_id))).to_py()
    duration_ms = int((time.time() - started) * 1000)
    log = outcome.get("log") or ""
    if outcome["status"] == "throttled":
        return lambda_svc._throttle_response(
            "ReservedFunctionConcurrentInvocationLimitExceeded",
            f"Rate Exceeded: function {config.get('FunctionName', 'unknown')} at ReservedConcurrentExecutions",
        )
    failed = outcome["status"] == "error"
    lambda_svc._emit_lambda_logs(func, request_id, log, failed, duration_ms)
    payload = None if outcome["payload"] is None else json.loads(outcome["payload"])
    result = {"body": payload, "log": log}
    if failed:
        result.update(error=True, function_error="Unhandled")
    return result


# Reaches into ministack's private names and record shape: re-run the Lambda tests on a bump
def _patch_lambda(lambda_svc):
    original_run_reentrant = lambda_svc.run_reentrant

    # Awaited rather than threaded, so a running handler can still call the region
    async def run_reentrant(fn, *args, thread_name="ministack-reentrant"):
        if fn is lambda_svc._execute_function_with_config_scope:
            return await _execute(lambda_svc, *args)
        return await original_run_reentrant(fn, *args, thread_name=thread_name)

    # One attempt: no retries or dead-lettering yet. ministack's own loop cannot serve, since
    # the thread shim defers its backoff sleeps
    def invoke_async_with_retry(func, event):
        async def attempt():
            try:
                await _execute(lambda_svc, func, event)
            except Exception as error:
                print(f"An asynchronous invocation failed: {error!r}", file=sys.stderr)

        asyncio.ensure_future(attempt())

    original_execute_function = lambda_svc._execute_function

    # Synchronous callers, the event source mapping poller among them, can wait on JS only under JSPI
    def execute_function(func, event):
        if not can_run_sync():
            return original_execute_function(func, event)
        return run_sync_suspended(_execute(lambda_svc, func, event))

    lambda_svc.run_reentrant = run_reentrant
    lambda_svc.invoke_async_with_retry = invoke_async_with_retry
    lambda_svc._execute_function = execute_function
    # Accepted, a mapping would never run: the poller is ticked only under JSPI
    if not JSPI:
        lambda_svc._create_esm = lambda data: lambda_svc.error_response_json(
            "InvalidParameterValueException",
            "Event source mappings need WebAssembly JSPI: use Node 24.20 or later, an earlier Node 24 "
            "started with --experimental-wasm-jspi, or a browser that has it",
            400,
        )


# Patches on ministack's own lazy import; importing lambda_svc at boot costs 91 ms
class _PatchOnImport(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name != _LAMBDA_MODULE:
            return None
        sys.meta_path.remove(self)
        spec = importlib.util.find_spec(name)
        exec_module = spec.loader.exec_module

        def exec_and_patch(module):
            exec_module(module)
            _patch_lambda(module)

        spec.loader.exec_module = exec_and_patch
        return spec


if LAMBDA_EXECUTOR is not None:
    # Its passes block on handlers, which only JSPI lets a synchronous caller do
    if JSPI:
        _TICKED.add("ministack.services.lambda_svc._poll_loop")
    if _LAMBDA_MODULE in sys.modules:
        _patch_lambda(sys.modules[_LAMBDA_MODULE])
    else:
        sys.meta_path.insert(0, _PatchOnImport())
