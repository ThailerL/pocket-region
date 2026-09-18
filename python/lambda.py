# LAMBDA_EXECUTOR is set by bootRegion, and None where functions cannot run
import importlib.abc
import importlib.util
import io
import json
import sys
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


# Reaches into ministack's private names and record shape: re-run the Lambda tests on a bump
def _patch_lambda(lambda_svc):
    # ministack's executor for python and nodejs, so its slot, request id, and log framing stay its own
    def execute_function_warm(func, event):
        outcome = suspend(LAMBDA_EXECUTOR.execute(_invocation(func, event))).to_py()
        if outcome["status"] != "error":
            payload = None if outcome["payload"] is None else json.loads(outcome["payload"])
            return {"body": payload, "log": outcome["log"]}
        # The runtime's own payload, as Lambda answers it: this executor replaces MiniStack's, so nothing upstream shapes it
        return {"body": outcome["error"], "error": True, "log": outcome["log"]}

    lambda_runtime = sys.modules["ministack.core.lambda_runtime"]
    original_reset = lambda_runtime.reset

    # ministack's reset kills its warm workers here, and the pool's environments are those workers
    def reset():
        LAMBDA_EXECUTOR.reset()
        original_reset()

    lambda_svc._execute_function_warm = execute_function_warm
    # Its bootstrap server blocks without suspending and freezes the host, so the executor refuses it instead
    lambda_svc._execute_function_provided = execute_function_warm
    lambda_svc._execute_function_provided_warm = lambda func, event, request_id: execute_function_warm(func, event)
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
