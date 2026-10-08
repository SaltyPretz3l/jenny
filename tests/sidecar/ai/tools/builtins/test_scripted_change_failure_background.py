"""Row 34 S2: raised failures and background jobs keep their change evidence.

A handler that raises gets the same fail-soft review as one that returns,
attached to the error as ``result_metadata``. A background ``run_command``
stores a status-and-fingerprint snapshot at start; the first check or stop
that sees the job ended reports a ``background_window`` review once.
"""

from __future__ import annotations

import json
import logging
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.error_codes import CMP_TOOL_COMMAND_ABORTED, CMP_TOOL_PYTHON_EXECUTION_FAILED
from sidecar.ai.tools.builtins import shell_background, shell_background_changes
from sidecar.ai.tools.builtins import worktree_change_tracking as tracking
from sidecar.ai.tools.builtins.shell import check_background_job_tool, stop_background_job_tool
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard

_LOGGER = logging.getLogger(__name__)
_MARKER = "BODY_MARKER_S2"


@pytest.fixture(autouse=True)
def _reset() -> None:
    tracking._reset_worktree_tracking_for_tests()
    shell_background_changes._reset_change_windows_for_tests()


def _repo(tmp_path: Path) -> tuple[Path, WorkspaceGuard]:
    repo = tmp_path / "repo"
    repo.mkdir()
    for command in (
        ["git", "init", "-q"],
        ["git", "config", "user.email", "test@example.com"],
        ["git", "config", "user.name", "Test"],
    ):
        subprocess.run(command, cwd=repo, check=True)
    (repo / "tracked.py").write_text("value = 1\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=repo, check=True)
    return repo, WorkspaceGuard(str(tmp_path))


def _observe(
    guard: WorkspaceGuard, tool_name: str, handler: Any, **arguments: object
) -> Any:
    return shell_background_changes.run_with_change_observation(
        side_effecting=True,
        tool_name=tool_name,
        arguments={"cwd": "repo", **arguments},
        workspace=guard,
        handler=handler,
        logger=_LOGGER,
    )


def _raised(guard: WorkspaceGuard, tool_name: str, handler: Any) -> ToolExecutionFailure:
    with pytest.raises(ToolExecutionFailure) as caught:
        _observe(guard, tool_name, handler)
    return caught.value


# -- raised failures -------------------------------------------------------


def test_a_raised_failure_carries_the_review_and_diff(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    def _write_then_raise() -> None:
        (repo / "tracked.py").write_text(f"value = 2  # {_MARKER}\n", encoding="utf-8")
        raise ToolExecutionFailure(
            code=CMP_TOOL_PYTHON_EXECUTION_FAILED, message="python execution failed"
        )

    error = _raised(guard, "python_execute", _write_then_raise)

    evidence = error.result_metadata
    assert set(evidence) == {"diffs", "scripted_change_review"}
    review = evidence["scripted_change_review"]
    assert review["call_outcome"] == "failed"
    assert review["certainty"] == "observed_during_call"
    assert [diff["path"] for diff in evidence["diffs"]] == ["tracked.py"]
    assert error.message.startswith("python execution failed\n")
    assert "outside edit_file/write_file: tracked.py" in error.message
    assert _MARKER not in error.message
    assert "result_metadata" not in error.to_error_data()
    assert "diffs" not in error.to_error_data()


def test_a_cancelled_call_is_labelled_cancelled(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    def _write_then_abort() -> None:
        (repo / "made.txt").write_text("partial\n", encoding="utf-8")
        raise ToolExecutionFailure(code=CMP_TOOL_COMMAND_ABORTED, message="command aborted")

    error = _raised(guard, "run_command", _write_then_abort)

    assert error.result_metadata["scripted_change_review"]["call_outcome"] == "cancelled"
    assert error.message == "command aborted"


def test_a_python_timeout_is_labelled_timed_out(tmp_path: Path) -> None:
    _repo(tmp_path)
    guard = WorkspaceGuard(str(tmp_path))

    def _time_out() -> None:
        try:
            raise subprocess.TimeoutExpired("python", 1)
        except subprocess.TimeoutExpired as cause:
            raise ToolExecutionFailure(
                code=CMP_TOOL_PYTHON_EXECUTION_FAILED, message="timed out"
            ) from cause

    error = _raised(guard, "python_execute", _time_out)

    review = error.result_metadata["scripted_change_review"]
    assert review["call_outcome"] == "timed_out"
    assert review["changed_path_count"] == 0
    assert "diffs" not in error.result_metadata


def test_a_non_git_failure_stays_unsupported(tmp_path: Path) -> None:
    (tmp_path / "repo").mkdir()
    guard = WorkspaceGuard(str(tmp_path))

    def _fail() -> None:
        raise ToolExecutionFailure(code=CMP_TOOL_PYTHON_EXECUTION_FAILED, message="failed")

    error = _raised(guard, "run_temp_script", _fail)

    review = error.result_metadata["scripted_change_review"]
    assert (review["state"], review["reason"], review["call_outcome"]) == (
        "unsupported", "not_git", "failed"
    )


def test_a_non_scripted_tool_failure_carries_nothing(tmp_path: Path) -> None:
    _repo(tmp_path)
    guard = WorkspaceGuard(str(tmp_path))

    def _fail() -> None:
        raise ToolExecutionFailure(code=CMP_TOOL_PYTHON_EXECUTION_FAILED, message="failed")

    error = _raised(guard, "write_file", _fail)

    assert error.result_metadata == {}


# -- background reconciliation ---------------------------------------------


def _start_job(
    guard: WorkspaceGuard, repo: Path, code: str, *, timeout_seconds: float = 30
) -> tuple[str, ToolHandlerResult]:
    def _start() -> ToolHandlerResult:
        started = shell_background.start_background_job(
            [sys.executable, "-c", code],
            cwd=repo,
            workspace_root=guard.require_root(),
            timeout_seconds=timeout_seconds,
        )
        return ToolHandlerResult(
            output=json.dumps({"job_id": started.job_id, "status": "started"}),
            metadata={"background_job_id": started.job_id, "background_job_pid": started.pid},
        )

    result = _observe(guard, "run_command", _start, run_in_background=True)
    return str(result.metadata["background_job_id"]), result


def _check(guard: WorkspaceGuard, job_id: str) -> ToolHandlerResult:
    arguments = {"job_id": job_id}
    return _observe(
        guard, "check_background_job", lambda: check_background_job_tool(arguments, guard),
        job_id=job_id,
    )


def _poll_until_terminal(guard: WorkspaceGuard, job_id: str) -> list[ToolHandlerResult]:
    checks: list[ToolHandlerResult] = []
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        checks.append(_check(guard, job_id))
        if json.loads(checks[-1].output)["state"] != "running":
            return checks
        time.sleep(0.05)
    raise AssertionError("background job did not finish")


def test_a_background_edit_is_reported_once_on_the_first_terminal_check(
    tmp_path: Path,
) -> None:
    repo, guard = _repo(tmp_path)

    job_id, start = _start_job(
        guard, repo, "open('made.py', 'w').write('made = 1\\n')"
    )

    start_review = start.metadata["scripted_change_review"]
    assert (start_review["state"], start_review["reason"]) == ("unavailable", "background")
    checks = _poll_until_terminal(guard, job_id)
    later = _check(guard, job_id)
    reviews = [
        check.metadata["scripted_change_review"]
        for check in (*checks, later)
        if "scripted_change_review" in check.metadata
    ]
    assert len(reviews) == 1
    assert "scripted_change_review" in checks[-1].metadata
    review = reviews[0]
    assert review["certainty"] == "background_window"
    assert review["call_outcome"] == "succeeded"
    assert review["changed_paths"] == ["made.py"]
    diffs = checks[-1].metadata["diffs"]
    assert [(diff["path"], diff["status"], diff["body_kind"]) for diff in diffs] == [
        ("made.py", "created", "summary_only")
    ]
    assert all(diff["hunks"] == [] for diff in diffs)
    assert "made = 1" not in json.dumps(checks[-1].metadata)
    assert "workspace_changed" not in checks[-1].metadata


def test_a_stopped_background_job_is_reconciled_by_the_stop(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)
    job_id, _start = _start_job(
        guard,
        repo,
        "import pathlib, time\n"
        "pathlib.Path('tracked.py').write_text('value = 3\\n')\n"
        "time.sleep(30)\n",
    )
    deadline = time.monotonic() + 20
    while (repo / "tracked.py").read_text(encoding="utf-8") != "value = 3\n":
        assert time.monotonic() < deadline
        time.sleep(0.05)
    running = _check(guard, job_id)
    assert "scripted_change_review" not in running.metadata

    arguments = {"job_id": job_id}
    stopped = _observe(
        guard, "stop_background_job", lambda: stop_background_job_tool(arguments, guard),
        job_id=job_id,
    )
    after = _check(guard, job_id)

    review = stopped.metadata["scripted_change_review"]
    assert review["certainty"] == "background_window"
    assert review["call_outcome"] == "cancelled"
    assert review["changed_paths"] == ["tracked.py"]
    assert stopped.metadata["diffs"][0]["status"] == "modified"
    assert "scripted_change_review" not in after.metadata


def test_a_background_snapshot_over_the_cap_reports_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, guard = _repo(tmp_path)
    (repo / "dirty.txt").write_text("x\n", encoding="utf-8")
    monkeypatch.setattr(tracking, "MAX_STATUS_PATHS", 0)

    job_id, _start = _start_job(guard, repo, "open('made.py', 'w').write('x')")
    checks = _poll_until_terminal(guard, job_id)

    review = checks[-1].metadata["scripted_change_review"]
    assert (review["state"], review["reason"]) == ("unavailable", "status_over_limit")
    assert review["certainty"] == "background_window"
    assert "diffs" not in checks[-1].metadata


def test_the_builtin_server_reconciles_a_real_background_command(tmp_path: Path) -> None:
    from sidecar.ai.mcp import builtin_server

    for command in (
        ["git", "init", "-q"],
        ["git", "config", "user.email", "test@example.com"],
        ["git", "config", "user.name", "Test"],
    ):
        subprocess.run(command, cwd=tmp_path, check=True)
    (tmp_path / "writer.py").write_text(
        "open('made.py', 'w').write('made = 1')\n", encoding="utf-8"
    )
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=tmp_path, check=True)
    workspace = WorkspaceGuard(str(tmp_path))
    tools = builtin_server._default_tools({"tools_shell_enabled": True})

    def _call(name: str, arguments: dict[str, object]) -> dict[str, Any]:
        response = builtin_server._handle_tools_call(
            name, tools, workspace, {"name": name, "arguments": arguments}
        )
        return dict(response["result"])

    started = _call(
        "run_command",
        {"command": f'"{sys.executable}" writer.py', "run_in_background": True},
    )
    job_id = started["metadata"]["background_job_id"]
    deadline = time.monotonic() + 20
    while True:
        checked = _call("check_background_job", {"job_id": job_id})
        if json.loads(checked["content"][0]["text"])["state"] != "running":
            break
        assert time.monotonic() < deadline
        time.sleep(0.05)
    again = _call("check_background_job", {"job_id": job_id})

    review = checked["metadata"]["scripted_change_review"]
    assert review["certainty"] == "background_window"
    assert review["changed_paths"] == ["made.py"]
    assert "scripted_change_review" not in again.get("metadata", {})


# -- restore point (row 34 S5 step 4) ----------------------------------------

_START_POINT = {
    "kind": "git_checkpoint",
    "ref": "refs/jenny/checkpoints/sess-1/4",
    "created_at": "2026-10-05T12:00:00.000Z",
}
_LATER_POINT = {"kind": "head", "created_at": "2026-10-05T13:00:00.000Z"}


def test_a_raised_failure_review_carries_the_restore_point(tmp_path: Path) -> None:
    repo, guard = _repo(tmp_path)

    def _write_then_raise() -> None:
        (repo / "tracked.py").write_text("value = 5\n", encoding="utf-8")
        raise ToolExecutionFailure(
            code=CMP_TOOL_PYTHON_EXECUTION_FAILED, message="python execution failed"
        )

    with pytest.raises(ToolExecutionFailure) as caught:
        _observe(
            guard, "python_execute", _write_then_raise, _jenny_restore_point=dict(_START_POINT)
        )

    error = caught.value
    assert error.result_metadata["scripted_change_review"]["restore_point"] == _START_POINT
    assert _START_POINT["ref"] not in error.message
    assert "restore_point" not in json.dumps(error.to_error_data())


def test_a_background_finish_carries_the_restore_point_of_the_starting_run(
    tmp_path: Path,
) -> None:
    repo, guard = _repo(tmp_path)

    def _start() -> ToolHandlerResult:
        started = shell_background.start_background_job(
            [sys.executable, "-c", "open('made.py', 'w').write('made = 1\n')"],
            cwd=repo,
            workspace_root=guard.require_root(),
            timeout_seconds=30,
        )
        return ToolHandlerResult(
            output=json.dumps({"job_id": started.job_id, "status": "started"}),
            metadata={"background_job_id": started.job_id},
        )

    start = _observe(
        guard, "run_command", _start,
        run_in_background=True, _jenny_restore_point=dict(_START_POINT),
    )
    job_id = str(start.metadata["background_job_id"])
    assert start.metadata["scripted_change_review"]["restore_point"] == _START_POINT
    deadline = time.monotonic() + 20
    while True:
        arguments = {"job_id": job_id}
        # A later turn polls: its own restore point must not relabel the job.
        checked = _observe(
            guard, "check_background_job",
            lambda arguments=arguments: check_background_job_tool(arguments, guard),
            job_id=job_id, _jenny_restore_point=dict(_LATER_POINT),
        )
        if json.loads(checked.output)["state"] != "running":
            break
        assert time.monotonic() < deadline
        time.sleep(0.05)

    review = checked.metadata["scripted_change_review"]
    assert review["certainty"] == "background_window"
    assert review["restore_point"] == _START_POINT
    assert _START_POINT["ref"] not in checked.output


def test_a_background_job_started_without_a_restore_point_finishes_without_one(
    tmp_path: Path,
) -> None:
    repo, guard = _repo(tmp_path)

    job_id, _start = _start_job(guard, repo, "open('made.py', 'w').write('x')")
    checks = _poll_until_terminal(guard, job_id)

    assert "restore_point" not in checks[-1].metadata["scripted_change_review"]


def test_the_builtin_server_carries_the_restore_point_past_strict_schemas(
    tmp_path: Path,
) -> None:
    from sidecar.ai.mcp import builtin_server

    for command in (
        ["git", "init", "-q"],
        ["git", "config", "user.email", "test@example.com"],
        ["git", "config", "user.name", "Test"],
    ):
        subprocess.run(command, cwd=tmp_path, check=True)
    (tmp_path / "writer.py").write_text("open('made.py', 'w').write('made = 1')\n", "utf-8")
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=tmp_path, check=True)
    workspace = WorkspaceGuard(str(tmp_path))
    tools = builtin_server._default_tools({"tools_shell_enabled": True})

    response = builtin_server._handle_tools_call(
        "rp-1", tools, workspace,
        {"name": "run_command", "arguments": {
            "command": f'"{sys.executable}" writer.py',
            "_jenny_restore_point": dict(_START_POINT),
        }},
    )

    result = dict(response["result"])
    assert result["metadata"]["scripted_change_review"]["restore_point"] == _START_POINT
    assert _START_POINT["ref"] not in json.dumps(result["content"])
