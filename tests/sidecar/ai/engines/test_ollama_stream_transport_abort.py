from __future__ import annotations

import socket
import threading
import time
import urllib.request

from sidecar.ai.engines.ollama_stream_transport import iter_cancel_aware_response_lines
from sidecar.runtime.multiplexer import TurnCancellationHandle


def _serve_one_line_then_stall(server: socket.socket, release: threading.Event) -> None:
    client, _address = server.accept()
    try:
        client.recv(65536)
        client.sendall(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\n"
            b"Transfer-Encoding: chunked\r\n\r\n"
        )
        client.sendall(b'8\r\n{"a":1}\n\r\n')
        release.wait(timeout=30)
    finally:
        client.close()


def test_cancel_unblocks_a_reader_stalled_inside_a_real_socket_read() -> None:
    # A real urllib response: closing it while another thread is inside read1()
    # used to wait for that thread's socket timeout instead of ending the read.
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    release = threading.Event()
    server_thread = threading.Thread(
        target=_serve_one_line_then_stall, args=(server, release), daemon=True
    )
    server_thread.start()
    port = server.getsockname()[1]
    handle = TurnCancellationHandle(request_id="req-stalled")
    first_line = threading.Event()
    outcome: list[str] = []

    def read_lines() -> None:
        try:
            response = urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=8)
            for _line in iter_cancel_aware_response_lines(response, handle):
                first_line.set()
            outcome.append("ended")
        except BaseException as error:  # noqa: BLE001 - the test records any exit.
            outcome.append(type(error).__name__)

    reader = threading.Thread(target=read_lines, daemon=True)
    reader.start()
    try:
        assert first_line.wait(timeout=5)
        time.sleep(0.2)  # let the reader block in the next socket read
        started = time.monotonic()
        handle.cancel(reason="provider_stream_closed")
        cancel_seconds = time.monotonic() - started
        reader.join(timeout=3)
        reader_stopped = not reader.is_alive()
    finally:
        release.set()
        reader.join(timeout=10)
        server_thread.join(timeout=5)
        server.close()

    assert cancel_seconds < 3, f"cancel blocked for {cancel_seconds:.1f}s"
    assert reader_stopped, "the stalled reader was still blocked after the cancel"
    assert outcome and outcome[0] != "ended"
