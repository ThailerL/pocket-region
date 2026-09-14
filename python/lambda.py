# LAMBDA_EXECUTOR is set by bootRegion, and None where functions cannot run
import importlib.abc
import importlib.util
import io
import json
import sys
import time
import uuid
import zipfile

from js import Object
from pyodide.ffi import to_js

_LAMBDA_MODULE = "ministack.services.lambda_svc"


def _code_entries(code_zip):
    entries = []
    with zipfile.ZipFile(io.BytesIO(code_zip)) as archive:
        for info in archive.infolist():
            if not info.is_dir():
                entries.append([info.filename, archive.read(info), (info.external_attr >> 16) & 0o777])
    return entries


def _invocation(func, event):
    config = func.get("config") or func
    invocation = {"requestId": str(uuid.uuid4()), "config": config, "event": json.dumps(event)}
    # The zip crosses to JS once per code hash
    if func.get("code_zip") and LAMBDA_EXECUTOR.needsCode(config.get("CodeSha256", "")):
        invocation["code"] = _code_entries(func["code_zip"])
    return to_js(invocation, dict_converter=Object.fromEntries)


# From here to _poll_sqs, and its assignment in _patch_lambda: ministack's _poll_sqs with each batch on a
# worker holding a concurrency slot, as proposed upstream. Delete at the ministack bump that ships it
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


# A received batch with the slot that holds it, or None when the mapping has no slot or no messages
def _next_sqs_batch(lambda_svc, sqs, esm):
    if not esm.get("Enabled", True) or lambda_svc._esm_backoff_until.get(esm["UUID"], 0) > time.time():
        return None
    source_arn = esm.get("EventSourceArn", "")
    try:
        spec = lambda_svc.parse_arn(source_arn)
    except lambda_svc.ArnParseError:
        return None
    if spec.service != "sqs" or spec.account_id != lambda_svc.get_account_id() or spec.region != lambda_svc.get_region():
        return None
    queue_name = lambda_svc._sqs_queue_name_from_arn_spec(spec)
    func, _ = lambda_svc._get_func_record_for_qualifier(esm["FunctionName"], esm.get("Qualifier"))
    if not queue_name or func is None:
        return None
    queue_url = sqs._queue_url(queue_name)
    queue = sqs._queues.get(queue_url)
    if not queue or queue.get("attributes", {}).get("QueueArn") != source_arn:
        return None
    while True:
        slot, _ = lambda_svc._acquire_execution_slot(func, func.get("config") or func)
        if slot is None:
            return None
        batch = sqs._receive_messages_for_esm(queue_url, esm.get("BatchSize", 10))
        if not batch:
            lambda_svc._release_execution_slot(slot)
            return None
        now = time.time()
        records = lambda_svc._apply_filter_criteria([_sqs_record(lambda_svc, msg, source_arn, now) for msg in batch], esm)
        if records:
            return slot, func, queue_url, batch, records
        # Lambda drops what the filter rejects before the handler runs
        lambda_svc._release_execution_slot(slot)
        sqs._delete_messages_for_esm(queue_url, {msg["receipt_handle"] for msg in batch})


# Takes the mapping's next batch as each finishes, so a freed slot is not left for the poller's idle sleep
def _run_sqs_batches(lambda_svc, sqs, esm, taken):
    while taken is not None:
        slot, func, queue_url, batch, records = taken
        # _execute_function takes it back before anything can suspend, so nothing else runs in between
        lambda_svc._release_execution_slot(slot)
        _settle(lambda_svc, sqs, esm, queue_url, batch, lambda_svc._execute_function(func, {"Records": records}))
        taken = _next_sqs_batch(lambda_svc, sqs, esm)


def _poll_sqs(lambda_svc):
    from ministack.core.concurrency import spawn_background
    from ministack.services import sqs

    started = False
    for account, region, esm in lambda_svc._iter_all_esms():
        account_token = lambda_svc._request_account_id.set(account)
        region_token = lambda_svc._request_region.set(region)
        try:
            while (taken := _next_sqs_batch(lambda_svc, sqs, esm)) is not None:
                spawn_background(_run_sqs_batches, lambda_svc, sqs, esm, taken, thread_name="sqs-batches")
                started = True
        finally:
            lambda_svc._request_account_id.reset(account_token)
            lambda_svc._request_region.reset(region_token)
    return started


# Reaches into ministack's private names and record shape: re-run the Lambda tests on a bump
def _patch_lambda(lambda_svc):
    # ministack's executor for python and nodejs, so its slot, request id, and log framing stay its own
    def execute_function_warm(func, event):
        outcome = suspend(LAMBDA_EXECUTOR.execute(_invocation(func, event))).to_py()
        if outcome["status"] != "error":
            payload = None if outcome["payload"] is None else json.loads(outcome["payload"])
            return {"body": payload, "log": outcome["log"]}
        # As ministack's warm executor shapes a worker's error
        message = outcome["message"]
        error_type = "Runtime.ExitError" if "timed out" in message.lower() else "Runtime.HandlerError"
        return {"body": {"errorMessage": message, "errorType": error_type}, "error": True, "log": outcome["log"]}

    lambda_runtime = sys.modules["ministack.core.lambda_runtime"]
    original_reset = lambda_runtime.reset

    # ministack's reset kills its warm workers here, and the pool's environments are those workers
    def reset():
        LAMBDA_EXECUTOR.reset()
        original_reset()

    lambda_svc._execute_function_warm = execute_function_warm
    # Its bootstrap server blocks without suspending and freezes the host, so the executor refuses it instead
    lambda_svc._execute_function_provided = execute_function_warm
    lambda_svc._poll_sqs = lambda: _poll_sqs(lambda_svc)
    lambda_runtime.reset = reset


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
    if _LAMBDA_MODULE in sys.modules:
        _patch_lambda(sys.modules[_LAMBDA_MODULE])
    else:
        sys.meta_path.insert(0, _PatchOnImport())
