# boto3 with every request handed to a transport instead of a socket. Prepended to the snippet
# runner and the Lambda Python runtime by scripts/embed.mjs
import os
from io import BytesIO

import botocore.session
import js
from botocore.awsrequest import AWSResponse

# botocore would ask the instance metadata service for a region otherwise, and there is no socket
os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")

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


# transport(method, url, headers, body) answers (status, headers, body). Hooks every session,
# including the default one boto3.client() builds
def bridge_boto3(transport, config=None):
    def send(request, **kwargs):
        headers = {key: value.decode() if isinstance(value, bytes) else value for key, value in request.headers.items()}
        status, response_headers, body = transport(request.method, request.url, headers, _bytes_of(request.body))
        return AWSResponse(request.url, status, response_headers, _Body(body))

    session_init = botocore.session.Session.__init__

    def hooked(self, *args, **kwargs):
        session_init(self, *args, **kwargs)
        self.register("before-send.*", send)
        if config is not None:
            self.set_default_client_config(config)

    botocore.session.Session.__init__ = hooked
