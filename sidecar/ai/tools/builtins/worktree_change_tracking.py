"""Ephemeral, observational worktree baselines for Jenny-owned mutations."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Callable, Iterable, TypeVar

from sidecar.ai.config import read_environment_value
from sidecar.ai.error_codes import (
    CMP_TOOL_COMMAND_ABORTED,
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_PRECONDITION_UNMET,
    CMP_TOOL_WORKTREE_BASELINE_NOT_FOUND,
)
from sidecar.ai.tools.builtins import scripted_change_capture as scripted
from sidecar.ai.tools.builtins.git_ops import (
    _find_git_root,
    _resolve_cwd,
    _run_git,
    _run_git_raw,
)
from sidecar.ai.tools.contracts import (
    TOOL_FAILURE_RESULT_METADATA_KEYS,
    ToolExecutionFailure,
    ToolHandlerResult,
)
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
# TR-015: foreground shell tools report ``workspace_changed`` from a status diff
# (``JENNY_ENABLE_SHELL_CHANGE_EVIDENCE=0`` disables the probe). Interpreter and
# test caches are not the model's edits. Row 34: the same probe captures
# user-only diffs and a ``scripted_change_review`` record for these tools.
SHELL_CHANGE_EVIDENCE_FLAG = "JENNY_ENABLE_SHELL_CHANGE_EVIDENCE"
_SHELL_EVIDENCE_TOOLS = frozenset({"run_command", "run_temp_script", "python_execute"})
_CACHE_PATH_SEGMENTS = frozenset({"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"})
# ``source_changed`` narrows that to saved source: index-only transitions
# (``git add``/``commit``) and untracked outputs without a source suffix (a stray
# ``cfile=none``, a repo-root ``holdout/`` data folder) are not saves. New stray
# outputs are named in the result so the model notices them (MQ-014/MQ-027).
_SOURCE_SUFFIXES = scripted.SOURCE_SUFFIXES
MAX_STRAY_NOTE_ENTRIES = 5
MAX_STRAY_NOTE_CHARS = 400
_STRAY_NOTE_PREFIX = "New untracked files outside ignored folders: "
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
class _ShellProbe:
    """Pre-call state for one foreground shell call, or why it is not observed."""

    before: WorktreeSnapshot | None
    preimages: dict[str, scripted.FileContent] = field(default_factory=dict)
    state: str = scripted.STATE_OBSERVED
    reason: str | None = None
    diff_id_prefix: str = "scripted:call"
    # The turn's restore point routing handed this call (row 34 S5), if any.
    restore_point: dict[str, str] | None = None


class _StatusOverLimit(ToolExecutionFailure):
    """Status exceeded ``MAX_STATUS_PATHS``; review evidence is unavailable."""


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
    current = (_capture(arguments, workspace) if arguments.get("cwd")
               else _capture_repo(repo_root, workspace=workspace))
    with _LOCK:
        baseline = _require_baseline_locked(baseline_id.strip())
        if _repo_key(baseline.initial.repo_root) != _repo_key(current.repo_root):
            raise _missing_baseline()
        _record_between_calls(baseline, current)
        baseline.last_observed = current
        payload = _build_delta(baseline, current, workspace=workspace)
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
    # A live baseline's pre-call snapshot doubles as the probe's before state.
    shell_probe = _begin_shell_change_probe(
        tool_name, arguments, workspace,
        before=observation.before if isinstance(observation, MutationObservation) else None,
    )
    try:
        result = handler()
    except BaseException as error:
        _finish_observation_fail_soft(
            observation=observation,
            arguments=arguments,
            workspace=workspace,
            success=False,
            tool_name=tool_name,
            logger=logger,
        )
        if shell_probe is not None and isinstance(error, ToolExecutionFailure):
            _attach_failure_evidence(error, shell_probe, workspace)
        raise
    attribution = _finish_observation_fail_soft(
        observation=observation,
        arguments=arguments,
        workspace=workspace,
        success=bool(getattr(result, "success", True)),
        tool_name=tool_name,
        logger=logger,
    )
    evidence: dict[str, object] = {}
    if attribution is not None:
        evidence["worktree_observation"] = attribution
    if not isinstance(result, ToolHandlerResult):
        return result
    output = result.output
    if shell_probe is not None:
        shell_evidence, notes = _finish_shell_change_probe(
            shell_probe, workspace, _call_outcome(result)
        )
        evidence.update(shell_evidence)
        output = _with_model_notes(output, notes)
    if not evidence:
        return result
    return replace(result, output=output, metadata={**result.metadata, **evidence})


def _begin_shell_change_probe(
    tool_name: str,
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
    *,
    before: WorktreeSnapshot | None = None,
) -> _ShellProbe | None:
    """Status snapshot and bounded preimages before a foreground shell tool.

    Consumers (the write-progress streak, the verification gate) treat a command
    as a save only on ``workspace_changed`` evidence. No git repository, a
    background job, or any probe failure yields no evidence rather than a
    guess; the review record says which case applies.
    """
    if tool_name not in _SHELL_EVIDENCE_TOOLS:
        return None
    probe = _shell_probe_state(arguments, workspace, before)
    return replace(probe, restore_point=scripted.restore_point_argument(arguments))


def _shell_probe_state(
    arguments: dict[str, object], workspace: WorkspaceGuard, before: WorktreeSnapshot | None
) -> _ShellProbe:
    if arguments.get("run_in_background") is True:
        return _ShellProbe(None, state=scripted.STATE_UNAVAILABLE, reason="background")
    if not shell_change_evidence_enabled():
        return _ShellProbe(None, state=scripted.STATE_UNAVAILABLE, reason="disabled")
    if workspace.root is None:
        return _ShellProbe(None, state=scripted.STATE_UNSUPPORTED, reason="no_workspace")
    try:
        if before is None:
            before = _status_snapshot(_repo_root_for(arguments, workspace), workspace=workspace)
    except Exception as error:  # noqa: BLE001 - evidence is optional; the tool result is primary.
        state, reason = _probe_failure(error)
        return _ShellProbe(None, state=state, reason=reason)
    return _ShellProbe(
        before,
        preimages=_capture_preimages_fail_soft(before, workspace),
        diff_id_prefix=diff_id_prefix_for(arguments),
    )


def shell_change_evidence_enabled() -> bool:
    """False when ``JENNY_ENABLE_SHELL_CHANGE_EVIDENCE=0`` disables the probe."""
    return read_environment_value(SHELL_CHANGE_EVIDENCE_FLAG, "1") != "0"


def diff_id_prefix_for(arguments: dict[str, object]) -> str:
    return scripted.diff_id_prefix(
        arguments.get("_jenny_operation_id") or arguments.get("_jenny_tool_call_id")
        or uuid.uuid4().hex[:12]
    )


def _probe_failure(error: Exception) -> tuple[str, str]:
    if isinstance(error, _StatusOverLimit):
        return scripted.STATE_UNAVAILABLE, "status_over_limit"
    if getattr(error, "precondition_id", "") == "git_repo":
        return scripted.STATE_UNSUPPORTED, "not_git"
    return scripted.STATE_UNAVAILABLE, "probe_failed"


def _capture_preimages_fail_soft(
    before: WorktreeSnapshot, workspace: WorkspaceGuard
) -> dict[str, scripted.FileContent]:
    """In-memory preimages of paths dirty or untracked before the call."""
    try:
        return scripted.capture_preimages(
            before.repo_root,
            workspace.require_root().resolve(),
            [path for path in before.status if not _is_cache_path(path)],
        )
    except Exception:  # noqa: BLE001 - missing preimages degrade to summary-only diffs.
        return {}


def _attach_failure_evidence(
    error: ToolExecutionFailure, probe: _ShellProbe, workspace: WorkspaceGuard
) -> None:
    """Review evidence of a call that raised, on ``error.result_metadata``.

    The model-facing message gains only the path-only scripted-edit line.
    """
    try:
        evidence, notes = _finish_shell_change_probe(probe, workspace, _failure_outcome(error))
    except Exception:  # noqa: BLE001 - the raised error stays the primary outcome.
        return
    carried = {key: evidence[key] for key in TOOL_FAILURE_RESULT_METADATA_KEYS if key in evidence}
    error.result_metadata = {**getattr(error, "result_metadata", {}), **carried}
    note = dict(notes).get("scripted_edit_note")
    if note:
        error.message = f"{error.message}\n{note}" if error.message else note


def _failure_outcome(error: ToolExecutionFailure) -> str:
    """``cancelled`` for a user stop (both handlers raise COMMAND_ABORTED)."""
    if error.code == CMP_TOOL_COMMAND_ABORTED:
        return "cancelled"
    if isinstance(error.__cause__, subprocess.TimeoutExpired):
        return "timed_out"
    return "failed"


def _finish_shell_change_probe(
    probe: _ShellProbe, workspace: WorkspaceGuard, outcome: str
) -> tuple[dict[str, object], list[tuple[str, str]]]:
    """Metadata evidence plus model notes (paths only) for one finished call."""
    before, point = probe.before, probe.restore_point
    if before is None:
        review = scripted.build_review(
            state=probe.state, reason=probe.reason, call_outcome=outcome, restore_point=point
        )
        return {"scripted_change_review": review}, []
    try:
        after = _status_snapshot(before.repo_root, workspace=workspace)
        changed = sorted(
            path for path in _changed_paths(before, after) if not _is_cache_path(path)
        )
        source_paths = [path for path in changed if _is_source_change(before, after, path)]
        created_untracked = _created_untracked_entries(before, after, changed)
    except Exception as error:  # noqa: BLE001 - evidence is optional; the tool result is primary.
        state, reason = _probe_failure(error)
        review = scripted.build_review(
            state=state, reason=reason, call_outcome=outcome, restore_point=point
        )
        return {"scripted_change_review": review}, []
    diffs = _scripted_diffs_fail_soft(probe, before, after, changed, workspace)
    evidence: dict[str, object] = {
        "workspace_changed": bool(changed),
        "source_changed": bool(source_paths),
    }
    if diffs.diffs:
        evidence["diffs"] = diffs.diffs
    evidence["scripted_change_review"] = scripted.build_review(
        state=scripted.observed_state(diffs), call_outcome=outcome,
        changed_paths=changed, diffs=diffs, restore_point=point,
    )
    notes = _model_notes(before, after, source_paths, created_untracked)
    if created_untracked:
        evidence["created_untracked_paths"] = list(created_untracked[:MAX_STRAY_NOTE_ENTRIES])
    return evidence, notes


def _model_notes(
    before: WorktreeSnapshot,
    after: WorktreeSnapshot,
    source_paths: list[str],
    created_untracked: tuple[str, ...],
) -> list[tuple[str, str]]:
    """Path-only lines: source files the call rewrote, then new stray outputs."""
    notes: list[tuple[str, str]] = []
    rewritten = [path for path in source_paths if not _created_untracked(before, after, path)]
    if rewritten:
        notes.append(
            ("scripted_edit_note", scripted.scripted_edit_note(scripted.order_paths(rewritten)))
        )
    if created_untracked:
        notes.append(("new_untracked_files", _stray_note(created_untracked)))
    return notes


def _scripted_diffs_fail_soft(
    probe: _ShellProbe,
    before: WorktreeSnapshot,
    after: WorktreeSnapshot,
    changed: list[str],
    workspace: WorkspaceGuard,
) -> scripted.ScriptedDiffs:
    try:
        return scripted.build_scripted_diffs(
            repo_root=before.repo_root,
            workspace_root=workspace.require_root().resolve(),
            changed=changed,
            before_status=before.status,
            after_status=after.status,
            preimages=probe.preimages,
            run_git=lambda args: _run_git_raw(args, cwd=before.repo_root, workspace=workspace),
            diff_id_prefix=probe.diff_id_prefix,
        )
    except Exception:  # noqa: BLE001 - the changed paths are still reported.
        return scripted.summary_only_diffs(changed, probe.diff_id_prefix, "unknown")


def _call_outcome(result: ToolHandlerResult) -> str:
    if result.metadata.get("timed_out") is True:
        return "timed_out"
    return "succeeded" if result.success else "failed"


def _created_untracked(before: WorktreeSnapshot, after: WorktreeSnapshot, path: str) -> bool:
    return after.status.get(path) == "??" and before.status.get(path) != "??"


def _is_source_like(path: str) -> bool:
    return scripted.is_source_like(path)


def _is_source_change(before: WorktreeSnapshot, after: WorktreeSnapshot, path: str) -> bool:
    """Content changed and the path is tracked, or untracked with a source suffix.

    A status change with unchanged bytes is an index-only transition. A path
    that left status (committed or cleaned) is compared against a fresh lstat.
    A path that was clean (or absent) before and is in status now differs from
    HEAD because of this call, also when the same command staged it.
    """
    before_state, after_state = before.status.get(path), after.status.get(path)
    if before_state is not None:
        if after_state is not None:
            after_print = after.fingerprints.get(path)
        else:
            after_print = _fingerprint_status_paths(after.repo_root, {path: ""})[path]
        if before.fingerprints.get(path) == after_print:
            return False
    tracked = "??" not in (before_state, after_state)
    return tracked or _is_source_like(path)


def _created_untracked_entries(
    before: WorktreeSnapshot, after: WorktreeSnapshot, changed: list[str]
) -> tuple[str, ...]:
    """New untracked, non-source outputs; 2+ under one top-level folder collapse."""
    strays = [
        path for path in changed
        if _created_untracked(before, after, path) and not _is_source_like(path)
    ]
    by_folder: dict[str, list[str]] = {}
    for path in strays:
        top, _, rest = path.partition("/")
        by_folder.setdefault(f"{top}/" if rest else path, []).append(path)
    entries = [
        f"{key} ({len(paths)} files)" if len(paths) > 1 else paths[0]
        for key, paths in sorted(by_folder.items())
    ]
    return tuple(scripted.printable(entry) for entry in entries)


def _stray_note(entries: tuple[str, ...]) -> str:
    shown = entries[:MAX_STRAY_NOTE_ENTRIES]
    hidden = len(entries) - len(shown)
    suffix = f" (+{hidden} more)" if hidden else ""
    body = ", ".join(shown)
    budget = MAX_STRAY_NOTE_CHARS - len(_STRAY_NOTE_PREFIX) - len(suffix)
    if len(body) > budget:
        body = body[: budget - 3] + "..."
    return f"{_STRAY_NOTE_PREFIX}{body}{suffix}"


def _with_model_notes(output: str, notes: list[tuple[str, str]]) -> str:
    """One more line per note for the model; a JSON object result gains keys instead."""
    if not notes:
        return output
    try:
        payload = json.loads(output)
    except ValueError:
        payload = None
    if isinstance(payload, dict):
        return json.dumps({**payload, **dict(notes)}, ensure_ascii=False, indent=2)
    lines = [output] if output else []
    return "\n".join([*lines, *(note for _key, note in notes)])


def _is_cache_path(path: str) -> bool:
    return path.endswith(".pyc") or any(
        part in _CACHE_PATH_SEGMENTS for part in path.split("/")
    )


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
        _capture_repo(sole_baseline.initial.repo_root, workspace=workspace)
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
    after = _capture_repo(observation.before.repo_root, workspace=workspace)
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
    return _capture_repo(_repo_root_for(arguments, workspace), workspace=workspace)


def _repo_root_for(arguments: dict[str, object], workspace: WorkspaceGuard) -> Path:
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
    return repo_root


def _status_snapshot(
    repo_root: Path, *, workspace: WorkspaceGuard | None = None
) -> WorktreeSnapshot:
    """Status and path fingerprints only; HEAD and branch stay unresolved."""
    raw_status = _run_git_raw(
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        cwd=repo_root, workspace=workspace,
    )
    status = _parse_porcelain(raw_status)
    if len(status) > MAX_STATUS_PATHS:
        raise _StatusOverLimit(
            code=CMP_TOOL_INVALID_PATH,
            message=f"worktree status exceeds {MAX_STATUS_PATHS} path limit",
            retryable=False,
        )
    return WorktreeSnapshot(
        repo_root=repo_root.resolve(),
        head=None,
        branch=None,
        status=status,
        fingerprints=_fingerprint_status_paths(repo_root, status),
    )


def _capture_repo(repo_root: Path, *, workspace: WorkspaceGuard | None = None) -> WorktreeSnapshot:
    snapshot = _status_snapshot(repo_root, workspace=workspace)
    try:
        head = _run_git(["rev-parse", "--verify", "HEAD"], cwd=repo_root, workspace=workspace)
    except ToolExecutionFailure:
        head = None
    branch = _run_git(["branch", "--show-current"], cwd=repo_root, workspace=workspace)
    return replace(snapshot, head=head, branch=branch or None)


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


def _build_delta(baseline: WorktreeBaseline, current: WorktreeSnapshot,
                 *, workspace: WorkspaceGuard | None = None) -> dict[str, object]:
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
                workspace=workspace,
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


def _paths_at_ref(repo_root: Path, ref: str, paths: Iterable[str],
                  *, workspace: WorkspaceGuard | None = None) -> set[str]:
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
            cwd=repo_root, workspace=workspace,
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
