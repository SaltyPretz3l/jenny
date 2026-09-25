"""Focused lifecycle contracts for the public background-job stop tool."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.error_codes import CMP_TOOL_BACKGROUND_NOT_FOUND
from sidecar.ai.tools.builtins import owned_process as owned_process_module
from sidecar.ai.tools.builtins import shell_background as shell_background_module
from sidecar.ai.tools.builtins.owned_process_settlement import OwnedProcessCleanupVerdict
from sidecar.ai.tools.builtins.shell import stop_background_job_tool
from sidecar.ai.tools.builtins.shell_background import read_background_job, start_background_job
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.process_containment import process_exists


def _guard(root: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(root))


def _start_sleeper(root: Path) -> str:
    return start_background_job(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        cwd=root,
        workspace_root=root,
        timeout_seconds=30,
    ).job_id


def _start_parent_with_child(root: Path) -> tuple[str, Path]:
    """Start a background parent that spawns a child, and return the child pid file.

    The child used to sleep 2s and then write a "survived" marker, with the test
    sleeping 2.5s and asserting the marker was absent. That raced: if the stop took
    longer than the child's 2s the marker appeared and the test failed for a reason
    that was not the contract. Lengthening the child's sleep fixes the race but makes
    the marker vacuous -- it could not appear either way -- so assert on the child
    process itself instead.
    """
    pid_file = root / "stopped-child-pid.txt"
    spawned_marker = root / "stopped-child-spawned.txt"
    child = root / "stopped_child.py"
    parent = root / "stopped_parent.py"
    child.write_text(
        "import os, pathlib, sys, time\n"
        "pathlib.Path(sys.argv[1]).write_text(str(os.getpid()), encoding='utf-8')\n"
        "time.sleep(30.0)\n",
        encoding="utf-8",
    )
    parent.write_text(
        "import pathlib, subprocess, sys, time\n"
        "subprocess.Popen([sys.executable, sys.argv[1], sys.argv[2]])\n"
        "pathlib.Path(sys.argv[3]).write_text('spawned', encoding='utf-8')\n"
        "time.sleep(30)\n",
        encoding="utf-8",
    )
    job_id, _pid = start_background_job(
        [sys.executable, str(parent), str(child), str(pid_file), str(spawned_marker)],
        cwd=root,
        workspace_root=root,
        timeout_seconds=30,
    )
    deadline = time.monotonic() + 5.0
    while not (spawned_marker.exists() and pid_file.exists()) and time.monotonic() < deadline:
        time.sleep(0.02)
    assert spawned_marker.exists(), "background parent did not spawn its child"
    assert pid_file.exists(), "spawned child never recorded its pid"
    return job_id, pid_file


def test_stop_background_job_terminates_owned_tree_and_is_idempotent(tmp_path: Path) -> None:
    job_id, pid_file = _start_parent_with_child(tmp_path)
    child_pid = int(pid_file.read_text(encoding="utf-8").strip())
    # Positive control: the child must be running BEFORE the stop, or the
    # "it is gone" assertion below would pass on a pid that never ran at all.
    assert process_exists(child_pid), "the spawned child was not running before the stop"

    stopped = stop_background_job_tool({"job_id": job_id}, _guard(tmp_path))
    stopped_body = json.loads(stopped.output)

    assert stopped.success is True
    assert stopped_body["job_id"] == job_id
    assert stopped_body["state"] == "failed"
    assert stopped_body["error"] == "background job was cancelled"
    assert stopped_body["stop_requested"] is True
    # The contract is that stopping the job kills the whole owned tree, so assert
    # the CHILD process is gone. Polling for that is both deterministic and fast --
    # no fixed sleep that has to outlast whatever the child was doing.
    deadline = time.monotonic() + 10.0
    while process_exists(child_pid) and time.monotonic() < deadline:
        time.sleep(0.02)
    assert not process_exists(child_pid), (
        f"child {child_pid} survived stop_background_job; the owned tree was not killed"
    )

    repeated = stop_background_job_tool({"job_id": job_id}, _guard(tmp_path))
    repeated_body = json.loads(repeated.output)

    assert repeated.success is True
    assert repeated_body["state"] == "failed"
    assert repeated_body["stop_requested"] is False


def test_stop_background_job_cannot_cross_workspace_ownership(tmp_path: Path) -> None:
    owner_root = tmp_path / "owner"
    other_root = tmp_path / "other"
    owner_root.mkdir()
    other_root.mkdir()
    job_id = _start_sleeper(owner_root)

    try:
        with pytest.raises(ToolExecutionFailure) as error:
            stop_background_job_tool({"job_id": job_id}, _guard(other_root))
        assert error.value.code == CMP_TOOL_BACKGROUND_NOT_FOUND
        assert read_background_job(owner_root, job_id)["state"] == "running"
    finally:
        stop_background_job_tool({"job_id": job_id}, _guard(owner_root))


def test_background_start_does_not_observe_cleanup_until_stop(tmp_path: Path) -> None:
    observed = []
    started = start_background_job(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        cwd=tmp_path,
        workspace_root=tmp_path,
        timeout_seconds=30,
        on_cleanup=observed.append,
    )

    assert observed == []
    stop_background_job_tool({"job_id": started.job_id}, _guard(tmp_path))

    assert [verdict.cleanup for verdict in observed] == ["confirmed"]


def test_background_wait_result_cannot_downgrade_observer_confirmation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    uncertain = OwnedProcessCleanupVerdict(
        cleanup="uncertain",
        process_tree_terminated=True,
        output_readers_terminated=False,
        reason="output_reader_termination_unconfirmed",
    )
    confirmed = OwnedProcessCleanupVerdict(
        cleanup="confirmed",
        process_tree_terminated=True,
        output_readers_terminated=True,
    )
    job = shell_background_module.ManagedBackgroundProcess(
        process=SimpleNamespace(),  # type: ignore[arg-type]
        owned_process=SimpleNamespace(),  # type: ignore[arg-type]
    )

    class _Service:
        @staticmethod
        def wait(*_args: object, **_kwargs: object) -> SimpleNamespace:
            job.observe_cleanup(confirmed)
            return SimpleNamespace(
                cleanup_verdict=uncertain,
                stdout="done",
                stderr="",
            )

    # shell_background resolves the service through the owned_process module at call time.
    monkeypatch.setattr(owned_process_module, "get_owned_process_service", _Service)

    assert shell_background_module._wait_for_background_exit(job, 1) == (  # noqa: SLF001
        "done",
        "",
    )
    assert job.cleanup_verdict == confirmed


@pytest.mark.parametrize("cleanup", ["uncertain", "confirmed"])
def test_background_settled_event_requires_owner_cleanup_proof(
    monkeypatch: pytest.MonkeyPatch,
    cleanup: str,
) -> None:
    verdict = OwnedProcessCleanupVerdict(
        cleanup=cleanup,  # type: ignore[arg-type]
        process_tree_terminated=cleanup == "confirmed",
        output_readers_terminated=cleanup == "confirmed",
        reason=None if cleanup == "confirmed" else "cleanup_unconfirmed",
    )
    job = shell_background_module.ManagedBackgroundProcess(
        process=SimpleNamespace(),  # type: ignore[arg-type]
    )
    outcome = shell_background_module._BackgroundTerminalOutcome(  # noqa: SLF001
        state="failed",
        exit_code=-1,
        stdout="",
        stderr="",
        cleanup_verdict=verdict,
    )
    monkeypatch.setattr(
        shell_background_module,
        "_capture_background_terminal",
        lambda *_args, **_kwargs: outcome,
    )
    monkeypatch.setattr(
        shell_background_module,
        "_build_terminal_status",
        lambda **_kwargs: {"state": "failed"},
    )
    monkeypatch.setattr(shell_background_module, "_publish_terminal_status", lambda *_a: None)
    monkeypatch.setattr(shell_background_module, "_remove_active_job", lambda _job_id: None)

    job.observe_cleanup(verdict)
    assert job.settled.is_set() is False

    shell_background_module._settle_background_job(  # noqa: SLF001
        job_id="0123456789ab",
        job=job,
        store=SimpleNamespace(),  # type: ignore[arg-type]
        job_ref=SimpleNamespace(),  # type: ignore[arg-type]
        timeout_seconds=1,
    )

    assert job.cleanup_verdict == verdict
    assert job.settled.is_set() is (cleanup == "confirmed")
    if cleanup == "uncertain":
        job.observe_cleanup(
            OwnedProcessCleanupVerdict(
                cleanup="confirmed",
                process_tree_terminated=True,
                output_readers_terminated=True,
            )
        )
        assert job.settled.is_set() is True
