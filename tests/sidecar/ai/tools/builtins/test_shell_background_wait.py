"""Waiting on background jobs: check_background_job wait_ms and the sleep-only
run_command that ends when a running background job settles."""

from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins import shell_background_wait
from sidecar.ai.tools.builtins.shell import check_background_job_tool, run_command_tool
from sidecar.ai.tools.builtins.shell_background import start_background_job, stop_background_job
from sidecar.ai.tools.builtins.shell_background_wait import sleep_only_seconds
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def _start(root: Path, seconds: float) -> str:
    return start_background_job(
        [sys.executable, "-c", f"import time; time.sleep({seconds})"],
        cwd=root,
        workspace_root=root,
        timeout_seconds=60,
    ).job_id


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        ("ping -n 151 127.0.0.1 >nul", 150.0),
        ("ping -n 3 localhost > nul 2>&1", 2.0),
        ("ping -c 5 127.0.0.1 >/dev/null", 4.0),
        ("timeout /t 30 /nobreak >nul", 30.0),
        ("sleep 20", 20.0),
        ("sleep 1.5s", 1.5),
        ("Start-Sleep -Seconds 12", 12.0),
        ('powershell -NoProfile -Command "Start-Sleep -s 7"', 7.0),
        ("pwsh -c Start-Sleep 4", 4.0),
    ],
)
def test_sleep_only_commands_are_recognised(command: str, expected: float) -> None:
    assert sleep_only_seconds(command) == expected


@pytest.mark.parametrize(
    "command",
    [
        "ping -n 3 example.com",
        "sleep 5 && make test",
        "sleep 5; echo done",
        "timeout 5 make",
        "ping -n 3 127.0.0.1 > out.txt",
        'powershell -Command "Start-Sleep 3; Remove-Item x"',
        "echo sleep 5",
    ],
)
def test_commands_that_do_more_than_sleep_are_not(command: str) -> None:
    assert sleep_only_seconds(command) is None


def test_wait_ms_returns_as_soon_as_the_job_finishes(tmp_path: Path) -> None:
    job_id = _start(tmp_path, 1.0)
    started = time.monotonic()

    result = check_background_job_tool(
        {"job_id": job_id, "wait_ms": 30_000}, WorkspaceGuard(str(tmp_path))
    )

    assert time.monotonic() - started < 15
    assert json.loads(result.output)["state"] == "completed"


def test_wait_ms_reports_running_when_the_wait_runs_out(tmp_path: Path) -> None:
    job_id = _start(tmp_path, 30.0)
    try:
        result = check_background_job_tool(
            {"job_id": job_id, "wait_ms": 300}, WorkspaceGuard(str(tmp_path))
        )
        assert json.loads(result.output)["state"] == "running"
    finally:
        stop_background_job(tmp_path, job_id)


@pytest.mark.parametrize("wait_ms", [-1, 600_001, "10", True])
def test_wait_ms_out_of_range_is_refused(tmp_path: Path, wait_ms: object) -> None:
    with pytest.raises(ToolExecutionFailure, match="wait_ms"):
        check_background_job_tool(
            {"job_id": "0123456789ab", "wait_ms": wait_ms}, WorkspaceGuard(str(tmp_path))
        )


def test_a_sleep_ends_when_the_running_background_job_settles(tmp_path: Path) -> None:
    job_id = _start(tmp_path, 1.0)
    started = time.monotonic()

    result = run_command_tool(
        {"command": "ping -n 121 127.0.0.1 >nul", "timeout_seconds": 180},
        WorkspaceGuard(str(tmp_path)),
    )

    payload = json.loads(result.output)
    assert time.monotonic() - started < 15
    assert result.success is True
    assert payload["ended_early"] is True
    assert payload["background_job"] == {"job_id": job_id, "state": "completed", "exit_code": 0}
    assert "check_background_job" in payload["message"]


def test_a_sleep_is_capped_by_its_timeout_and_names_the_running_job(tmp_path: Path) -> None:
    job_id = _start(tmp_path, 30.0)
    try:
        result = run_command_tool(
            {"command": "sleep 60", "timeout_seconds": 0.5}, WorkspaceGuard(str(tmp_path))
        )
        payload = json.loads(result.output)
        assert "ended_early" not in payload
        assert job_id in payload["message"] and "wait_ms" in payload["message"]
    finally:
        stop_background_job(tmp_path, job_id)


def test_a_sleep_without_a_running_job_runs_the_real_command(tmp_path: Path, monkeypatch) -> None:
    def fail(*_args, **_kwargs):
        raise AssertionError("no background job is running: the command must run for real")

    monkeypatch.setattr(shell_background_wait, "wait_for_settle", fail)
    result = run_command_tool({"command": "ping -n 1 127.0.0.1 >nul"}, WorkspaceGuard(str(tmp_path)))

    assert "ended_early" not in json.loads(result.output)


def test_a_cancelled_wait_returns_without_waiting_out_the_duration(tmp_path: Path) -> None:
    job_id = _start(tmp_path, 30.0)
    abort = threading.Event()
    threading.Timer(0.2, abort.set).start()
    started = time.monotonic()
    try:
        settled = shell_background_wait.wait_for_settle(
            tmp_path, [job_id], max_seconds=30, abort_event=abort
        )
        assert settled is None
        assert time.monotonic() - started < 5
    finally:
        stop_background_job(tmp_path, job_id)


def test_a_sleep_keeps_waiting_while_another_job_still_runs(tmp_path: Path) -> None:
    # The still-running job (a dev server booting, say) may be what the sleep is for.
    quick = _start(tmp_path, 0.5)
    slow = _start(tmp_path, 30.0)
    try:
        result = run_command_tool(
            {"command": "sleep 4", "timeout_seconds": 60}, WorkspaceGuard(str(tmp_path))
        )
        payload = json.loads(result.output)
        assert "ended_early" not in payload
        assert payload["slept_seconds"] >= 3.5
        assert slow in payload["message"] and quick not in payload["message"]
    finally:
        stop_background_job(tmp_path, slow)


# -- row 180: a person's message ends a background-job wait early ---------------------------------

_WAKE_MESSAGE = "The person sent a message. Job {job_id} is still running; you will be told when it finishes."


@pytest.fixture
def _tool_call():
    from sidecar.ai.tools.builtins import cancellation

    cancellation.end_tool_call()
    cancellation.begin_tool_call(77)
    yield lambda: cancellation.wake_request(77)
    cancellation.end_tool_call()


def test_wait_for_settle_returns_early_when_the_wake_event_is_set(tmp_path: Path) -> None:
    job_id = _start(tmp_path, 30.0)
    wake = threading.Event()
    threading.Timer(0.2, wake.set).start()
    started = time.monotonic()
    try:
        settled = shell_background_wait.wait_for_settle(
            tmp_path, [job_id], max_seconds=30, wake_event=wake
        )
        assert settled is None
        assert wake.is_set()
        assert time.monotonic() - started < 5
    finally:
        stop_background_job(tmp_path, job_id)


def test_a_settled_job_wins_over_a_wake_set_at_the_same_time(tmp_path: Path) -> None:
    job_id = _start(tmp_path, 0.1)
    time.sleep(1.5)
    wake = threading.Event()
    wake.set()

    settled = shell_background_wait.wait_for_settle(tmp_path, [job_id], max_seconds=30, wake_event=wake)

    assert settled is not None and settled[0] == job_id and settled[1]["state"] == "completed"


def test_check_background_job_reports_the_interruption_and_the_job_keeps_running(
    tmp_path: Path, _tool_call
) -> None:
    job_id = _start(tmp_path, 30.0)
    threading.Timer(0.2, _tool_call).start()
    started = time.monotonic()
    try:
        result = check_background_job_tool(
            {"job_id": job_id, "wait_ms": 60_000}, WorkspaceGuard(str(tmp_path))
        )
        payload = json.loads(result.output)

        assert time.monotonic() - started < 10
        assert result.success is True
        assert payload["state"] == "running"
        assert payload["interrupted_by_user_message"] is True
        assert payload["message"] == _WAKE_MESSAGE.format(job_id=job_id)
    finally:
        stop_background_job(tmp_path, job_id)


def test_a_wake_already_set_when_the_wait_starts_ends_it_at_once(tmp_path: Path, _tool_call) -> None:
    job_id = _start(tmp_path, 30.0)
    _tool_call()
    started = time.monotonic()
    try:
        result = check_background_job_tool(
            {"job_id": job_id, "wait_ms": 60_000}, WorkspaceGuard(str(tmp_path))
        )

        assert time.monotonic() - started < 5
        assert json.loads(result.output)["interrupted_by_user_message"] is True
    finally:
        stop_background_job(tmp_path, job_id)


def test_a_plain_timeout_is_not_reported_as_an_interruption(tmp_path: Path, _tool_call) -> None:
    job_id = _start(tmp_path, 30.0)
    try:
        payload = json.loads(
            check_background_job_tool(
                {"job_id": job_id, "wait_ms": 300}, WorkspaceGuard(str(tmp_path))
            ).output
        )

        assert payload["state"] == "running"
        assert "interrupted_by_user_message" not in payload and "message" not in payload
    finally:
        stop_background_job(tmp_path, job_id)


def test_a_sleep_ends_when_a_person_message_wakes_it(tmp_path: Path, _tool_call) -> None:
    job_id = _start(tmp_path, 30.0)
    threading.Timer(0.2, _tool_call).start()
    started = time.monotonic()
    try:
        result = run_command_tool(
            {"command": "sleep 60", "timeout_seconds": 120}, WorkspaceGuard(str(tmp_path))
        )
        payload = json.loads(result.output)

        assert time.monotonic() - started < 10
        assert result.success is True
        assert payload["interrupted_by_user_message"] is True
        assert payload["message"] == _WAKE_MESSAGE.format(job_id=job_id)
        assert "ended_early" not in payload
    finally:
        stop_background_job(tmp_path, job_id)


def test_pause_with_abort_and_wake_blocks_on_abort_instead_of_spinning(monkeypatch) -> None:
    """Row 180 review: an idle wait must not poll at a short interval; Stop stays immediate."""
    import threading

    from sidecar.ai.tools.builtins import shell_background_wait as wait_module

    def no_sleep(_seconds: float) -> None:
        raise AssertionError("the pause must block on the abort event, not sleep in a loop")

    monkeypatch.setattr(wait_module.time, "sleep", no_sleep)
    slices: list[float] = []

    class RecordingEvent(threading.Event):
        def wait(self, timeout: float | None = None) -> bool:
            slices.append(float(timeout or 0))
            return super().wait(0)

    abort, wake = RecordingEvent(), threading.Event()
    wait_module._pause(0.5, abort, wake)
    assert slices and all(s <= wait_module.WAKE_POLL_SECONDS for s in slices)
    assert wait_module.WAKE_POLL_SECONDS >= 0.25
    wake.set()
    slices.clear()
    wait_module._pause(10.0, abort, wake)
    assert slices == [], "a set wake ends the pause before any wait"
