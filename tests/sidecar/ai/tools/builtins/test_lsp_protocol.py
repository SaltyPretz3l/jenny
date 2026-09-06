"""LSP Phase 2 protocol/lifecycle tests."""

from __future__ import annotations

import io
import logging
import sys
import textwrap
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins.lsp import protocol as protocol_module
from sidecar.ai.tools.builtins.lsp.protocol import (
    LSPProcessSession,
    LSPProcessSessionLimits,
    LSPProtocolError,
    LSPRequestTimeout,
    LSPServerTerminated,
)


def _write_fake_server(tmp_path: Path, body: str) -> Path:
    server = tmp_path / "fake_lsp_server.py"
    server.write_text(textwrap.dedent(body), encoding="utf-8")
    return server


_SERVER_SCRIPT = r"""
import json
import sys
import time

mode = sys.argv[1] if len(sys.argv) > 1 else "normal"

def read_message():
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        if line in (b"\r\n", b"\n"):
            break
        key, value = line.decode("ascii").split(":", 1)
        headers[key.lower()] = value.strip()
    length = int(headers["content-length"])
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))

def write_message(payload):
    raw = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(b"Content-Length: " + str(len(raw)).encode("ascii") + b"\r\n\r\n")
    sys.stdout.buffer.write(raw)
    sys.stdout.buffer.flush()

while True:
    message = read_message()
    if message is None:
        break
    method = message.get("method")
    if mode == "crash":
        sys.stderr.write("server crash detail " * 30)
        sys.stderr.flush()
        sys.exit(3)
    if mode == "malformed":
        sys.stdout.buffer.write(b"Content-Length: 9\r\n\r\n{not-json")
        sys.stdout.buffer.flush()
        continue
    if mode == "oversized":
        sys.stdout.buffer.write(b"Content-Length: 999999\r\n\r\n{}")
        sys.stdout.buffer.flush()
        continue
    if mode == "huge_header":
        sys.stdout.buffer.write(b"X-Test: " + (b"x" * 20000))
        sys.stdout.buffer.flush()
        continue
    if mode == "many_headers":
        sys.stdout.buffer.write((b"X-Test: value\r\n" * 40) + b"\r\n")
        sys.stdout.buffer.flush()
        continue
    if mode == "slow":
        time.sleep(2)
    if mode == "notify_first":
        write_message({
            "jsonrpc": "2.0",
            "method": "window/logMessage",
            "params": {"type": 3, "message": "warming up"},
        })
    if mode == "request_first":
        write_message({
            "jsonrpc": "2.0",
            "id": "server-request-1",
            "method": "workspace/configuration",
            "params": {"items": []},
        })
        client_response = read_message()
        if client_response is None or client_response.get("error", {}).get("code") != -32601:
            sys.exit(4)
    if method == "shutdown":
        write_message({"jsonrpc": "2.0", "id": message.get("id"), "result": None})
        break
    if method == "initialize":
        result = {"capabilities": {"textDocumentSync": 1}}
    else:
        result = {"method": method, "params": message.get("params")}
    write_message({"jsonrpc": "2.0", "id": message.get("id"), "result": result})
"""


def _session(tmp_path: Path, mode: str = "normal", **kwargs: object) -> LSPProcessSession:
    server = _write_fake_server(tmp_path, _SERVER_SCRIPT)
    limits = LSPProcessSessionLimits(**kwargs) if kwargs else None
    return LSPProcessSession(
        command=(sys.executable, str(server), mode),
        workspace_root=tmp_path,
        limits=limits,
    )


def test_session_initializes_and_round_trips_requests(tmp_path: Path) -> None:
    session = _session(tmp_path)
    try:
        session.start()
        initialized = session.request("initialize", {"rootUri": tmp_path.as_uri()})
        echoed = session.request("workspace/symbol", {"query": "Thing"})
    finally:
        session.close()

    assert initialized == {"capabilities": {"textDocumentSync": 1}}
    assert echoed == {"method": "workspace/symbol", "params": {"query": "Thing"}}
    assert not session.is_running


def test_close_sends_shutdown_and_stops_process(tmp_path: Path) -> None:
    session = _session(tmp_path)
    session.start()
    assert session.is_running

    session.close()

    assert not session.is_running


def test_request_ignores_notifications_until_matching_response(tmp_path: Path) -> None:
    session = _session(tmp_path, "notify_first")
    try:
        result = session.request("workspace/symbol", {"query": "Thing"})
        notifications = session.drain_notifications()
        assert session.drain_notifications() == []
    finally:
        session.close()

    assert result == {"method": "workspace/symbol", "params": {"query": "Thing"}}
    assert notifications == [
        {
            "jsonrpc": "2.0",
            "method": "window/logMessage",
            "params": {"type": 3, "message": "warming up"},
        }
    ]


def test_request_answers_server_request_until_matching_response(tmp_path: Path) -> None:
    session = _session(tmp_path, "request_first")
    try:
        result = session.request("workspace/symbol", {"query": "Thing"})
    finally:
        session.close()

    assert result == {"method": "workspace/symbol", "params": {"query": "Thing"}}


def test_closed_session_cannot_restart_process(tmp_path: Path) -> None:
    session = _session(tmp_path)
    session.start()
    session.close()

    with pytest.raises(LSPServerTerminated, match="closed"):
        session.request("initialize", {})

    assert not session.is_running


def test_start_failure_uses_protocol_error_without_raw_command_path(tmp_path: Path) -> None:
    missing = tmp_path / "missing-language-server.exe"
    session = LSPProcessSession(command=(str(missing),), workspace_root=tmp_path)

    with pytest.raises(LSPServerTerminated) as excinfo:
        session.request("initialize", {})

    assert str(missing) not in str(excinfo.value)
    assert "failed to start LSP process" in str(excinfo.value)


def test_request_timeout_closes_process(tmp_path: Path) -> None:
    session = _session(tmp_path, "slow", request_timeout_seconds=0.05)
    session.start()
    try:
        with pytest.raises(LSPRequestTimeout):
            session.request("initialize", {})

        assert not session.is_running
    finally:
        # close() shuts down the per-session reader ThreadPoolExecutor. The failure
        # path leaves the process dead but the executor thread alive, so without this
        # these tests stack up reader threads for the rest of the run.
        session.close()


def test_malformed_response_closes_process(tmp_path: Path) -> None:
    session = _session(tmp_path, "malformed")
    session.start()
    try:
        with pytest.raises(LSPProtocolError):
            session.request("initialize", {})

        assert not session.is_running
    finally:
        # close() shuts down the per-session reader ThreadPoolExecutor. The failure
        # path leaves the process dead but the executor thread alive, so without this
        # these tests stack up reader threads for the rest of the run.
        session.close()


def test_oversized_response_header_closes_process_without_reading_body(tmp_path: Path) -> None:
    session = _session(tmp_path, "oversized", max_message_bytes=64)
    session.start()
    try:
        with pytest.raises(LSPProtocolError, match="exceeds"):
            session.request("initialize", {})

        assert not session.is_running
    finally:
        # close() shuts down the per-session reader ThreadPoolExecutor. The failure
        # path leaves the process dead but the executor thread alive, so without this
        # these tests stack up reader threads for the rest of the run.
        session.close()


@pytest.mark.parametrize("mode", ["huge_header", "many_headers"])
def test_bounded_header_contract_terminates_server(mode: str, tmp_path: Path) -> None:
    session = _session(tmp_path, mode)
    session.start()
    try:
        with pytest.raises(LSPProtocolError, match="framing exceeded"):
            session.request("initialize", {})

        assert not session.is_running
    finally:
        # close() shuts down the per-session reader ThreadPoolExecutor. The failure
        # path leaves the process dead but the executor thread alive, so without this
        # these tests stack up reader threads for the rest of the run.
        session.close()


def test_posix_group_termination_escalates_after_grace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    signals: list[int] = []

    class _Process:
        pid = 123
        returncode = 0

        @staticmethod
        def poll() -> int:
            return 0

    monkeypatch.setattr(
        protocol_module.os,
        "killpg",
        lambda _pid, sent_signal: signals.append(sent_signal),
        raising=False,
    )
    monkeypatch.setattr(protocol_module.time, "sleep", lambda _seconds: None)

    protocol_module._terminate_lsp_posix_group(  # noqa: SLF001
        _Process(),  # type: ignore[arg-type]
        123,
        timeout_seconds=0.01,
    )

    assert signals == [
        protocol_module.signal.SIGTERM,
        getattr(protocol_module.signal, "SIGKILL", protocol_module.signal.SIGTERM),
    ]


@pytest.mark.parametrize("failure_stage", ["create", "assign", "verify"])
def test_windows_containment_degradation_identifies_failure_stage(  # noqa: C901
    failure_stage: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    class _Process:
        pid = 2468
        stdin = None
        stdout = None
        stderr = None
        returncode: int | None = None

        def poll(self) -> int | None:
            return self.returncode

        def terminate(self) -> None:
            self.returncode = -15

        def wait(self, timeout: float) -> int:
            return int(self.returncode or 0)

        def kill(self) -> None:
            self.returncode = -9

    class _JobObject:
        closed = False
        assigned = False

        def assign_pid(self, _pid: int) -> None:
            if failure_stage == "assign":
                raise OSError("assignment refused")
            self.assigned = True

        def contains_pid(self, _pid: int) -> bool:
            # A refused probe, not a failed assign: the server IS in the job.
            return failure_stage != "verify"

        def close(self) -> None:
            self.closed = True
            if self.assigned:
                # KILL_ON_JOB_CLOSE: closing the only handle kills the members.
                process.returncode = -1

    process = _Process()
    jobs: list[_JobObject] = []

    def create_job() -> _JobObject:
        if failure_stage == "create":
            raise OSError("Job Objects unavailable")
        job = _JobObject()
        jobs.append(job)
        return job

    monkeypatch.setattr(protocol_module.os, "name", "nt")
    monkeypatch.setattr(protocol_module.subprocess, "Popen", lambda *_args, **_kwargs: process)
    monkeypatch.setattr(protocol_module.subprocess, "run", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(protocol_module, "WindowsJobObject", create_job)
    session = LSPProcessSession(command=("language-server",), workspace_root=tmp_path)
    try:
        with caplog.at_level(logging.WARNING):
            session.start()

        records = [
            record
            for record in caplog.records
            if getattr(record, "event", "") == "sidecar.runtime.containment_degraded"
        ]
        assert session.is_running is True, (
            "a degraded containment must never kill the server it may contain"
        )
        assert [record.data["stage"] for record in records] == [failure_stage]
        assert records[0].data["task_key"] == "lsp"
        if failure_stage == "verify":
            # The assign took; only the probe was refused. The handle stays
            # open until stop, when a kill is the intent.
            assert session._job_object is jobs[0]  # noqa: SLF001
            assert jobs[0].closed is False
        else:
            assert session._job_object is None  # noqa: SLF001
            if jobs:
                assert jobs[0].closed is True
    finally:
        session.close()


def test_windows_lsp_teardown_tree_kills_before_closing_job(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[object] = []

    class _Process:
        pid = 9753
        stdin = None
        stdout = None
        polls = iter((None, 0))

        @classmethod
        def poll(cls) -> int | None:
            return next(cls.polls)

    class _JobObject:
        @staticmethod
        def close() -> None:
            events.append("close")

    def run(argv: list[str], **kwargs: object) -> None:
        events.append(("taskkill", argv, kwargs))

    monkeypatch.setattr(protocol_module.os, "name", "nt")
    monkeypatch.setattr(protocol_module.subprocess, "run", run)
    session = LSPProcessSession(command=("language-server",), workspace_root=tmp_path)
    session._process = _Process()  # type: ignore[assignment]  # noqa: SLF001
    session._job_object = _JobObject()  # type: ignore[assignment]  # noqa: SLF001
    try:
        session._stop_process()  # noqa: SLF001
    finally:
        session._reader.shutdown(wait=False, cancel_futures=True)  # noqa: SLF001

    assert events[0] == (
        "taskkill",
        ["taskkill", "/T", "/F", "/PID", "9753"],
        {
            "stdout": protocol_module.subprocess.DEVNULL,
            "stderr": protocol_module.subprocess.DEVNULL,
            "timeout": 5,
            "check": False,
        },
    )
    assert events[1] == "close"


def test_server_crash_reports_bounded_stderr_tail(tmp_path: Path) -> None:
    session = _session(tmp_path, "crash", stderr_tail_chars=80)
    session.start()
    try:
        with pytest.raises(LSPServerTerminated) as excinfo:
            session.request("initialize", {})

        assert not session.is_running
        assert len(excinfo.value.stderr_tail) <= 80
        assert "server crash detail" in excinfo.value.stderr_tail
    finally:
        # close() shuts down the per-session reader ThreadPoolExecutor; the crash
        # path kills the process but leaves that thread alive.
        session.close()


def test_zero_stderr_tail_limit_discards_decoded_chunks() -> None:
    tail = protocol_module._StderrTail(io.BytesIO(b"x" * 10_000), max_chars=0)  # noqa: SLF001

    tail._read_loop()  # noqa: SLF001

    assert tail._text == ""  # noqa: SLF001
    assert tail.tail() == ""
