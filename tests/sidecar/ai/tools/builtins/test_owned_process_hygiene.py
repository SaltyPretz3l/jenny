"""Focused regressions for owned-process hygiene findings."""

from __future__ import annotations

import io
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.tools.builtins import owned_process as owned_process_module
from sidecar.ai.tools.builtins.owned_process import (
    OwnedProcess,
    OwnedProcessService,
    OwnedProcessShutdownError,
)
from sidecar.runtime import external_child_env, owned_process_tracking


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


def test_posix_spawn_restores_frozen_library_path(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    captured_kwargs: dict[str, object] = {}

    class _PayloadCaptured(Exception):
        pass

    def _encode(*_args: object, **kwargs: object) -> bytes:
        captured_kwargs.update(kwargs)
        raise _PayloadCaptured

    service = OwnedProcessService()
    with monkeypatch.context() as spawn_patch:
        spawn_patch.setattr(owned_process_module, "os", SimpleNamespace(name="posix"))
        spawn_patch.setattr(
            external_child_env,
            "os",
            SimpleNamespace(name="posix", environ={}),
        )
        spawn_patch.setattr(external_child_env, "sys", SimpleNamespace(frozen=True))
        # The supervisor starts in the sidecar's own environment, so the
        # target's restored environment travels in the launch payload.
        spawn_patch.setattr(
            owned_process_module, "encode_windows_bootstrap_payload", _encode
        )
        with pytest.raises(_PayloadCaptured):
            service.spawn(
                ["fake"],
                cwd=tmp_path,
                env={
                    "KEEP": "yes",
                    "LD_LIBRARY_PATH": "/tmp/_MEI",
                    "LD_LIBRARY_PATH_ORIG": "/opt/lib",
                },
            )

    assert captured_kwargs["env"] == {
        "KEEP": "yes",
        "LD_LIBRARY_PATH": "/opt/lib",
    }
    assert service.snapshot().active == 0


def test_posix_spawn_shutdown_race_terminates_but_quarantines_without_tree_proof(
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
        with service._condition:  # force the registration race.
            service._shutting_down = True
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
    monkeypatch.setattr(service, "_start_transport", lambda _job: (_popen(), None))
    monkeypatch.setattr(service, "_preflight_posix_target", lambda *_args: None)

    with pytest.raises(OwnedProcessShutdownError):
        service.spawn(["fake"], cwd=tmp_path, allow_queue=False)

    assert group_signals == [
        (leader_pid, sigterm),
        (leader_pid, sigkill),
    ]
    assert group_members == set(), "the descendant must not survive the shutdown race"
    assert service.snapshot().active == 1


def test_popen_failure_publishes_no_child_proof_and_releases_capacity(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class _Job:
        closed = False

        def close(self) -> None:
            self.closed = True

    job = _Job()
    observed = []
    service = OwnedProcessService(max_active=1, max_queued=0)
    monkeypatch.setattr(owned_process_module, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(owned_process_module, "WindowsJobObject", lambda: job)
    monkeypatch.setattr(
        owned_process_module.subprocess,
        "Popen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("spawn failed")),
    )

    with pytest.raises(OSError, match="spawn failed"):
        service.spawn(["fake"], cwd=tmp_path, allow_queue=False, on_cleanup=observed.append)

    assert job.closed is True
    assert service.snapshot().active == 0
    assert len(observed) == 1
    assert observed[0].cleanup == "confirmed"
    assert observed[0].reason == "no_child_started"


@pytest.mark.parametrize("failure_phase", ["assign", "release"])
def test_post_launch_failure_quarantines_when_kill_cannot_be_proven(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    failure_phase: str,
) -> None:
    class _Job:
        def assign_pid(self, _pid: int) -> None:
            if failure_phase == "assign":
                raise OSError("assignment failed")

        @staticmethod
        def terminate_tree() -> bool:
            return False

        @staticmethod
        def assigned_process_ids() -> tuple[int, ...]:
            raise OSError("tree query failed")

        @staticmethod
        def close() -> None:
            return

    class _Process:
        pid = 42_000
        stdin = io.BytesIO()
        stdout = io.BytesIO()
        stderr = io.BytesIO()
        returncode = None

        @staticmethod
        def poll() -> None:
            return None

        @staticmethod
        def terminate() -> None:
            raise OSError("termination failed")

    process = _Process()
    observed = []
    service = OwnedProcessService(max_active=1, max_queued=0)
    monkeypatch.setattr(owned_process_module, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(owned_process_module, "WindowsJobObject", _Job)
    monkeypatch.setattr(owned_process_module.subprocess, "Popen", lambda *_a, **_kw: process)
    monkeypatch.setattr(service, "_kill_windows_process_tree", lambda _pid: None)
    if failure_phase == "release":
        monkeypatch.setattr(
            owned_process_module,
            "release_windows_bootstrap_target",
            lambda *_args: (_ for _ in ()).throw(OSError("release failed")),
        )

    with pytest.raises(OSError, match=f"{failure_phase}.*failed"):
        service.spawn(["fake"], cwd=tmp_path, allow_queue=False, on_cleanup=observed.append)

    assert service.snapshot().active == 1
    assert len(observed) == 1
    assert observed[0].cleanup == "uncertain"
    assert observed[0].process_tree_terminated is False
    assert service.retry_quarantined_cleanup()[0].cleanup == "uncertain"
    assert observed == [observed[0]], "uncertain cleanup notification is idempotent"


# --- review fixes 2026-10-19: spawn fault, abort, POSIX group, cancel -------


def test_ledger_failure_after_launch_terminates_the_bootstrap_child(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    service = OwnedProcessService(max_active=1, max_queued=0)
    started: list[subprocess.Popen[bytes]] = []
    original_start = service._start_transport
    observed = []

    def _recording_start(job_object: object) -> tuple[subprocess.Popen[bytes], int | None]:
        process, ready_fd = original_start(job_object)  # type: ignore[arg-type]
        started.append(process)
        return process, ready_fd

    def _ledger_down(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("owned-process ledger unavailable")

    monkeypatch.setattr(service, "_start_transport", _recording_start)
    monkeypatch.setattr(owned_process_tracking, "record", _ledger_down)

    with pytest.raises(RuntimeError, match="ledger unavailable"):
        service.spawn(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            cwd=tmp_path,
            allow_queue=False,
            on_cleanup=observed.append,
        )

    assert len(started) == 1
    assert started[0].poll() is not None, "the live bootstrap child must not be orphaned"
    assert observed and observed[-1].reason != "no_child_started"
    assert observed[-1].cleanup == "confirmed"
    assert service.snapshot().active == 0


def test_run_aborted_before_start_never_spawns(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    service = OwnedProcessService()
    monkeypatch.setattr(
        service,
        "_start_transport",
        lambda _job: pytest.fail("a cancelled call must not start a child"),
    )
    abort_event = threading.Event()
    abort_event.set()

    result = service.run(["fake"], cwd=tmp_path, timeout_seconds=5, abort_event=abort_event)

    assert result.aborted is True
    assert result.cleanup_verdict.cleanup == "confirmed"
    assert result.cleanup_verdict.reason == "no_child_started"
    assert service.snapshot().active == 0


def test_run_aborted_while_queued_returns_early_without_spawning(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    service = OwnedProcessService(max_active=1, max_queued=1)
    monkeypatch.setattr(service, "_preflight_posix_target", lambda *_args: None)
    monkeypatch.setattr(
        service,
        "_start_transport",
        lambda _job: pytest.fail("a call cancelled in the queue must not start a child"),
    )
    held = service._acquire_capacity(allow_queue=False, timeout_seconds=0)
    abort_event = threading.Event()
    results: list[object] = []

    worker = threading.Thread(
        target=lambda: results.append(
            service.run(["fake"], cwd=tmp_path, timeout_seconds=30, abort_event=abort_event)
        )
    )
    started_at = time.monotonic()
    worker.start()
    deadline = time.monotonic() + 2
    while service.snapshot().queued == 0 and time.monotonic() < deadline:
        time.sleep(0.01)
    abort_event.set()
    worker.join(timeout=2)
    held.release()

    assert not worker.is_alive()
    assert time.monotonic() - started_at < 2, "the queue wait must notice the abort"
    assert len(results) == 1
    assert results[0].aborted is True  # type: ignore[attr-defined]
    assert service.snapshot().queued == 0
    assert service.snapshot().active == 0


@pytest.mark.parametrize(
    ("probe_error", "expected_signals"),
    [
        (ProcessLookupError(), []),  # group empty: its id may be reused
        (PermissionError(), []),  # group id now belongs to another user
        (None, ["TERM", "KILL"]),  # survivors keep the group id reserved
    ],
)
def test_exited_group_sweep_signals_only_a_populated_group(
    monkeypatch: pytest.MonkeyPatch,
    probe_error: BaseException | None,
    expected_signals: list[str],
) -> None:
    sent: list[str] = []

    def _killpg(process_group_id: int, sent_signal: object) -> None:
        assert process_group_id == 4242
        if sent_signal == 0:
            if probe_error is not None:
                raise probe_error
            return
        sent.append(str(sent_signal))

    monkeypatch.setattr(owned_process_module, "os", SimpleNamespace(name="posix", killpg=_killpg))
    monkeypatch.setattr(
        owned_process_module, "signal", SimpleNamespace(SIGTERM="TERM", SIGKILL="KILL")
    )

    OwnedProcessService._terminate_exited_process_group(4242)

    assert sent == expected_signals


def _fake_owned(service: OwnedProcessService, process: object, **overrides: object) -> OwnedProcess:
    from sidecar.ai.tools.builtins.owned_process import _CapacityLease

    with service._condition:
        service._active_count += 1
    fields: dict[str, object] = {
        "process": process,
        "args": ("fake",),
        "containment": "test",
        "process_group_id": None,
        "job_object": None,
        "_service": service,
        "_lease": _CapacityLease(service),
    }
    fields.update(overrides)
    return OwnedProcess(**fields)  # type: ignore[arg-type]


def test_terminate_never_signals_the_group_of_a_reaped_posix_root(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    group_calls: list[tuple[int, object]] = []
    monkeypatch.setattr(
        owned_process_module,
        "os",
        SimpleNamespace(name="posix", killpg=lambda *args: group_calls.append(args)),
    )
    service = OwnedProcessService()
    process = SimpleNamespace(pid=4242, poll=lambda: 0, stdin=None, stdout=None, stderr=None)
    owned = _fake_owned(service, process, process_group_id=4242)

    service.terminate(owned)

    assert group_calls == []


def test_cancel_skips_the_second_terminate_once_the_root_exited(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = OwnedProcessService()
    state = {"returncode": None}
    process = SimpleNamespace(
        pid=4242,
        poll=lambda: state["returncode"],
        stdin=None,
        stdout=io.BytesIO(),
        stderr=io.BytesIO(),
    )
    owned = _fake_owned(service, process)
    terminations: list[int] = []

    def _terminate(target: object, *, timeout_seconds: float = 0.5) -> None:
        del timeout_seconds
        terminations.append(id(target))
        state["returncode"] = -9

    monkeypatch.setattr(service, "terminate", _terminate)

    verdict = service.cancel(owned)

    assert terminations == [id(owned)], "one tree kill is enough once the root is gone"
    assert verdict.cleanup == "confirmed"
    assert service.snapshot().active == 0
