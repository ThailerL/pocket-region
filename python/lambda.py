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
# ministack's account cap is bypassed, so this is the only bound on a function's environments
_DEFAULT_CONCURRENCY = 10


def _code_entries(code_zip):
    entries = []
    with zipfile.ZipFile(io.BytesIO(code_zip)) as archive:
        for info in archive.infolist():
            if not info.is_dir():
                entries.append([info.filename, archive.read(info), (info.external_attr >> 16) & 0o777])
    return entries


# ministack stores the reservation as an int or a dict, depending on the call that set it
def _concurrency(func):
    reserved = func.get("concurrency")
    if isinstance(reserved, dict):
        reserved = reserved.get("ReservedConcurrentExecutions")
    return _DEFAULT_CONCURRENCY if reserved is None else reserved


def _invocation(func, config, event, request_id):
    invocation = {
        "requestId": request_id,
        "config": config,
        "concurrency": _concurrency(func),
        "event": json.dumps(event),
    }
    # The zip crosses to JS once per code hash
    if func.get("code_zip") and LAMBDA_EXECUTOR.needsCode(config.get("CodeSha256", "")):
        invocation["code"] = _code_entries(func["code_zip"])
    return to_js(invocation, dict_converter=Object.fromEntries)


# (account, region, function name) -> invocations started and not yet answered
_in_flight = {}


# Counted before anything awaits, so a pass that starts several batches sees each one
def _hold(lambda_svc, func):
    config = func.get("config") or func
    key = (lambda_svc.get_account_id(), lambda_svc.get_region(), config.get("FunctionName"))
    _in_flight[key] = _in_flight.get(key, 0) + 1
    return key


async def _execute(lambda_svc, func, event):
    key = _hold(lambda_svc, func)
    try:
        return await _invoke(lambda_svc, func, event)
    finally:
        _in_flight[key] -= 1


# Returns the result dict ministack's _execute_function would have
async def _invoke(lambda_svc, func, event):
    config = func.get("config") or func
    request_id = str(uuid.uuid4())
    started = time.time()
    outcome = (await LAMBDA_EXECUTOR.execute(_invocation(func, config, event, request_id))).to_py()
    duration_ms = int((time.time() - started) * 1000)
    if outcome["status"] == "throttled":
        return lambda_svc._throttle_response(
            "ReservedFunctionConcurrentInvocationLimitExceeded",
            f"Rate Exceeded: function {config.get('FunctionName', 'unknown')} at ReservedConcurrentExecutions",
        )
    failed = outcome["status"] == "error"
    # It frames the output as the host framed the log
    lambda_svc._emit_lambda_logs(func, request_id, outcome["output"], failed, duration_ms)
    payload = None if outcome["payload"] is None else json.loads(outcome["payload"])
    result = {"body": payload, "log": outcome["log"]}
    if failed:
        result.update(error=True, function_error="Unhandled")
    return result


# As ministack's _poll_sqs builds it
def _sqs_record(lambda_svc, msg, source_arn, now):
    attributes = {
        "ApproximateReceiveCount": str(msg.get("receive_count", 1)),
        "SentTimestamp": str(int(msg["sent_at"] * 1000)),
        "SenderId": lambda_svc.get_account_id(),
        "ApproximateFirstReceiveTimestamp": str(int((msg.get("first_receive_at") or now) * 1000)),
    }
    trace_header = (msg.get("sys") or {}).get("AWSTraceHeader")
    if trace_header:
        attributes["AWSTraceHeader"] = trace_header
    if msg.get("group_id"):
        attributes["MessageGroupId"] = msg["group_id"]
    if msg.get("dedup_id"):
        attributes["MessageDeduplicationId"] = msg["dedup_id"]
    if msg.get("seq") is not None:
        attributes["SequenceNumber"] = str(msg["seq"])
    return {
        "messageId": msg["id"],
        "receiptHandle": msg["receipt_handle"],
        "body": msg["body"],
        "attributes": attributes,
        "messageAttributes": lambda_svc._sqs_message_attributes_to_camel_case(msg.get("message_attributes", {})),
        "md5OfBody": msg.get("md5_body") or msg.get("md5") or "",
        "eventSource": "aws:sqs",
        "eventSourceARN": source_arn,
        "awsRegion": lambda_svc.get_region(),
    }


def _batch_item_failures(esm, body):
    if "ReportBatchItemFailures" not in esm.get("FunctionResponseTypes", []):
        return set()
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except json.JSONDecodeError:
            return set()
    if not isinstance(body, dict):
        return set()
    return {
        failure["itemIdentifier"]
        for failure in body.get("batchItemFailures", [])
        if isinstance(failure, dict) and failure.get("itemIdentifier")
    }


def _settle(lambda_svc, sqs, esm, queue_url, batch, result):
    # A throttled batch stays invisible until its visibility timeout, as a failed one does
    if result.get("throttle"):
        return
    if result.get("error"):
        esm["LastProcessingResult"] = "FAILED"
        lambda_svc._esm_backoff_until[esm["UUID"]] = time.time() + lambda_svc._ESM_BACKOFF_SECONDS
        return
    lambda_svc._esm_backoff_until.pop(esm["UUID"], None)
    failed_ids = _batch_item_failures(esm, result.get("body"))
    succeeded = [msg for msg in batch if msg["id"] not in failed_ids]
    sqs._delete_messages_for_esm(queue_url, {msg["receipt_handle"] for msg in succeeded if msg.get("receipt_handle")})
    failed = len(batch) - len(succeeded)
    esm["LastProcessingResult"] = (
        f"OK - {len(succeeded)} records, {failed} partial failures" if failed else f"OK - {len(batch)} records"
    )


async def _deliver(lambda_svc, sqs, esm, func, queue_url, batch, records, key):
    try:
        _settle(lambda_svc, sqs, esm, queue_url, batch, await _invoke(lambda_svc, func, {"Records": records}))
    except Exception as error:
        print(f"An event source mapping batch failed: {error!r}", file=sys.stderr)
    finally:
        _in_flight[key] -= 1
        await poll_mappings()


def _start_batches(lambda_svc, sqs, esm):
    if not esm.get("Enabled", True):
        return
    source_arn = esm.get("EventSourceArn", "")
    try:
        spec = lambda_svc.parse_arn(source_arn)
    except lambda_svc.ArnParseError:
        return
    if spec.service != "sqs" or spec.account_id != lambda_svc.get_account_id() or spec.region != lambda_svc.get_region():
        return
    queue_name = lambda_svc._sqs_queue_name_from_arn_spec(spec)
    func, _ = lambda_svc._get_func_record_for_qualifier(esm["FunctionName"], esm.get("Qualifier"))
    if not queue_name or func is None:
        return
    queue_url = sqs._queue_url(queue_name)
    queue = sqs._queues.get(queue_url)
    if not queue or queue.get("attributes", {}).get("QueueArn") != source_arn:
        return

    config = func.get("config") or func
    key = (lambda_svc.get_account_id(), lambda_svc.get_region(), config.get("FunctionName"))
    while _in_flight.get(key, 0) < _concurrency(func) and lambda_svc._esm_backoff_until.get(esm["UUID"], 0) <= time.time():
        batch = sqs._receive_messages_for_esm(queue_url, esm.get("BatchSize", 10))
        if not batch:
            return
        now = time.time()
        records = lambda_svc._apply_filter_criteria([_sqs_record(lambda_svc, msg, source_arn, now) for msg in batch], esm)
        # Lambda drops what the filter rejects before the handler runs
        if not records:
            sqs._delete_messages_for_esm(queue_url, {msg["receipt_handle"] for msg in batch})
            continue
        asyncio.ensure_future(_deliver(lambda_svc, sqs, esm, func, queue_url, batch, records, _hold(lambda_svc, func)))


# Awaits nothing, so no other pass runs between counting a function's invocations and starting one.
# Run by every tick and whenever a batch finishes
async def poll_mappings():
    lambda_svc = sys.modules.get(_LAMBDA_MODULE)
    if lambda_svc is None:
        return
    from ministack.services import sqs

    for account, region, esm in lambda_svc._iter_all_esms():
        account_token = lambda_svc._request_account_id.set(account)
        region_token = lambda_svc._request_region.set(region)
        try:
            _start_batches(lambda_svc, sqs, esm)
        except Exception as error:
            print(f"An event source mapping pass failed: {error!r}", file=sys.stderr)
        finally:
            lambda_svc._request_account_id.reset(account_token)
            lambda_svc._request_region.reset(region_token)


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

    # Synchronous callers, a Lambda failure destination and the Kinesis and DynamoDB stream mappings,
    # can wait on JS only under JSPI
    def execute_function(func, event):
        if not can_run_sync():
            return original_execute_function(func, event)
        return run_sync_suspended(_execute(lambda_svc, func, event))

    lambda_svc.run_reentrant = run_reentrant
    lambda_svc.invoke_async_with_retry = invoke_async_with_retry
    lambda_svc._execute_function = execute_function
    # Its one pass at CreateEventSourceMapping would take a batch serially; poll_mappings owns SQS
    lambda_svc._poll_sqs = lambda: False


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
    TICK_HOOKS.append(poll_mappings)
    if _LAMBDA_MODULE in sys.modules:
        _patch_lambda(sys.modules[_LAMBDA_MODULE])
    else:
        sys.meta_path.insert(0, _PatchOnImport())
