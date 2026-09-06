"""Red-first tests for the stdlib HTTP+SSE JSON-RPC client primitive."""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

import pytest

from sidecar.ai.mcp import sse_http_client as sse_module
from sidecar.ai.mcp.sse_http_client import (
    SSEHttpError,
    post_jsonrpc,
    post_notification,
)
from sidecar.runtime.multiplexer import TurnCancellationHandle


class _FakeHandler(BaseHTTPRequestHandler):
    # Set per-test on the server instance.
    responder: Callable[["_FakeHandler", dict[str, Any]], None]

    def log_message(self, *args: Any) -> None:  # noqa: A002 - silence test server logs
        return

    def do_POST(self) -> None:  # noqa: N802 - required http.server hook name
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except json.JSONDecodeError:
            payload = {}
        self.server.responder(self, payload)  # type: ignore[attr-defined]


class _FakeServer:
    def __init__(self, responder: Callable[[_FakeHandler, dict[str, Any]], None]) -> None:
        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), _FakeHandler)
        self._httpd.responder = responder  # type: ignore[attr-defined]
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        host, port = self._httpd.server_address[:2]
        return f"http://{host}:{port}/"

    def shutdown(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=2.0)


@pytest.fixture()
def make_server() -> Any:
    servers: list[_FakeServer] = []

    def _make(responder: Callable[[_FakeHandler, dict[str, Any]], None]) -> _FakeServer:
        server = _FakeServer(responder)
        servers.append(server)
        return server

    yield _make
    for server in servers:
        server.shutdown()


def _write_json(handler: _FakeHandler, body: dict[str, Any], *, status: int = 200) -> None:
    raw = json.dumps(body).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(raw)))
    handler.end_headers()
    handler.wfile.write(raw)


def _write_sse(handler: _FakeHandler, chunks: list[str], *, status: int = 200) -> None:
    handler.send_response(status)
    handler.send_header("Content-Type", "text/event-stream")
    handler.end_headers()
    for chunk in chunks:
        handler.wfile.write(chunk.encode("utf-8"))
        handler.wfile.flush()


def test_application_json_reply_accepts_matching_id(make_server: Any) -> None:
    def responder(handler: _FakeHandler, payload: dict[str, Any]) -> None:
        _write_json(handler, {"jsonrpc": "2.0", "id": payload["id"], "result": {"ok": True}})

    server = make_server(responder)
    reply = post_jsonrpc(
        server.url,
        {"jsonrpc": "2.0", "id": 7, "method": "tools/list", "params": {}},
        headers={},
        timeout_seconds=5.0,
    )
    assert reply["id"] == 7
    assert reply["result"] == {"ok": True}


@pytest.mark.parametrize("response_id", [None, 8], ids=["missing", "mismatched"])
def test_application_json_reply_rejects_nonmatching_id(
    make_server: Any,
    response_id: int | None,
) -> None:
    def responder(handler: _FakeHandler, payload: dict[str, Any]) -> None:
        body: dict[str, Any] = {"jsonrpc": "2.0", "result": {"ok": True}}
        if response_id is not None:
            body["id"] = response_id
        _write_json(handler, body)

    server = make_server(responder)
    with pytest.raises(SSEHttpError, match="response id"):
        post_jsonrpc(
            server.url,
            {"jsonrpc": "2.0", "id": 7, "method": "tools/list", "params": {}},
            headers={},
            timeout_seconds=5.0,
        )


def test_sse_multiline_data_reassembly(make_server: Any) -> None:
    def responder(handler: _FakeHandler, payload: dict[str, Any]) -> None:
        obj = {"jsonrpc": "2.0", "id": payload["id"], "result": {"value": "a\nb"}}
        text = json.dumps(obj)
        half = len(text) // 2
        # Split the JSON payload across two data: lines (joined with \n).
        chunk = f"event: message\ndata: {text[:half]}\ndata: {text[half:]}\n\n"
        _write_sse(handler, [chunk])

    server = make_server(responder)
    reply = post_jsonrpc(
        server.url,
        {"jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {}},
        headers={},
        timeout_seconds=5.0,
    )
    # Multi-line data: lines join with \n, then parse as one JSON document.
    assert reply["id"] == 3
    assert reply["result"]["value"] == "a\nb"


def test_sse_skips_non_matching_ids_and_comments(make_server: Any) -> None:
    def responder(handler: _FakeHandler, payload: dict[str, Any]) -> None:
        other = json.dumps({"jsonrpc": "2.0", "id": 999, "result": {"nope": True}})
        notif = json.dumps({"jsonrpc": "2.0", "method": "notifications/progress"})
        match = json.dumps({"jsonrpc": "2.0", "id": payload["id"], "result": {"hit": True}})
        chunks = [
            ": this is a comment\n\n",
            f"data: {other}\n\n",
            f"data: {notif}\n\n",
            f"event: message\ndata: {match}\n\n",
        ]
        _write_sse(handler, chunks)

    server = make_server(responder)
    reply = post_jsonrpc(
        server.url,
        {"jsonrpc": "2.0", "id": 42, "method": "tools/list", "params": {}},
        headers={},
        timeout_seconds=5.0,
    )
    assert reply["id"] == 42
    assert reply["result"] == {"hit": True}


def test_timeout_on_hanging_response_raises_within_budget(make_server: Any) -> None:
    release = threading.Event()

    def responder(handler: _FakeHandler, payload: dict[str, Any]) -> None:
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.end_headers()
        # Hang without sending the dispatched event until the test releases us.
        release.wait(timeout=10.0)

    server = make_server(responder)
    started = time.monotonic()
    with pytest.raises(SSEHttpError):
        post_jsonrpc(
            server.url,
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
            headers={},
            timeout_seconds=0.4,
        )
    elapsed = time.monotonic() - started
    release.set()
    assert elapsed < 3.0


def test_oversized_stream_is_capped(make_server: Any) -> None:
    def responder(handler: _FakeHandler, payload: dict[str, Any]) -> None:
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.end_headers()
        junk = "data: " + ("x" * 4096) + "\n"
        try:
            for _ in range(10000):
                handler.wfile.write(junk.encode("utf-8"))
                handler.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    server = make_server(responder)
    with pytest.raises(SSEHttpError):
        post_jsonrpc(
            server.url,
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
            headers={},
            timeout_seconds=5.0,
            max_response_bytes=64 * 1024,
        )


def test_http_500_raises_with_status(make_server: Any) -> None:
    def responder(handler: _FakeHandler, payload: dict[str, Any]) -> None:
        _write_json(handler, {"error": "boom"}, status=500)

    server = make_server(responder)
    with pytest.raises(SSEHttpError) as excinfo:
        post_jsonrpc(
            server.url,
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
            headers={},
            timeout_seconds=5.0,
        )
    assert excinfo.value.status == 500


def test_http_401_raises_with_status(make_server: Any) -> None:
    def responder(handler: _FakeHandler, payload: dict[str, Any]) -> None:
        _write_json(handler, {"error": "unauthorized"}, status=401)

    server = make_server(responder)
    with pytest.raises(SSEHttpError) as excinfo:
        post_jsonrpc(
            server.url,
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
            headers={},
            timeout_seconds=5.0,
        )
    assert excinfo.value.status == 401


def test_body_supplied_session_key_is_stripped(make_server: Any) -> None:
    # A server must not be able to inject the reserved session-id key via its
    # JSON body; only the Mcp-Session-Id response HEADER may populate it.
    def responder(handler: _FakeHandler, payload: dict[str, Any]) -> None:
        _write_json(
            handler,
            {
                "jsonrpc": "2.0",
                "id": payload["id"],
                "result": {"ok": True},
                "__mcp_session_id__": "evil-injected",
            },
        )

    server = make_server(responder)
    reply = post_jsonrpc(
        server.url,
        {"jsonrpc": "2.0", "id": 5, "method": "tools/list", "params": {}},
        headers={},
        timeout_seconds=5.0,
    )
    assert "__mcp_session_id__" not in reply


def test_session_header_wins_over_body_key(make_server: Any) -> None:
    def responder(handler: _FakeHandler, payload: dict[str, Any]) -> None:
        raw = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": payload["id"],
                "result": {"ok": True},
                "__mcp_session_id__": "evil-injected",
            }
        ).encode("utf-8")
        handler.send_response(200)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(raw)))
        handler.send_header("Mcp-Session-Id", "header-session")
        handler.end_headers()
        handler.wfile.write(raw)

    server = make_server(responder)
    reply = post_jsonrpc(
        server.url,
        {"jsonrpc": "2.0", "id": 6, "method": "tools/list", "params": {}},
        headers={},
        timeout_seconds=5.0,
    )
    assert reply["__mcp_session_id__"] == "header-session"


def test_3xx_is_refused_not_followed(make_server: Any) -> None:
    target_hits = {"n": 0}

    def target_responder(handler: _FakeHandler, payload: dict[str, Any]) -> None:
        target_hits["n"] += 1
        _write_json(handler, {"jsonrpc": "2.0", "id": payload.get("id"), "result": {}})

    target = make_server(target_responder)

    def redirect_responder(handler: _FakeHandler, payload: dict[str, Any]) -> None:
        handler.send_response(302)
        handler.send_header("Location", target.url)
        handler.send_header("Content-Length", "0")
        handler.end_headers()

    server = make_server(redirect_responder)
    with pytest.raises(SSEHttpError) as excinfo:
        post_jsonrpc(
            server.url,
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
            headers={},
            timeout_seconds=5.0,
        )
    assert excinfo.value.status == 302
    assert target_hits["n"] == 0


def test_notification_accepts_202_no_body(make_server: Any) -> None:
    seen: list[dict[str, Any]] = []

    def responder(handler: _FakeHandler, payload: dict[str, Any]) -> None:
        seen.append(payload)
        handler.send_response(202)
        handler.send_header("Content-Length", "0")
        handler.end_headers()

    server = make_server(responder)
    # Must not raise on a 2xx no-body notification response.
    post_notification(
        server.url,
        {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
        headers={},
        timeout_seconds=5.0,
    )
    assert seen and seen[0]["method"] == "notifications/initialized"


def test_inflight_jsonrpc_cancel_closes_live_connection(make_server: Any) -> None:
    request_started = threading.Event()
    release_server = threading.Event()

    def responder(handler: _FakeHandler, payload: dict[str, Any]) -> None:
        raw = json.dumps(
            {"jsonrpc": "2.0", "id": payload["id"], "result": {}}
        ).encode("utf-8")
        handler.send_response(200)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(raw)))
        handler.end_headers()
        handler.wfile.flush()
        request_started.set()
        assert release_server.wait(2.0)
        try:
            handler.wfile.write(raw)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

    server = make_server(responder)
    cancel_handle = TurnCancellationHandle(request_id="req-sse-inflight-cancel")
    errors: list[BaseException] = []

    def request() -> None:
        try:
            post_jsonrpc(
                server.url,
                {"jsonrpc": "2.0", "id": 8, "method": "resources/list", "params": {}},
                headers={},
                timeout_seconds=5.0,
                cancel_handle=cancel_handle,
            )
        except BaseException as error:  # noqa: BLE001 - assertion captures worker outcome.
            errors.append(error)

    worker = threading.Thread(target=request, daemon=True)
    worker.start()
    assert request_started.wait(1.0)

    started_at = time.monotonic()
    cancel_handle.cancel(reason="test")
    worker.join(timeout=1.0)
    elapsed = time.monotonic() - started_at
    release_server.set()

    assert worker.is_alive() is False
    assert elapsed < 1.0
    assert len(errors) == 1
    assert isinstance(errors[0], SSEHttpError)


def test_precancelled_jsonrpc_never_dispatches_request(
    make_server: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A handle cancelled before the call must never put a request on the wire.

    This used to POST at a real server, sleep 50ms, and assert the handler had
    not run. That only showed the request had not arrived YET -- a genuine
    dispatch from a slow handler would have landed after the assertion and the
    test would still have passed. Fail on the send itself instead, which is
    exact and needs no waiting.
    """

    class _NeverSends:
        sock = None

        def request(self, *args: Any, **kwargs: Any) -> None:
            raise AssertionError(
                "post_jsonrpc dispatched a request despite a pre-cancelled handle"
            )

        def getresponse(self) -> None:
            raise AssertionError("post_jsonrpc read a response despite a pre-cancelled handle")

        def close(self) -> None:
            return None

    monkeypatch.setattr(sse_module, "_connection_for", lambda *a, **k: _NeverSends())

    server = make_server(lambda handler, payload: None)
    cancel_handle = TurnCancellationHandle(request_id="req-sse-precancel")
    cancel_handle.cancel(reason="test")

    with pytest.raises(SSEHttpError, match="cancelled"):
        post_jsonrpc(
            server.url,
            {"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {}},
            headers={},
            timeout_seconds=5.0,
            cancel_handle=cancel_handle,
        )
