"""Change windows for background ``run_command`` jobs (row 34 S2).

A background job outlives its call, so its edits cannot be diffed at the call
seam. At start this module keeps a git status and fingerprint snapshot (never
file content) per job, in this process only: the workspace-writable status file
never carries it. The first ``check_background_job`` or ``stop_background_job``
that sees the job ended reports one ``scripted_change_review`` with
``certainty: "background_window"`` and summary-only, path-only ``diffs``; other
calls may have overlapped the window. Later checks report nothing more. That
review names the restore point of the run that started the job (row 34 S5).
"""

from __future__ import annotations

import json
import logging
import os
import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import TypeVar

from sidecar.ai.tools.builtins import scripted_change_capture as scripted
from sidecar.ai.tools.builtins import shell_background
from sidecar.ai.tools.builtins import worktree_change_tracking as tracking
from sidecar.ai.tools.builtins.shell_background_status import BACKGROUND_JOB_CANCELLED_ERROR
from sidecar.ai.tools.contracts import ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard

MAX_CHANGE_WINDOWS = 64
_BACKGROUND_JOB_TOOLS = frozenset({"check_background_job", "stop_background_job"})
_TERMINAL_JOB_STATES = frozenset({"completed", "failed"})
_T = TypeVar("_T")


@dataclass(frozen=True)
class ChangeWindow:
    """Status and fingerprints before a background job started, or why not."""

    before: tracking.WorktreeSnapshot | None
    state: str = scripted.STATE_OBSERVED
    reason: str | None = None
    restore_point: dict[str, str] | None = None


_lock = threading.Lock()
_windows: OrderedDict[tuple[str, str], ChangeWindow] = OrderedDict()


def run_with_change_observation(  # noqa: PLR0913 - mirrors the dispatch seam it wraps.
    *,
    side_effecting: bool,
    tool_name: str,
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
    handler: Callable[[], _T],
    logger: logging.Logger,
) -> _T:
    """``run_with_worktree_observation`` plus background-job change windows."""
    window = _begin_window(tool_name, arguments, workspace)
    result = tracking.run_with_worktree_observation(
        side_effecting=side_effecting, tool_name=tool_name, arguments=arguments,
        workspace=workspace, handler=handler, logger=logger,
    )
    if not isinstance(result, ToolHandlerResult):
        return result
    if window is not None:
        _remember(window, workspace, result)
    if tool_name not in _BACKGROUND_JOB_TOOLS:
        return result
    evidence = _terminal_evidence(arguments, workspace, result)
    if not evidence:
        return result
    return replace(result, metadata={**result.metadata, **evidence})


def _reset_change_windows_for_tests() -> None:
    with _lock:
        _windows.clear()


def _begin_window(
    tool_name: str, arguments: dict[str, object], workspace: WorkspaceGuard
) -> ChangeWindow | None:
    if (
        tool_name != "run_command" or arguments.get("run_in_background") is not True
        or workspace.root is None or not tracking.shell_change_evidence_enabled()
    ):
        return None
    point = scripted.restore_point_argument(arguments)
    try:
        repo_root = tracking._repo_root_for(arguments, workspace)
        before = tracking._status_snapshot(repo_root, workspace=workspace)
    except Exception as error:  # noqa: BLE001 - the terminal review says why instead.
        state, reason = tracking._probe_failure(error)
        return ChangeWindow(None, state=state, reason=reason, restore_point=point)
    return ChangeWindow(before, restore_point=point)


def _window_key(workspace: WorkspaceGuard, job_id: str) -> tuple[str, str]:
    return (os.path.normcase(str(workspace.require_root().resolve())), job_id)


def _remember(window: ChangeWindow, workspace: WorkspaceGuard, result: ToolHandlerResult) -> None:
    job_id = result.metadata.get("background_job_id")
    if not result.success or not isinstance(job_id, str):
        return
    try:
        key = _window_key(workspace, job_id)
    except Exception:  # noqa: BLE001 - reconciliation is optional evidence.
        return
    with _lock:
        _windows[key] = window
        _windows.move_to_end(key)
        while len(_windows) > MAX_CHANGE_WINDOWS:
            _windows.popitem(last=False)


def _take_terminal_window(workspace: WorkspaceGuard, job_id: str) -> ChangeWindow | None:
    """The window once the job's process has exited; handed out once.

    Asked only after a terminal status was read. That file is workspace
    writable, so a job this process still runs keeps its window.
    """
    key = _window_key(workspace, job_id)
    with _lock:
        if key not in _windows or shell_background.owned_job_running(job_id):
            return None
        return _windows.pop(key)


def _terminal_evidence(
    arguments: dict[str, object], workspace: WorkspaceGuard, result: ToolHandlerResult
) -> dict[str, object]:
    job_id = arguments.get("job_id")
    status = _json_object(result.output)
    state = status.get("state")
    if (
        not isinstance(job_id, str) or workspace.root is None
        or not isinstance(state, str) or state not in _TERMINAL_JOB_STATES
    ):
        return {}
    try:
        window = _take_terminal_window(workspace, job_id)
    except Exception:  # noqa: BLE001 - reconciliation is optional evidence.
        return {}
    if window is None:
        return {}
    return _reconcile(
        window, workspace, _job_outcome(status), tracking.diff_id_prefix_for(arguments)
    )


def _reconcile(
    window: ChangeWindow, workspace: WorkspaceGuard, outcome: str, prefix: str
) -> dict[str, object]:
    """Summary-only diffs (paths only) for what changed across the window."""
    certainty, point = scripted.CERTAINTY_BACKGROUND, window.restore_point
    before = window.before
    if before is None:
        return {"scripted_change_review": scripted.build_review(
            state=window.state, reason=window.reason, call_outcome=outcome, certainty=certainty,
            restore_point=point,
        )}
    try:
        after = tracking._status_snapshot(before.repo_root, workspace=workspace)
        changed = sorted(
            path for path in tracking._changed_paths(before, after)
            if not tracking._is_cache_path(path)
        )
        diffs = scripted.summary_only_diffs(
            changed, prefix, "preimage_unavailable", statuses=_statuses(before, after, changed),
        )
    except Exception as error:  # noqa: BLE001 - evidence is optional; the tool result is primary.
        state, reason = tracking._probe_failure(error)
        return {"scripted_change_review": scripted.build_review(
            state=state, reason=reason, call_outcome=outcome, certainty=certainty,
            restore_point=point,
        )}
    evidence: dict[str, object] = {"diffs": diffs.diffs} if diffs.diffs else {}
    evidence["scripted_change_review"] = scripted.build_review(
        state=scripted.observed_state(diffs), call_outcome=outcome,
        changed_paths=changed, diffs=diffs, certainty=certainty, restore_point=point,
    )
    return evidence


def _statuses(
    before: tracking.WorktreeSnapshot, after: tracking.WorktreeSnapshot, changed: list[str]
) -> dict[str, str]:
    """created/modified/deleted from existence at both ends of the window."""
    statuses: dict[str, str] = {}
    for path in changed:
        if path in before.status:
            existed = before.fingerprints.get(path) is not None
        else:
            # Clean before: tracked and present, unless it is new now.
            now = after.status.get(path, "")
            existed = not (now == "??" or now.startswith("A"))
        exists = os.path.lexists(Path(after.repo_root) / path)
        statuses[path] = scripted.change_status(existed, exists) or "unknown"
    return statuses


def _job_outcome(status: dict[str, object]) -> str:
    error = status.get("error")
    if error == BACKGROUND_JOB_CANCELLED_ERROR:
        return "cancelled"
    if status.get("state") == "completed":
        return "succeeded"
    if isinstance(error, str) and error.startswith("timed out"):
        return "timed_out"
    return "failed"


def _json_object(text: str) -> dict[str, object]:
    try:
        payload = json.loads(text)
    except ValueError:
        return {}
    return payload if isinstance(payload, dict) else {}
