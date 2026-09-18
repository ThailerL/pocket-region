# What a Python function's environment runs under: Lambda's handler contract over Pyodide, with
# boto3 reaching the region through fetch, which each host points at the region
import decimal
import importlib
import json
import os
import sys
import time
import traceback
from io import BytesIO

import botocore.session
import js
from botocore.awsrequest import AWSResponse
from botocore.config import Config
from pyodide.ffi import run_sync, to_js

# botocore would ask the instance metadata service for a region otherwise, and there is no socket
os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
# The task root is the host's directory or a copy of the package; bytecode beside it would be too
sys.dont_write_bytecode = True
sys.path.insert(0, os.environ["LAMBDA_TASK_ROOT"])

_FROM_ENTRIES = js.Object.fromEntries


class _Body(BytesIO):
    def stream(self, **kwargs):
        yield self.getvalue()


def _bytes_of(body):
    if body is None:
        return b""
    if isinstance(body, bytes):
        return body
    if isinstance(body, str):
        return body.encode()
    return body.read()


# Every request goes out through fetch, as a Node handler's would. fetch cannot wait for a 100
# Continue, and Node's refuses the header botocore puts on uploads to ask for one
def _send(request, **kwargs):
    headers = {key: value.decode() if isinstance(value, bytes) else value for key, value in request.headers.items()}
    headers.pop("Expect", None)
    body = _bytes_of(request.body)
    init = {"method": request.method, "headers": headers, "body": to_js(body) if body else None}
    response = run_sync(js.fetch(request.url, to_js(init, dict_converter=_FROM_ENTRIES)))
    raw = run_sync(response.arrayBuffer()).to_bytes()
    return AWSResponse(request.url, response.status, dict(response.headers.entries()), _Body(raw))


# Every session, including the default one boto3.client() builds. The region's S3 answers on one
# host, so buckets go in the path, as the JavaScript runtime's clients put them
_session_init = botocore.session.Session.__init__
_PATH_STYLE = Config(s3={"addressing_style": "path"})


def _hooked(self, *args, **kwargs):
    _session_init(self, *args, **kwargs)
    self.register("before-send.*", _send)
    self.set_default_client_config(_PATH_STYLE)


botocore.session.Session.__init__ = _hooked


# The handler's own frames: the first is this runtime's
def _user_frames(error):
    return error.__traceback__.tb_next


# Logged as Lambda's Python runtime logs it, and the error payload, for JS
def _report(error_type, message, frames=None):
    trace = traceback.format_tb(frames)
    print(f"[ERROR] {error_type}: {message}", file=sys.stderr)
    if trace:
        print("Traceback (most recent call last):\n" + "".join(trace), end="", file=sys.stderr)
    return {"errorType": error_type, "errorMessage": message, "stackTrace": trace}


def _outcome(**fields):
    return to_js(fields, dict_converter=_FROM_ENTRIES)


_handler = None


def _import_handler(setting):
    global _handler
    module_name, dot, function_name = setting.rpartition(".")
    if not dot:
        return _report("Runtime.MalformedHandlerName", f"Bad handler '{setting}': not enough values to unpack")
    try:
        module = importlib.import_module(module_name.replace("/", "."))
    except SyntaxError as error:
        return _report("Runtime.UserCodeSyntaxError", f"Syntax error in module '{module_name}': {error}", _user_frames(error))
    except Exception as error:
        return _report("Runtime.ImportModuleError", f"Unable to import module '{module_name}': {error}", _user_frames(error))
    _handler = getattr(module, function_name, None)
    if _handler is None:
        return _report("Runtime.HandlerNotFound", f"Handler '{function_name}' missing on module '{module_name}'")
    return None


# Lambda's handler setting: a module path, slashes as dots, then a dot and a function name.
# Async so that code run at import may suspend. The init error, or None
async def load(setting):
    failure = _import_handler(setting)
    return None if failure is None else _outcome(**failure)


class LambdaContext:
    def __init__(self, request_id, deadline_ms, arn):
        self.aws_request_id = request_id
        self.invoked_function_arn = arn
        self.function_name = os.environ.get("AWS_LAMBDA_FUNCTION_NAME")
        self.function_version = os.environ.get("AWS_LAMBDA_FUNCTION_VERSION")
        self.memory_limit_in_mb = os.environ.get("AWS_LAMBDA_FUNCTION_MEMORY_SIZE")
        self.log_group_name = os.environ.get("AWS_LAMBDA_LOG_GROUP_NAME")
        self.log_stream_name = os.environ.get("AWS_LAMBDA_LOG_STREAM_NAME")
        self.client_context = None
        self.identity = None
        self._deadline_ms = deadline_ms

    def get_remaining_time_in_millis(self):
        return max(0, int(self._deadline_ms - time.time() * 1000))


# As Lambda's runtime encodes a result: a Decimal is a number
def _default(value):
    if isinstance(value, decimal.Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


# An Outcome, as pool.ts types it
async def invoke(event, request_id, deadline_ms, arn):
    try:
        try:
            result = _handler(json.loads(event), LambdaContext(request_id, deadline_ms, arn))
        except Exception as error:
            return _outcome(error=_report(type(error).__name__, str(error), _user_frames(error)))
        try:
            return _outcome(result=json.dumps(result, default=_default))
        except Exception as error:
            return _outcome(error=_report("Runtime.MarshalError", f"Unable to marshal response: {error}"))
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
