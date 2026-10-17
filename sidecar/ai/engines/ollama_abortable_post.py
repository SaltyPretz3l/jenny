"""Ollama non-streaming POSTs that another thread can sever mid-flight.

``OllamaEngine._post`` (whose signature other callers and tests depend on)
issues its request over an abortable ``http.client`` connection whenever the
calling thread published an :class:`AbortableRequest` in ``post_abort_scope``.
The warmup thread uses that directly; :func:`cancellable_post_scope` binds it
to a cancel handle so a cancelled non-streaming ``generate`` closes its socket
before or after the response headers arrive.
"""

from __future__ import annotations

import http.client
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterator
from contextlib import contextmanager
from http import HTTPStatus
from typing import Any

from sidecar.ai.engines.http_utils import read_json_response, register_cancel_callback
from sidecar.ai.engines.ollama_stream_transport import force_close_socket, raise_if_cancelled

# Thread-local: only the thread that set it sees it.
post_abort_scope = threading.local()


class AbortableRequest:
    """One in-flight POST whose blocked connection another thread can close."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._conn: http.client.HTTPConnection | None = None
        self._aborted = False

    def attach(self, conn: http.client.HTTPConnection) -> None:
        with self._lock:
            self._conn = conn
        self.raise_if_aborted()

    def raise_if_aborted(self) -> None:
        with self._lock:
            if self._aborted:
                raise ConnectionAbortedError("request aborted before it was sent")

    def abort(self) -> None:
        with self._lock:
            self._aborted = True
            conn = self._conn
        if conn is None:
            return
        force_close_socket(getattr(conn, "sock", None))
        conn.close()


def post_abortable(
    abortable: AbortableRequest,
    url: str,
    req: urllib.request.Request,
    timeout: float,
) -> dict[str, Any]:
    """POST ``req`` over a connection ``abortable.abort()`` can close mid-flight."""
    parts = urllib.parse.urlsplit(url)
    conn_class = (
        http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    )
    conn = conn_class(parts.hostname or "", parts.port, timeout=timeout)
    try:
        abortable.attach(conn)
        # An abort that ran before the socket existed had nothing to close:
        # connect first, then honor it, so every later abort finds the socket.
        conn.connect()
        abortable.raise_if_aborted()
        conn.request("POST", req.selector, body=req.data, headers=dict(req.header_items()))
        resp = conn.getresponse()
        if resp.status >= HTTPStatus.BAD_REQUEST:
            raise urllib.error.HTTPError(url, resp.status, resp.reason, resp.headers, resp)
        return read_json_response(resp)
    finally:
        conn.close()


@contextmanager
def cancellable_post_scope(cancel_handle: Any) -> Iterator[None]:
    """Route this thread's ``_post`` calls over a connection the cancel severs.

    An already-cancelled handle raises before anything is sent; a failure after
    the cancel surfaces as the handle's cancellation error, not a transport one.
    """
    if cancel_handle is None:
        yield
        return
    raise_if_cancelled(cancel_handle)
    request = AbortableRequest()
    previous = getattr(post_abort_scope, "request", None)
    post_abort_scope.request = request
    unregister_cancel = register_cancel_callback(cancel_handle, request.abort)
    try:
        yield
    except Exception:
        raise_if_cancelled(cancel_handle)
        raise
    finally:
        unregister_cancel()
        post_abort_scope.request = previous


__all__ = [
    "AbortableRequest",
    "cancellable_post_scope",
    "post_abort_scope",
    "post_abortable",
]
