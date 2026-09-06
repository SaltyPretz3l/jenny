"""Focused regressions for owned-process hygiene findings."""

from __future__ import annotations

import subprocess
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.tools.builtins import owned_process as owned_process_module
from sidecar.ai.tools.builtins.owned_process import (
    OwnedProcessService,
    OwnedProcessShutdownError,
)


@pytest.mark.parametrize("failing_stream", ["stdout", "stderr"])
def test_pipe_read_error_marks_output_incomplete_and_reports_type(
    failing_stream: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    service = OwnedProcessService()
    diagnostic_data: list[dict[str, object]] = []

    def _reader(
        _pipe: object,
        capture: object,
        stream_name: str,
        *,
        on_chunk: object = None,
    ) -> threading.Thread:
        del on_chunk

        def _read() -> None:
            if stream_name == failing_stream:
                capture.append(b"partial")
                capture.read_error = "OSError"

        thread = threading.Thread(target=_read)
        thread.start()
        return thread

    def _log_event(*_args: object, **kwargs: object) -> None:
        data = kwargs.get("data")
        if isinstance(data, dict):
            diagnostic_data.append(data)

    monkeypatch.setattr(service, "_start_reader", _reader)
    monkeypatch.setattr(owned_process_module, "log_event", _log_event)

    result = service.run(
        [sys.executable, "-c", "pass"],
        cwd=tmp_path,
        timeout_seconds=5,
    )

    assert result.drain_incomplete is True
    assert diagnostic_data[-1]["read_error_types"] == {failing_stream: "OSError"}


def test_posix_spawn_shutdown_race_terminates_unregistered_process_group(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    service = OwnedProcessService(max_active=1, max_queued=0)
    leader_pid = 42_000
    descendant_pid = 42_001
    group_members = {leader_pid, descendant_pid}
    group_signals: list[tuple[int, object]] = []
    sigterm = object()
    sigkill = object()

    class _Process:
        pid = leader_pid
        stdin = None
        stdout = None
        stderr = None
        returncode: int | None = None

        def poll(self) -> int | None:
            return None if leader_pid in group_members else self.returncode

        def kill(self) -> None:
            group_members.discard(leader_pid)
            self.returncode = -9

        def wait(self, timeout: float | None = None) -> int:
            if leader_pid in group_members:
                raise subprocess.TimeoutExpired(["fake"], timeout)
            return int(self.returncode or -9)

    process = _Process()

    def _popen(*_args: object, **_kwargs: object) -> _Process:
        with service._condition:  # noqa: SLF001 - force the registration race.
            service._shutting_down = True  # noqa: SLF001
        return process

    def _killpg(process_group_id: int, sent_signal: object) -> None:
        if not group_members:
            raise ProcessLookupError
        group_signals.append((process_group_id, sent_signal))
        if sent_signal == getattr(owned_process_module.signal, "SIGKILL", None):
            group_members.clear()
            process.returncode = -9

    monkeypatch.setattr(
        owned_process_module,
        "os",
        SimpleNamespace(name="posix", killpg=_killpg),
    )
    monkeypatch.setattr(
        owned_process_module,
        "signal",
        SimpleNamespace(SIGTERM=sigterm, SIGKILL=sigkill),
    )
    monkeypatch.setattr(owned_process_module.subprocess, "Popen", _popen)

    with pytest.raises(OwnedProcessShutdownError):
        service.spawn(["fake"], cwd=tmp_path, allow_queue=False)

    assert group_signals == [
        (leader_pid, sigterm),
        (leader_pid, sigkill),
    ]
    assert group_members == set(), "the descendant must not survive the shutdown race"
    assert service.snapshot().active == 0
