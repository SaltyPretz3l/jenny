"""Stdlib HTTP + SSE JSON-RPC client primitive for the MCP Streamable-HTTP transport.

Pure plumbing: this module POSTs a JSON body and returns the matching JSON-RPC
reply, dispatching on the response ``Content-Type`` (single ``application/json``
document, or a ``text/event-stream`` SSE stream). It carries **no** MCP
semantics, auth policy, or config — every failure surfaces as ``SSEHttpError``,
which the transport layer maps to a structured ``MCPError``. No third-party
dependency: only ``http.client`` / ``urllib`` from the stdlib.
"""

from __future__ import annotations

import http.client
import json
import select
import socket
import time
import urllib.parse
from typing import Any

from sidecar.ai.mcp.client_support import raise_if_cancelled as _raise_if_cancelled
from sidecar.ai.tools.builtins.web_http import (
    _PinnedHTTPConnection,
    _PinnedHTTPSConnection,
)
from sidecar.runtime.chat_models import TerminalChatStateError

_DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024  # 8 MiB DoS guard.
_MAX_SSE_LINES = 100_000  # Line-count DoS guard for slow-drip streams.
_READ_CHUNK_BYTES = 4096
_HTTP_SUCCESS_MIN = 200
_HTTP_REDIRECT_MIN = 300
_HTTP_SERVER_ERROR_MIN = 500
# Reserved reply key the transport reads for the Streamable-HTTP session id.
# Sourced ONLY from the Mcp-Session-Id response header — never from the server's
# JSON body (which is untrusted and could otherwise inject it).
_SESSION_ID_KEY = "__mcp_session_id__"


class SSEHttpError(Exception):
    """Transport-level HTTP/SSE failure the caller maps to an ``MCPError``.

    ``status`` carries the HTTP status code when the failure is an HTTP error
    response (``>= 400``); it is ``None`` for connect/timeout/parse failures.
    ``retryable`` is a hint the transport may consult; connection-level faults
    are retryable, protocol/content faults are not.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.retryable = retryable


def _connection_for(
    parsed: urllib.parse.ParseResult,
    *,
    timeout_seconds: float,
    pinned_ip: str,
) -> http.client.HTTPConnection:
    """Build a connection that targets ``pinned_ip`` while keeping the original
    hostname for the Host header and TLS SNI (defeats DNS rebinding).

    ``pinned_ip`` is the address the SSRF validator resolved and vetted at
    construction time. An empty ``pinned_ip`` means the URL host was a validated
    public literal IP (no hostname to rebind); connect to it directly.
    """
    host = parsed.hostname or ""
    safe_pin = str(pinned_ip or "").strip()
    if parsed.scheme == "https":
        port = parsed.port or 443
        if safe_pin:
            return _PinnedHTTPSConnection(
                host,
                pinned_ip=safe_pin,
                port=port,
                timeout=timeout_seconds,
            )
        return http.client.HTTPSConnection(host, port, timeout=timeout_seconds)
    port = parsed.port or 80
    if safe_pin:
        return _PinnedHTTPConnection(host, pinned_ip=safe_pin, port=port, timeout=timeout_seconds)
    return http.client.HTTPConnection(host, port, timeout=timeout_seconds)


def _request_path(parsed: urllib.parse.ParseResult) -> str:
    path = parsed.path or "/"
    if parsed.query:
        return f"{path}?{parsed.query}"
    return path


def _content_type(response: http.client.HTTPResponse) -> str:
    raw = response.getheader("Content-Type", "") or ""
    return raw.split(";", 1)[0].strip().lower()


def _register_connection_cancel_callback(
    cancel_handle: Any,
    conn: Any,
) -> Any:
    register = getattr(cancel_handle, "register_cancel_callback", None)
    if not callable(register):
        return lambda: None

    def close_connection(_reason: str) -> None:
        connection_socket = getattr(conn, "sock", None)
        if connection_socket is not None:
            try:
                connection_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        try:
            conn.close()
        except (OSError, http.client.HTTPException):
            pass

    unregister = register(close_connection)
    return unregister if callable(unregister) else lambda: None


def _wait_for_socket_readable(
    connection_socket: Any,
    *,
    deadline: float,
    cancel_handle: Any,
) -> None:
    if connection_socket is None:
        _raise_if_cancelled(cancel_handle, message="http request cancelled")
        return
    while True:
        _raise_if_cancelled(cancel_handle, message="http request cancelled")
        pending = getattr(connection_socket, "pending", None)
        if callable(pending):
            try:
                if pending() > 0:
                    return
            except (OSError, ValueError):
                pass
        remaining = _remaining(deadline)
        if remaining <= 0:
            raise SSEHttpError("response timed out", retryable=True)
        try:
            readable, _, _ = select.select(
                [connection_socket],
                [],
                [],
                min(0.1, remaining),
            )
        except (OSError, ValueError) as error:
            _raise_if_cancelled(cancel_handle, message="http request cancelled")
            raise SSEHttpError("response socket failed", retryable=True) from error
        if readable:
            return


def _response_socket(response: Any) -> Any:
    raw = getattr(getattr(response, "fp", None), "raw", None)
    return getattr(raw, "_sock", None)


def _read_response_chunk(
    response: Any,
    *,
    deadline: float,
    cancel_handle: Any,
) -> bytes:
    if getattr(response, "length", None) == 0:
        return b""
    _wait_for_socket_readable(
        _response_socket(response),
        deadline=deadline,
        cancel_handle=cancel_handle,
    )
    read = getattr(response, "read1", None)
    if not callable(read):
        read = response.read
    return read(_READ_CHUNK_BYTES)


def post_jsonrpc(  # noqa: PLR0913 -- stable Streamable-HTTP transport boundary
    url: str,
    payload: dict[str, Any],
    *,
    headers: dict[str, str],
    timeout_seconds: float,
    pinned_ip: str = "",
    max_response_bytes: int = _DEFAULT_MAX_RESPONSE_BYTES,
    cancel_handle: Any = None,
) -> dict[str, Any]:
    """POST a JSON-RPC request and return the matching reply dict.

    Dispatches on the response ``Content-Type``:
    ``application/json`` -> the single JSON-RPC reply; ``text/event-stream``
    -> a line-buffered SSE parse returning the first JSON-RPC object whose
    ``id`` matches ``payload["id"]``. HTTP status ``>= 300`` (redirects are
    refused, not followed -- SSRF hardening) or an unexpected content type
    raises ``SSEHttpError`` (with ``status`` set for HTTP errors). Connects to
    ``pinned_ip`` (the SSRF-validated address) when supplied. The whole exchange
    is bounded by ``timeout_seconds`` and ``max_response_bytes``.
    """
    deadline = time.monotonic() + max(0.0, float(timeout_seconds))
    request_id = payload.get("id")
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    parsed = urllib.parse.urlparse(url)
    conn = _connection_for(parsed, timeout_seconds=timeout_seconds, pinned_ip=pinned_ip)
    unregister_cancel = _register_connection_cancel_callback(cancel_handle, conn)
    try:
        _raise_if_cancelled(cancel_handle, message="http request cancelled")
        send_headers = dict(headers)
        send_headers.setdefault("Content-Type", "application/json")
        send_headers["Content-Length"] = str(len(body))
        try:
            _raise_if_cancelled(cancel_handle, message="http request cancelled")
            conn.request("POST", _request_path(parsed), body=body, headers=send_headers)
            _wait_for_socket_readable(
                getattr(conn, "sock", None),
                deadline=deadline,
                cancel_handle=cancel_handle,
            )
            response = conn.getresponse()
        except (OSError, http.client.HTTPException) as error:
            raise SSEHttpError(
                f"http request failed: {type(error).__name__}",
                retryable=True,
            ) from error

        status = response.status
        # http.client never follows redirects; refuse any 3xx (a redirect target
        # would bypass the SSRF validation done on the original url) as well as
        # every 4xx/5xx error status.
        if status >= _HTTP_REDIRECT_MIN:
            _drain(
                response,
                deadline=deadline,
                max_bytes=max_response_bytes,
                cancel_handle=cancel_handle,
            )
            raise SSEHttpError(
                f"http status {status}",
                status=status,
                retryable=status >= _HTTP_SERVER_ERROR_MIN,
            )

        session_id = response.getheader("Mcp-Session-Id")
        content_type = _content_type(response)
        if content_type == "text/event-stream":
            reply = _read_sse_reply(
                response,
                request_id=request_id,
                deadline=deadline,
                max_bytes=max_response_bytes,
                cancel_handle=cancel_handle,
            )
        elif content_type in {"application/json", ""}:
            reply = _read_json_reply(
                response,
                request_id=request_id,
                deadline=deadline,
                max_bytes=max_response_bytes,
                cancel_handle=cancel_handle,
            )
        else:
            _drain(
                response,
                deadline=deadline,
                max_bytes=max_response_bytes,
                cancel_handle=cancel_handle,
            )
            raise SSEHttpError(f"unexpected content type: {content_type}")
        # Strip any body-supplied reserved key BEFORE trusting the header, so a
        # server cannot inject a session id via its JSON payload.
        reply.pop(_SESSION_ID_KEY, None)
        if session_id and session_id.strip():
            reply[_SESSION_ID_KEY] = session_id.strip()
        return reply
    except TerminalChatStateError as error:
        raise SSEHttpError("http request cancelled", retryable=True) from error
    finally:
        unregister_cancel()
        try:
            conn.close()
        except (OSError, http.client.HTTPException):
            pass


def post_notification(  # noqa: PLR0913 -- stable notification transport boundary
    url: str,
    payload: dict[str, Any],
    *,
    headers: dict[str, str],
    timeout_seconds: float,
    pinned_ip: str = "",
    cancel_handle: Any = None,
) -> None:
    """Fire a JSON-RPC notification (no id) and drain/ignore the body.

    Accepts any ``2xx`` status; a non-2xx status (redirects included -- never
    followed) or a connect/timeout failure raises ``SSEHttpError``. Connects to
    ``pinned_ip`` (the SSRF-validated address) when supplied.
    """
    deadline = time.monotonic() + max(0.0, float(timeout_seconds))
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    parsed = urllib.parse.urlparse(url)
    conn = _connection_for(parsed, timeout_seconds=timeout_seconds, pinned_ip=pinned_ip)
    unregister_cancel = _register_connection_cancel_callback(cancel_handle, conn)
    try:
        _raise_if_cancelled(cancel_handle, message="http request cancelled")
        send_headers = dict(headers)
        send_headers.setdefault("Content-Type", "application/json")
        send_headers["Content-Length"] = str(len(body))
        try:
            _raise_if_cancelled(cancel_handle, message="http request cancelled")
            conn.request("POST", _request_path(parsed), body=body, headers=send_headers)
            _wait_for_socket_readable(
                getattr(conn, "sock", None),
                deadline=deadline,
                cancel_handle=cancel_handle,
            )
            response = conn.getresponse()
        except (OSError, http.client.HTTPException) as error:
            raise SSEHttpError(
                f"http request failed: {type(error).__name__}",
                retryable=True,
            ) from error
        status = response.status
        _drain(
            response,
            deadline=deadline,
            max_bytes=_DEFAULT_MAX_RESPONSE_BYTES,
            cancel_handle=cancel_handle,
        )
        if not (_HTTP_SUCCESS_MIN <= status < _HTTP_REDIRECT_MIN):
            raise SSEHttpError(
                f"http status {status}",
                status=status,
                retryable=status >= _HTTP_SERVER_ERROR_MIN,
            )
    except TerminalChatStateError as error:
        raise SSEHttpError("http request cancelled", retryable=True) from error
    finally:
        unregister_cancel()
        try:
            conn.close()
        except (OSError, http.client.HTTPException):
            pass


def _remaining(deadline: float) -> float:
    return deadline - time.monotonic()


def _drain(
    response: http.client.HTTPResponse,
    *,
    deadline: float,
    max_bytes: int,
    cancel_handle: Any = None,
) -> None:
    read = 0
    try:
        while read < max_bytes and _remaining(deadline) > 0:
            chunk = _read_response_chunk(
                response,
                deadline=deadline,
                cancel_handle=cancel_handle,
            )
            if not chunk:
                return
            read += len(chunk)
    except (OSError, http.client.HTTPException):
        return


def _read_json_reply(
    response: http.client.HTTPResponse,
    *,
    request_id: Any,
    deadline: float,
    max_bytes: int,
    cancel_handle: Any = None,
) -> dict[str, Any]:
    buffer = bytearray()
    try:
        while _remaining(deadline) > 0:
            chunk = _read_response_chunk(
                response,
                deadline=deadline,
                cancel_handle=cancel_handle,
            )
            if not chunk:
                break
            buffer.extend(chunk)
            if len(buffer) > max_bytes:
                raise SSEHttpError("response exceeded maximum size")
        else:
            raise SSEHttpError("response timed out", retryable=True)
    except (OSError, http.client.HTTPException) as error:
        raise SSEHttpError(
            f"response read failed: {type(error).__name__}",
            retryable=True,
        ) from error
    reply = _parse_jsonrpc_object(bytes(buffer))
    if "id" not in reply or reply.get("id") != request_id:
        raise SSEHttpError("json response id did not match request")
    return reply


def _parse_jsonrpc_object(raw: bytes) -> dict[str, Any]:
    try:
        data = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise SSEHttpError(f"invalid json reply: {type(error).__name__}") from error
    if not isinstance(data, dict):
        raise SSEHttpError("json reply was not an object")
    return data


def _read_sse_reply(
    response: http.client.HTTPResponse,
    *,
    request_id: Any,
    deadline: float,
    max_bytes: int,
    cancel_handle: Any = None,
) -> dict[str, Any]:
    """Line-buffered SSE parse returning the first id-matching JSON-RPC object.

    ``data:`` lines accumulate across an event (joined with ``\\n``); a blank
    line dispatches the accumulated event. ``event:`` values other than
    ``message`` (and comment lines beginning with ``:``) are ignored. Each
    dispatched ``data`` payload is parsed as JSON; the first object whose ``id``
    equals ``request_id`` is returned. Notifications and non-matching ids are
    skipped. Bounded by the deadline and by ``max_bytes`` / line count.
    """
    line_buffer = bytearray()
    total_bytes = 0
    line_count = 0
    data_lines: list[str] = []
    try:
        while True:
            if _remaining(deadline) <= 0:
                raise SSEHttpError("sse stream timed out", retryable=True)
            chunk = _read_response_chunk(
                response,
                deadline=deadline,
                cancel_handle=cancel_handle,
            )
            if not chunk:
                # Stream ended before the matching reply arrived.
                raise SSEHttpError("sse stream closed before a matching reply")
            total_bytes += len(chunk)
            if total_bytes > max_bytes:
                raise SSEHttpError("sse stream exceeded maximum size")
            line_buffer.extend(chunk)
            while b"\n" in line_buffer:
                raw_line, _, rest = line_buffer.partition(b"\n")
                line_buffer = bytearray(rest)
                line_count += 1
                if line_count > _MAX_SSE_LINES:
                    raise SSEHttpError("sse stream exceeded maximum line count")
                matched = _consume_sse_line(
                    bytes(raw_line),
                    data_lines=data_lines,
                    request_id=request_id,
                )
                if matched is not None:
                    return matched
    except (OSError, http.client.HTTPException) as error:
        raise SSEHttpError(
            f"sse read failed: {type(error).__name__}",
            retryable=True,
        ) from error


def _consume_sse_line(
    raw_line: bytes,
    *,
    data_lines: list[str],
    request_id: Any,
) -> dict[str, Any] | None:
    """Process one SSE line; return an id-matching JSON-RPC object or ``None``.

    Mutates ``data_lines`` (accumulating the current event); clears it on
    dispatch (blank line).
    """
    line = raw_line.decode("utf-8", errors="replace").rstrip("\r")
    if line == "":
        if not data_lines:
            return None
        payload_text = "\n".join(data_lines)
        data_lines.clear()
        return _match_sse_payload(payload_text, request_id=request_id)
    if line.startswith(":"):
        # Comment line — ignore.
        return None
    if line.startswith("data:"):
        data_lines.append(line[len("data:") :].lstrip(" "))
        return None
    # event:/id:/retry: and any other field are ignored for our purposes.
    return None


def _match_sse_payload(payload_text: str, *, request_id: Any) -> dict[str, Any] | None:
    if not payload_text.strip():
        return None
    try:
        data = json.loads(payload_text)
    except json.JSONDecodeError as error:
        raise SSEHttpError(f"invalid json in sse event: {type(error).__name__}") from error
    if not isinstance(data, dict):
        return None
    if data.get("id") == request_id:
        return data
    # Non-matching id or a notification (no id) — skip and keep reading.
    return None
