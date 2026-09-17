# What a Python snippet runs under: boto3 reaching the runner's region, and a session's echo
import ast
import os
import sys
import traceback
from io import BytesIO
from urllib.parse import urlsplit

import botocore.session
import js
from botocore.awsrequest import AWSResponse
from pyodide.code import CodeRunner
from pyodide.ffi import run_sync, to_js

import _pocket_region

# What code written for AWS gets from its environment, as the runner's JavaScript clients get it
os.environ.update(_pocket_region.environment.to_py(), AWS_EC2_METADATA_DISABLED="true")

FILENAME = "<snippet>"
_FROM_ENTRIES = js.Object.fromEntries


def _snippet_line():
    frame = sys._getframe(2)
    while frame is not None and frame.f_code.co_filename != FILENAME:
        frame = frame.f_back
    return None if frame is None else frame.f_lineno


# Output goes to the page a line at a time, with the snippet line whose call wrote it
class _Stream:
    def __init__(self, name):
        self.name = name
        self.pending = ""

    def write(self, text):
        self.pending += text
        *lines, self.pending = self.pending.split("\n")
        if lines:
            line = _snippet_line()
            for complete in lines:
                _pocket_region.output(self.name, complete, line)
        return len(text)

    def flush(self):
        if self.pending:
            _pocket_region.output(self.name, self.pending, None)
            self.pending = ""

    def isatty(self):
        return False


sys.stdout = _stdout = _Stream("stdout")
sys.stderr = _stderr = _Stream("stderr")


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


# Every request reaches the region as a call, so no socket and no endpoint is needed
def _send(request, **kwargs):
    url = urlsplit(request.url)
    headers = {key: value.decode() if isinstance(value, bytes) else value for key, value in request.headers.items()}
    headers["host"] = url.netloc
    region_request = {
        "method": request.method,
        "path": url.path + ("?" + url.query if url.query else ""),
        "headers": headers,
        "body": _bytes_of(request.body),
    }
    response = run_sync(_pocket_region.dispatch(to_js(region_request, dict_converter=_FROM_ENTRIES)))
    return AWSResponse(request.url, response.status, response.headers.to_py(), _Body(response.body.to_bytes()))


# Every session, including the default one boto3.client() builds
_init = botocore.session.Session.__init__


def _hooked(self, *args, **kwargs):
    _init(self, *args, **kwargs)
    self.register("before-send.*", _send)


botocore.session.Session.__init__ = _hooked


# As the interpreter's single mode: every expression statement, into compound statements but not into a def or class
class _Echo(ast.NodeTransformer):
    def visit_Expr(self, node):
        call = ast.Call(ast.Name("__echo__", ast.Load()), [node.value], [])
        return ast.copy_location(ast.Expr(ast.copy_location(call, node.value)), node)

    def visit_FunctionDef(self, node):
        return node

    visit_AsyncFunctionDef = visit_ClassDef = visit_FunctionDef


def _snippet_frames(tb):
    while tb is not None and tb.tb_frame.f_code.co_filename != FILENAME:
        tb = tb.tb_next
    return tb


def _failing_line(error, tb):
    if isinstance(error, SyntaxError) and error.filename == FILENAME:
        return error.lineno
    return None if tb is None else tb.tb_lineno


# The names a run leaves behind, kept for the next while the region keeps its state
_namespace = None


# What the code raises comes back as the error, with the traceback as its stack, as a JavaScript throw does
async def run(source, echo, fresh):
    global _namespace
    if fresh or _namespace is None:
        _namespace = {"__name__": "__main__", "__echo__": sys.displayhook}
    try:
        runner = CodeRunner(source, return_mode="none", quiet_trailing_semicolon=False, filename=FILENAME, flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
        if echo:
            ast.fix_missing_locations(_Echo().visit(runner.ast))
        runner.compile()
        await runner.run_async(_namespace)
    except Exception as error:
        frames = _snippet_frames(error.__traceback__)
        failure = {
            "name": type(error).__name__,
            "message": str(error),
            "stack": "".join(traceback.format_exception(type(error), error, frames)),
            "line": _failing_line(error, frames),
        }
        return to_js(failure, dict_converter=_FROM_ENTRIES)
    finally:
        _stdout.flush()
        _stderr.flush()
    return None
