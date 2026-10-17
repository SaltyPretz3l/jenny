"""Real-adapter cancellation of non-streaming ``generate`` (row 58 W2 preemption).

Each test drives the adapter's real ``generate`` against a real loopback HTTP
server that accepts the generation request and then holds it open, the way a
local server does while it prefills/decodes a non-streaming completion.
"""

from __future__ import annotations

import socket
import threading
import time
from collections.abc import Callable
from typing import Any

import pytest

from sidecar.ai.engines.ollama import OllamaEngine
from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.turn_state import TURN_STATE_CANCELLED

_GENERATION_PATHS = (b"/v1/chat/completions", b"/api/chat")


class _StallingServer:
    """Loopback HTTP server that stalls generation requests until released."""

    def __init__(self, *, send_headers: bool) -> None:
        self._send_headers = send_headers
        self._listener = socket.socket()
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(8)
        self._listener.settimeout(0.1)
        self.port = self._listener.getsockname()[1]
        self.request_lines: list[bytes] = []
        self.generation_seen = threading.Event()
        self.client_closed = threading.Event()
        self._release = threading.Event()
        self._threads: list[threading.Thread] = []
        accept = threading.Thread(target=self._accept_loop, daemon=True)
        accept.start()
        self._threads.append(accept)

    def _accept_loop(self) -> None:
        while not self._release.is_set():
            try:
                client, _address = self._listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            worker = threading.Thread(target=self._handle, args=(client,), daemon=True)
            worker.start()
            self._threads.append(worker)

    def _read_request(self, client: socket.socket) -> bytes:
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = client.recv(65536)
            if not chunk:
                return data
            data += chunk
        head, _, body = data.partition(b"\r\n\r\n")
        length = 0
        for line in head.split(b"\r\n")[1:]:
            name, _, value = line.partition(b":")
            if name.strip().lower() == b"content-length":
                length = int(value.strip())
        while len(body) < length:
            chunk = client.recv(65536)
            if not chunk:
                break
            body += chunk
        return head

    def _handle(self, client: socket.socket) -> None:
        with client:
            client.settimeout(5)
            head = self._read_request(client)
            request_line = head.split(b"\r\n", 1)[0]
            self.request_lines.append(request_line)
            if not any(path in request_line for path in _GENERATION_PATHS):
                client.sendall(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                return
            if self._send_headers:
                client.sendall(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                    b"Content-Length: 4096\r\n\r\n{"
                )
            self.generation_seen.set()
            client.settimeout(0.05)
            while not self._release.is_set():
                try:
                    chunk = client.recv(1024)
                except socket.timeout:
                    continue
                except OSError:
                    self.client_closed.set()
                    return
                if not chunk:
                    self.client_closed.set()
                    return

    def close(self) -> None:
        self._release.set()
        self._listener.close()
        for thread in self._threads:
            thread.join(timeout=5)


def _openai_compatible(port: int) -> OpenAICompatibleEngine:
    engine = OpenAICompatibleEngine(host=f"http://127.0.0.1:{port}/v1")
    engine.model_name = "stall-model"
    engine._ready = True
    return engine


def _ollama(port: int) -> OllamaEngine:
    engine = OllamaEngine(host=f"http://127.0.0.1:{port}")
    engine.model_name = "stall-model"
    engine._ready = True
    return engine


def _generate(engine: Any, handle: TurnCancellationHandle) -> str:
    return engine.generate(
        prompt="hello",
        max_tokens=16,
        temperature=0.0,
        reasoning_effort="low",
        system="system",
        cancel_handle=handle,
    )


_ADAPTERS: dict[str, Callable[[int], Any]] = {
    "openai-compatible": _openai_compatible,
    "ollama": _ollama,
}


def _assert_cancelled(error: BaseException | None) -> None:
    assert isinstance(error, TerminalChatStateError), repr(error)
    assert error.status == TURN_STATE_CANCELLED


@pytest.mark.parametrize("adapter", sorted(_ADAPTERS))
@pytest.mark.parametrize("send_headers", [False, True], ids=["before_headers", "after_headers"])
def test_cancel_severs_a_stalled_generate_request(adapter: str, send_headers: bool) -> None:
    server = _StallingServer(send_headers=send_headers)
    engine = _ADAPTERS[adapter](server.port)
    handle = TurnCancellationHandle(request_id="aux_cancel_test")
    outcome: dict[str, Any] = {}

    def run() -> None:
        try:
            outcome["result"] = _generate(engine, handle)
        except BaseException as error:  # noqa: BLE001 - the test records any exit.
            outcome["error"] = error
        outcome["ended_at"] = time.monotonic()

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    try:
        assert server.generation_seen.wait(timeout=5), (server.request_lines, outcome)
        time.sleep(0.2)
        cancelled_at = time.monotonic()
        handle.cancel(reason="preempted")
        worker.join(timeout=3)
        assert not worker.is_alive(), "generate stayed blocked after the cancel"
        assert server.client_closed.wait(timeout=2), "server never saw the connection close"
    finally:
        server.close()
        worker.join(timeout=5)
        engine.close()

    _assert_cancelled(outcome.get("error"))
    assert outcome["ended_at"] - cancelled_at < 1.0


@pytest.mark.parametrize("adapter", sorted(_ADAPTERS))
def test_a_pre_cancelled_handle_sends_no_request(adapter: str) -> None:
    server = _StallingServer(send_headers=False)
    engine = _ADAPTERS[adapter](server.port)
    handle = TurnCancellationHandle(request_id="aux_pre_cancelled")
    handle.cancel(reason="preempted")
    started = time.monotonic()
    try:
        with pytest.raises(TerminalChatStateError) as raised:
            _generate(engine, handle)
        elapsed = time.monotonic() - started
        time.sleep(0.1)
    finally:
        server.close()
        engine.close()

    _assert_cancelled(raised.value)
    assert elapsed < 0.5
    assert server.request_lines == []
