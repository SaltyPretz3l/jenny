from __future__ import annotations

import io
import threading
from types import SimpleNamespace
from typing import Any

from sidecar.ai.tools.builtins.contained_process_helper import run_workspace_test_helper
from sidecar.protocol import API_VERSION, CONTENT_LENGTH_HEADER
from sidecar.runtime.framing import read_framed_message, write_framed_message


class _Verdict:
    def metadata(self) -> dict[str, Any]:
        return {
            "cleanup": "confirmed",
            "process_tree_terminated": True,
            "output_readers_terminated": True,
            "reason": None,
        }


def _frame(message: dict[str, Any]) -> bytes:
    stream = io.BytesIO()
    write_framed_message(
        stdout_buffer=stream,
        content_length_header=CONTENT_LENGTH_HEADER,
        message=message,
    )
    return stream.getvalue()


def _run_request() -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "api_version": API_VERSION,
        "id": "operation-1",
        "method": "workspace_test.run",
        "params": {
            "accept_version": API_VERSION,
            "operation_id": "operation-1",
            "command": "echo ok",
            "cwd": "/workspace",
            "user_env": {"EXPLICIT": "1"},
            "timeout_ms": 1000,
            "output_limit": 12000,
        },
    }


def _close_request() -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "api_version": API_VERSION,
        "method": "workspace_test.close",
        "params": {"operation_id": "operation-1"},
    }


def _result(*, aborted: bool = False) -> SimpleNamespace:
    return SimpleNamespace(
        aborted=aborted,
        timed_out=False,
        returncode=-1 if aborted else 0,
        duration_seconds=0.01,
        stdout="ok\n",
        stderr="",
        cleanup_verdict=_Verdict(),
    )


def test_helper_runs_one_bounded_shell_request_without_runtime_initialization() -> None:
    observed: dict[str, Any] = {}

    class Service:
        def __init__(self, **kwargs: Any) -> None:
            observed["limits"] = kwargs

        def run(self, argv: list[str], **kwargs: Any) -> SimpleNamespace:
            observed["argv"] = argv
            observed["run"] = kwargs
            return _result()

    output = io.BytesIO()
    assert run_workspace_test_helper(
        io.BytesIO(_frame(_run_request()) + _frame(_close_request())),
        output, service_factory=Service,
        platform_name="nt",
    ) == 0
    output.seek(0)
    response = read_framed_message(
        stdin_buffer=output,
        content_length_header=CONTENT_LENGTH_HEADER,
        max_content_length_bytes=1024 * 1024,
    )
    assert response["id"] == "operation-1"
    assert response["result"]["status"] == "passed"
    assert response["result"]["cleanup"]["cleanup"] == "confirmed"
    assert observed["run"]["env"]["EXPLICIT"] == "1"
    assert observed["limits"]["max_capture_bytes"] == 24000


def test_helper_cancel_notification_reaches_the_owned_process_abort_event() -> None:
    cancel = {
        "jsonrpc": "2.0",
        "api_version": API_VERSION,
        "method": "workspace_test.cancel",
        "params": {"operation_id": "operation-1"},
    }

    class Service:
        def __init__(self, **_kwargs: Any) -> None:
            pass

        def run(self, _argv: list[str], **kwargs: Any) -> SimpleNamespace:
            event: threading.Event = kwargs["abort_event"]
            assert event.wait(timeout=1)
            return _result(aborted=True)

    output = io.BytesIO()
    source = io.BytesIO(_frame(_run_request()) + _frame(cancel) + _frame(_close_request()))
    assert run_workspace_test_helper(
        source, output, service_factory=Service, platform_name="nt"
    ) == 0
    output.seek(0)
    response = read_framed_message(
        stdin_buffer=output,
        content_length_header=CONTENT_LENGTH_HEADER,
        max_content_length_bytes=1024 * 1024,
    )
    assert response["result"]["status"] == "aborted"


def test_helper_refuses_non_windows_hosts_before_reading_a_command() -> None:
    assert run_workspace_test_helper(io.BytesIO(), io.BytesIO(), platform_name="posix") == 5


def test_helper_control_eof_cancels_the_owned_process_before_failing_closed() -> None:
    observed_abort = threading.Event()

    class Service:
        def __init__(self, **_kwargs: Any) -> None:
            pass

        def run(self, _argv: list[str], **kwargs: Any) -> SimpleNamespace:
            abort_event: threading.Event = kwargs["abort_event"]
            assert abort_event.wait(timeout=1)
            observed_abort.set()
            return _result(aborted=True)

    assert run_workspace_test_helper(
        io.BytesIO(_frame(_run_request())),
        io.BytesIO(),
        service_factory=Service,
        platform_name="nt",
    ) == 4
    assert observed_abort.is_set()
