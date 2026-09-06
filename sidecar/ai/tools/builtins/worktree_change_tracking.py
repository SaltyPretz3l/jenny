"""Ephemeral, observational worktree baselines for Jenny-owned mutations."""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Callable, Iterable, TypeVar

from sidecar.ai.error_codes import (
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_PRECONDITION_UNMET,
    CMP_TOOL_WORKTREE_BASELINE_NOT_FOUND,
)
from sidecar.ai.tools.builtins.git_ops import (
    _find_git_root,
    _resolve_cwd,
    _run_git,
    _run_git_raw,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard

BASELINE_TTL_SECONDS = 8 * 60 * 60
MAX_BASELINES = 32
MAX_STATUS_PATHS = 5_000
MAX_STATUS_OUTPUT_CHARS = 12_000
MAX_DELTA_OUTPUT_CHARS = 12_000
MAX_TREE_PATHS_PER_QUERY = 128
MAX_TREE_PATHSPEC_CHARS = 16_000
MAX_OPERATION_LEDGER_ENTRIES = 128
MAX_OPERATION_LEDGER_PATHS = 256
MIN_PORCELAIN_RECORD_CHARS = 4
_DIRECT_SESSION_ID = "builtin-mcp"
_INTERNAL_STATUS_PREFIXES = (
    ".jenny/artifacts/",
    ".jenny/backups/",
    ".jenny/tool-results/",
    ".jenny/trash/",
)
_T = TypeVar("_T")


@dataclass(frozen=True)
class WorktreeSnapshot:
    repo_root: Path
    head: str | None
    branch: str | None
    status: dict[str, str]
    fingerprints: dict[str, tuple[int, int] | None] = field(default_factory=dict)


@dataclass
class WorktreeBaseline:
    baseline_id: str
    session_id: str
    created_at: float
    initial: WorktreeSnapshot
    last_observed: WorktreeSnapshot
    session_paths: set[str] = field(default_factory=set)
    external_paths: set[str] = field(default_factory=set)
    ambiguous_paths: set[str] = field(default_factory=set)
    ambiguity_reasons: list[str] = field(default_factory=list)
    background_active: bool = False
    observation_degraded: bool = False
    operation_ledger: list[dict[str, object]] = field(default_factory=list)


@dataclass(frozen=True)
class MutationObservation:
    baseline_id: str
    before: WorktreeSnapshot
    background: bool
    tool_name: str
    operation_id: str


_LOCK = threading.RLock()
_BASELINES: OrderedDict[str, WorktreeBaseline] = OrderedDict()
_ACTIVE_BY_SESSION_REPO: dict[tuple[str, str], str] = {}


def workspace_change_baseline_tool(
    arguments: dict[str, object], workspace: WorkspaceGuard
) -> ToolHandlerResult:
    snapshot = _capture(arguments, workspace)
    session_id = _session_id(arguments)
    now = time.monotonic()
    baseline = WorktreeBaseline(
        baseline_id=uuid.uuid4().hex[:16],
        session_id=session_id,
        created_at=now,
        initial=snapshot,
        last_observed=snapshot,
    )
    key = (session_id, _repo_key(snapshot.repo_root))
    with _LOCK:
        _expire_locked(now)
        previous = _ACTIVE_BY_SESSION_REPO.get(key)
        if previous is not None:
            _BASELINES.pop(previous, None)
        _BASELINES[baseline.baseline_id] = baseline
        _ACTIVE_BY_SESSION_REPO[key] = baseline.baseline_id
        _evict_locked()
    status_rows, status_truncated = _status_rows(snapshot.status)
    payload: dict[str, object] = {
        "baseline_id": baseline.baseline_id,
        "head": snapshot.head,
        "branch": snapshot.branch,
        "status": status_rows,
        "status_total": len(snapshot.status),
        "status_truncated": status_truncated,
        "expires_in_seconds": BASELINE_TTL_SECONDS,
        "persisted": False,
    }
    return ToolHandlerResult(output=json.dumps(payload, indent=2), success=True, metadata=payload)


def workspace_change_delta_tool(
    arguments: dict[str, object], workspace: WorkspaceGuard
) -> ToolHandlerResult:
    baseline_id = arguments.get("baseline_id")
    if not isinstance(baseline_id, str) or not baseline_id.strip():
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'baseline_id' must be a non-empty string",
            retryable=False,
        )
    with _LOCK:
        baseline = _require_baseline_locked(baseline_id.strip())
        if baseline.session_id != _session_id(arguments):
            raise _missing_baseline()
        repo_root = baseline.initial.repo_root
    current = _capture(arguments, workspace) if arguments.get("cwd") else _capture_repo(repo_root)
    with _LOCK:
        baseline = _require_baseline_locked(baseline_id.strip())
        if _repo_key(baseline.initial.repo_root) != _repo_key(current.repo_root):
            raise _missing_baseline()
        _record_between_calls(baseline, current)
        baseline.last_observed = current
        payload = _build_delta(baseline, current)
    return ToolHandlerResult(output=json.dumps(payload, indent=2), success=True, metadata=payload)


def run_with_worktree_observation(  # noqa: PLR0913 - dispatch context is explicit.
    *,
    side_effecting: bool,
    tool_name: str,
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
    handler: Callable[[], _T],
    logger: logging.Logger,
) -> _T:
    """Run one handler with fail-soft worktree observation at the dispatch seam."""
    observation = None
    if side_effecting:
        try:
            observation = begin_mutation_observation(
                tool_name=tool_name, arguments=arguments, workspace=workspace
            )
        except Exception as error:  # noqa: BLE001 - attribution must not alter the tool outcome.
            _safe_mark_observation_failure(arguments, reason="pre-observation failed")
            logger.warning(
                "worktree attribution pre-observation failed",
                extra={"tool_name": tool_name, "error_type": type(error).__name__},
            )
    try:
        result = handler()
    except BaseException:
        _finish_observation_fail_soft(
            observation=observation,
            arguments=arguments,
            workspace=workspace,
            success=False,
            tool_name=tool_name,
            logger=logger,
        )
        raise
    attribution = _finish_observation_fail_soft(
        observation=observation,
        arguments=arguments,
        workspace=workspace,
        success=bool(getattr(result, "success", True)),
        tool_name=tool_name,
        logger=logger,
    )
    if isinstance(result, ToolHandlerResult) and attribution is not None:
        metadata = dict(result.metadata)
        metadata["worktree_observation"] = attribution
        return replace(result, metadata=metadata)
    return result


def _finish_observation_fail_soft(  # noqa: PLR0913 - dispatch evidence context.
    *,
    observation: MutationObservation | None,
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
    success: bool,
    tool_name: str,
    logger: logging.Logger,
) -> dict[str, object] | None:
    if observation is None:
        return None
    try:
        return finish_mutation_observation(
            observation,
            workspace=workspace,
            arguments=arguments,
            success=success,
        )
    except Exception as error:  # noqa: BLE001 - attribution is secondary evidence.
        _safe_mark_observation_failure(
            arguments,
            baseline_id=getattr(observation, "baseline_id", None),
            reason="post-observation failed",
        )
        logger.warning(
            "worktree attribution post-observation failed",
            extra={"tool_name": tool_name, "error_type": type(error).__name__},
        )
        return None


def begin_mutation_observation(
    *,
    tool_name: str,
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> MutationObservation | None:
    session_id = _session_id(arguments)
    with _LOCK:
        _expire_locked(time.monotonic())
        active_ids = [
            value for key, value in _ACTIVE_BY_SESSION_REPO.items() if key[0] == session_id
        ]
        if not active_ids:
            return None
        sole_baseline = _BASELINES.get(active_ids[0]) if len(active_ids) == 1 else None
    snapshot = (
        _capture_repo(sole_baseline.initial.repo_root)
        if sole_baseline is not None
        else _capture(arguments, workspace)
    )
    key = (session_id, _repo_key(snapshot.repo_root))
    with _LOCK:
        _expire_locked(time.monotonic())
        baseline_id = _ACTIVE_BY_SESSION_REPO.get(key)
        if baseline_id is None:
            return None
        baseline = _BASELINES.get(baseline_id)
        if baseline is None:
            return None
        _record_between_calls(baseline, snapshot)
        baseline.last_observed = snapshot
        return MutationObservation(
            baseline_id=baseline_id,
            before=snapshot,
            background=(
                (tool_name == "run_command" and arguments.get("run_in_background") is True)
                or tool_name == "stop_background_job"
            ),
            tool_name=tool_name,
            operation_id=str(arguments.get("_jenny_operation_id") or "").strip(),
        )


def finish_mutation_observation(
    observation: MutationObservation,
    *,
    workspace: WorkspaceGuard,
    arguments: dict[str, object],
    success: bool = True,
) -> dict[str, object] | None:
    after = _capture_repo(observation.before.repo_root)
    with _LOCK:
        baseline = _BASELINES.get(observation.baseline_id)
        if baseline is None:
            return None
        changed = _changed_paths(observation.before, after)
        if observation.background:
            baseline.ambiguous_paths.update(changed)
            baseline.background_active = True
            _append_reason(baseline, "background command may continue changing the worktree")
        else:
            baseline.session_paths.update(changed)
        certainty = "ambiguous_background" if observation.background else "observed_during_call"
        sorted_changed = sorted(changed)
        ledger_entry: dict[str, object] = {
            "operation_id": observation.operation_id or None,
            "tool_name": observation.tool_name,
            "timestamp": time.time(),
            "changed_paths": sorted_changed[:MAX_OPERATION_LEDGER_PATHS],
            "changed_path_count": len(sorted_changed),
            "changed_paths_truncated": len(sorted_changed) > MAX_OPERATION_LEDGER_PATHS,
            "certainty": certainty,
            "success": success,
        }
        baseline.operation_ledger.append(ledger_entry)
        if len(baseline.operation_ledger) > MAX_OPERATION_LEDGER_ENTRIES:
            del baseline.operation_ledger[:-MAX_OPERATION_LEDGER_ENTRIES]
        baseline.last_observed = after
        return ledger_entry


def _reset_worktree_tracking_for_tests() -> None:
    with _LOCK:
        _BASELINES.clear()
        _ACTIVE_BY_SESSION_REPO.clear()


def mark_observation_failure(
    arguments: dict[str, object],
    *,
    reason: str,
    baseline_id: str | None = None,
) -> None:
    session_id = _session_id(arguments)
    with _LOCK:
        targets = (
            [_BASELINES[baseline_id]]
            if baseline_id is not None and baseline_id in _BASELINES
            else [
                baseline
                for baseline in _BASELINES.values()
                if baseline.session_id == session_id
            ]
        )
        for baseline in targets:
            baseline.observation_degraded = True
            _append_reason(baseline, reason)


def _safe_mark_observation_failure(
    arguments: dict[str, object],
    *,
    reason: str,
    baseline_id: str | None = None,
) -> None:
    try:
        mark_observation_failure(arguments, reason=reason, baseline_id=baseline_id)
    except Exception:  # noqa: BLE001 - attribution must never alter the primary result.
        return


def _capture(arguments: dict[str, object], workspace: WorkspaceGuard) -> WorktreeSnapshot:
    cwd = _resolve_cwd(arguments, workspace)
    workspace_root = workspace.require_root().resolve()
    repo_root = _find_git_root(cwd, workspace_root)
    if repo_root is None:
        raise ToolExecutionFailure(
            code=CMP_TOOL_PRECONDITION_UNMET,
            message="worktree tracking requires a git repository within the workspace",
            retryable=False,
            error_details={
                "precondition_id": "git_repo",
                "failure_class": "precondition_unmet",
            },
        )
    return _capture_repo(repo_root)


def _capture_repo(repo_root: Path) -> WorktreeSnapshot:
    raw_status = _run_git_raw(
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        cwd=repo_root,
    )
    status = _parse_porcelain(raw_status)
    if len(status) > MAX_STATUS_PATHS:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"worktree status exceeds {MAX_STATUS_PATHS} path limit",
            retryable=False,
        )
    try:
        head = _run_git(["rev-parse", "--verify", "HEAD"], cwd=repo_root)
    except ToolExecutionFailure:
        head = None
    branch = _run_git(["branch", "--show-current"], cwd=repo_root)
    return WorktreeSnapshot(
        repo_root=repo_root.resolve(),
        head=head,
        branch=branch or None,
        status=status,
        fingerprints=_fingerprint_status_paths(repo_root, status),
    )


def _parse_porcelain(raw: str) -> dict[str, str]:
    records = raw.split("\0")
    status: dict[str, str] = {}
    index = 0
    while index < len(records):
        record = records[index]
        index += 1
        if not record:
            continue
        if len(record) < MIN_PORCELAIN_RECORD_CHARS:
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message="git returned malformed worktree status",
                retryable=True,
            )
        state = record[:2]
        path = record[3:].replace("\\", "/")
        if not _is_internal_status_path(path):
            status[path] = state
        if "R" in state or "C" in state:
            if index >= len(records) or not records[index]:
                raise ToolExecutionFailure(
                    code=CMP_TOOL_INVALID_PATH,
                    message="git returned malformed rename status",
                    retryable=True,
                )
            source = records[index].replace("\\", "/")
            index += 1
            if not _is_internal_status_path(source):
                status[source] = state
    return status


def _record_between_calls(baseline: WorktreeBaseline, current: WorktreeSnapshot) -> None:
    changed = _changed_paths(baseline.last_observed, current)
    if baseline.background_active:
        baseline.ambiguous_paths.update(changed)
        if changed:
            _append_reason(baseline, "changes observed after a background command are ambiguous")
    else:
        baseline.external_paths.update(changed)


def _is_internal_status_path(path: str) -> bool:
    return any(path.startswith(prefix) for prefix in _INTERNAL_STATUS_PREFIXES)


def _build_delta(baseline: WorktreeBaseline, current: WorktreeSnapshot) -> dict[str, object]:
    initial = baseline.initial.status
    final = current.status
    all_paths = sorted(set(initial) | set(final) | baseline.session_paths | baseline.external_paths)
    preexisting_paths = set(initial)
    if baseline.initial.head is not None:
        preexisting_paths.update(
            _paths_at_ref(
                baseline.initial.repo_root,
                baseline.initial.head,
                (path for path in all_paths if path not in initial),
            )
        )
    changed_from_initial = _changed_paths(baseline.initial, current)
    categories: dict[str, list[str]] = {
        "created_by_session": [],
        "created_then_removed_by_session": [],
        "preexisting_and_touched": [],
        "appeared_externally": [],
        "unchanged_preexisting": [],
        "resolved_preexisting": [],
        "mixed_or_ambiguous": [],
    }
    for path in all_paths:
        session = path in baseline.session_paths
        external = path in baseline.external_paths
        ambiguous = (
            path in baseline.ambiguous_paths
            or (session and external)
            or (baseline.observation_degraded and path in changed_from_initial)
        )
        existed = path in preexisting_paths
        remains = path in final
        if ambiguous:
            category = "mixed_or_ambiguous"
        elif not existed and not remains and session and not external:
            category = "created_then_removed_by_session"
        elif existed and not remains:
            category = "resolved_preexisting" if session and not external else "mixed_or_ambiguous"
        elif existed and session and not external:
            category = "preexisting_and_touched"
        elif not existed and remains and session and not external:
            category = "created_by_session"
        elif not existed and remains and external and not session:
            category = "appeared_externally"
        elif existed and initial.get(path) == final.get(path) and not session and not external:
            category = "unchanged_preexisting"
        else:
            category = "mixed_or_ambiguous"
        categories[category].append(path)
    bounded_categories, delta_truncated = _bound_categories(categories)
    return {
        "baseline_id": baseline.baseline_id,
        "head": current.head,
        "branch": current.branch,
        **bounded_categories,
        "category_totals": {key: len(paths) for key, paths in categories.items()},
        "truncated": delta_truncated,
        "ambiguity_reasons": list(baseline.ambiguity_reasons),
        "operation_ledger": list(baseline.operation_ledger),
        "attribution_caveat": (
            "Attribution is observational and limited to paths reported by Git status; "
            "ignored paths and unchanged clean files are not tracked exhaustively. Concurrent "
            "edits during a Jenny-owned tool call cannot be distinguished from that tool's effects."
        ),
    }


def _paths_at_ref(repo_root: Path, ref: str, paths: Iterable[str]) -> set[str]:
    candidates = list(paths)
    matched: set[str] = set()
    chunk: list[str] = []
    chunk_chars = 0

    def flush() -> None:
        nonlocal chunk, chunk_chars
        if not chunk:
            return
        output = _run_git_raw(
            [
                "ls-tree",
                "-r",
                "-z",
                "--name-only",
                ref,
                "--",
                *(f":(literal){path}" for path in chunk),
            ],
            cwd=repo_root,
        )
        matched.update(path for path in output.split("\0") if path)
        chunk = []
        chunk_chars = 0

    for path in candidates:
        path_chars = len(path) + len(":(literal)")
        if chunk and (
            len(chunk) >= MAX_TREE_PATHS_PER_QUERY
            or chunk_chars + path_chars > MAX_TREE_PATHSPEC_CHARS
        ):
            flush()
        chunk.append(path)
        chunk_chars += path_chars
    flush()
    return matched


def _changed_paths(before: WorktreeSnapshot, after: WorktreeSnapshot) -> set[str]:
    paths = set(before.status) | set(after.status)
    return {
        path
        for path in paths
        if before.status.get(path) != after.status.get(path)
        or before.fingerprints.get(path) != after.fingerprints.get(path)
    }


def _bound_categories(
    categories: dict[str, list[str]],
) -> tuple[dict[str, list[str]], bool]:
    bounded: dict[str, list[str]] = {key: [] for key in categories}
    used_chars = 0
    truncated = False
    for key, paths in categories.items():
        for path in paths:
            estimated_chars = len(path) + 4
            if used_chars + estimated_chars > MAX_DELTA_OUTPUT_CHARS:
                truncated = True
                continue
            bounded[key].append(path)
            used_chars += estimated_chars
    return bounded, truncated


def _fingerprint_status_paths(
    repo_root: Path, status: dict[str, str]
) -> dict[str, tuple[int, int] | None]:
    fingerprints: dict[str, tuple[int, int] | None] = {}
    for path in status:
        try:
            file_stat = (repo_root / path).lstat()
        except OSError:
            fingerprints[path] = None
        else:
            fingerprints[path] = (max(file_stat.st_size, 0), max(file_stat.st_mtime_ns, 0))
    return fingerprints


def _status_rows(status: dict[str, str]) -> tuple[list[dict[str, object]], bool]:
    rows: list[dict[str, object]] = []
    used_chars = 0
    for path, state in sorted(status.items()):
        estimated_chars = len(path) + 80
        if used_chars + estimated_chars > MAX_STATUS_OUTPUT_CHARS:
            return rows, True
        rows.append(
            {
            "path": path,
            "status": state,
            "staged": state[0] not in {" ", "?"},
            "unstaged": state[1] not in {" ", "?"},
            "untracked": state == "??",
            }
        )
        used_chars += estimated_chars
    return rows, False


def _session_id(arguments: dict[str, object]) -> str:
    value = arguments.get("_jenny_session_id")
    return str(value).strip() if isinstance(value, str) and value.strip() else _DIRECT_SESSION_ID


def _repo_key(path: Path) -> str:
    return os.path.normcase(str(path))


def _append_reason(baseline: WorktreeBaseline, reason: str) -> None:
    if reason not in baseline.ambiguity_reasons:
        baseline.ambiguity_reasons.append(reason)


def _require_baseline_locked(baseline_id: str) -> WorktreeBaseline:
    _expire_locked(time.monotonic())
    baseline = _BASELINES.get(baseline_id)
    if baseline is None:
        raise _missing_baseline()
    _BASELINES.move_to_end(baseline_id)
    return baseline


def _missing_baseline() -> ToolExecutionFailure:
    return ToolExecutionFailure(
        code=CMP_TOOL_WORKTREE_BASELINE_NOT_FOUND,
        message="worktree baseline is missing or expired; capture a new workspace_change_baseline",
        retryable=False,
    )


def _expire_locked(now: float) -> None:
    expired = [
        key
        for key, item in _BASELINES.items()
        if now - item.created_at > BASELINE_TTL_SECONDS
    ]
    for baseline_id in expired:
        baseline = _BASELINES.pop(baseline_id)
        key = (baseline.session_id, _repo_key(baseline.initial.repo_root))
        _ACTIVE_BY_SESSION_REPO.pop(key, None)


def _evict_locked() -> None:
    while len(_BASELINES) > MAX_BASELINES:
        baseline_id, baseline = _BASELINES.popitem(last=False)
        key = (baseline.session_id, _repo_key(baseline.initial.repo_root))
        _ACTIVE_BY_SESSION_REPO.pop(key, None)
