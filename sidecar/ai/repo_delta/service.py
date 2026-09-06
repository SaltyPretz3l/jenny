"""Repo-anchor persistence + turn-start/run-end orchestration for repo-delta-on-resume.

This is the "orchestration seam" the chat hub calls into: `build_repository_delta_block`
at turn-start (read-only, computes the `<repository-delta>` prompt block) and
`refresh_repo_anchor` at run-end (writes the current repo position as the next
turn's comparison point). Both are flag-gated, deadline-bounded, and fail-closed --
neither may ever raise out to the caller; a `chat.send` turn must never break
because a git snapshot failed.

Two hardening notes worth restating inline:

- SECURITY (session_id path-segment): `session_id` is CLIENT-SUPPLIED (it rides
  the wire on every `chat.send`) and becomes a filesystem path segment via
  `repo_anchor_path`. The shared runtime-ID parser is exposed here through
  `safe_session_dirname`; it uses an allowlist plus an explicit `.`/`..` reject
  and fails CLOSED (returns `None`, never raises) on anything that doesn't match.
  `repo_anchor_path` then re-checks
  the joined, resolved path is still contained under the anchors base directory
  (symlink/traversal defense-in-depth on top of the regex gate).
- Anchor reads are TOLERANT: missing file, corrupt JSON, wrong shape, or an
  unrecognized `schema_version` all degrade to `None` ("no anchor" / bootstrap),
  never an exception. Anchor writes are atomic (temp file in the target
  directory + `os.replace`, mirrors `ollama_catalog_cache.py`) under a short,
  best-effort lock -- a skipped or lost write just means the next turn's
  comparison point is one turn stale, which is safe and self-healing.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from sidecar.ai.config import RuntimeConfig, resolve_background_runtime_root
from sidecar.ai.repo_delta.git_delta import (
    MAX_COMMITS,
    RepoAnchor,
    RepoDelta,
    compute_repo_delta,
    read_repo_snapshot,
    render_repository_delta_block,
)
from sidecar.ai.utils.coercion import coerce_optional_int
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.file_locking import (
    BACKGROUND_WRITE_TIMEOUT_SECONDS,
    acquire_regenerable_file_lock,
)
from sidecar.runtime.runtime_ids import try_parse_session_id

logger = logging.getLogger(__name__)

# Keep in sync with `RepoAnchor.schema_version`'s dataclass default in
# git_delta.py -- a freshly-read snapshot always carries this value, and a
# persisted record whose `schema_version` doesn't match is treated as unknown.
SCHEMA_VERSION = 1

# Sized for the owned-process git transport (see git_delta.run_git). These are
# DEADLINES, not costs: a fast repo finishes well inside them and returns early,
# so headroom here buys correctness on a slow repo without adding latency on a
# normal one. Too small a budget does not fail the block -- it silently degrades
# commits and files out of it (the deadline refuses later spawns), which is why
# these are sized against measurement rather than estimate.
#
# MEASURED on Windows (2026-07-18, this repo, warm cache, small test repo): one
# owned-process spawn costs 156-188ms (median ~172ms), and a full build -- six
# sequential spawns: snapshot, cat-file, merge-base, rev-list, log, diff -- runs
# 1.03-1.05s end to end.
#
# 4.0s is ~4x the measured build. The margin is deliberate and cheap: this is a
# DEADLINE, not a cost, so a fast repo returns early and never spends it. The
# measurement above is a warm cache on a small repo; a cold cache, a slower disk,
# or a large `log`/`diff` delta is real work that scales past it. Sizing this to
# the measured number is exactly the mistake that produced the original bug.
# `RepoDelta.listing_truncated` is the second half of the guard: if the deadline
# is hit anyway, the block says so instead of silently misleading the model.
DEFAULT_BUILD_BUDGET_SECONDS: float = 4.0
# Refresh reads one snapshot: a combined `rev-parse`, plus a second fallback
# `rev-parse` when the combined form fails (unborn HEAD, non-repo). Two spawns
# measure ~350ms; 1.5s keeps the same deliberate margin as the build budget, and
# the previous 0.75s left almost none once a fallback was needed.
DEFAULT_REFRESH_BUDGET_SECONDS: float = 1.5

# Anchor writes are best-effort background work fired at run-end alongside
# response completion -- deliberately far below the shared background default
# so lock contention never adds perceptible latency
# to a turn. `min()` both documents the relationship and guarantees this never
# silently exceeds the shared default if it's ever lowered further.
ANCHOR_LOCK_TIMEOUT_SECONDS: float = min(0.2, BACKGROUND_WRITE_TIMEOUT_SECONDS)

_ANCHOR_FILENAME = "anchor.json"
# ---------------------------------------------------------------------------
# Session-scoped path resolution
# ---------------------------------------------------------------------------


def safe_session_dirname(session_id: str | None) -> str | None:
    """Validate a client-supplied `session_id` for use as a path segment.

    SECURITY GATE: `session_id` arrives over the wire on every `chat.send`.
    The shared canonical runtime-ID parser accepts only
    `[A-Za-z0-9._-]{1,128}` is accepted, and the traversal tokens `.`/`..` are
    explicitly rejected even though they'd otherwise match that class. Fails
    CLOSED -- any invalid input returns `None`, this never raises.
    """
    return try_parse_session_id(session_id)


def repo_anchor_path(config: RuntimeConfig, session_id: str | None) -> Path | None:
    """Resolve the per-session anchor file path, or `None` if unsafe/invalid.

    Defense-in-depth on top of `safe_session_dirname`: after joining, the
    resolved path is asserted to still be contained under the resolved anchors
    base directory. This catches a symlinked/relocated background-runtime-root
    or session dirname edge case the regex gate alone wouldn't.
    """
    safe_dirname = safe_session_dirname(session_id)
    if safe_dirname is None:
        return None
    anchors_base = resolve_background_runtime_root(config) / "repo-anchors"
    candidate = anchors_base / safe_dirname / _ANCHOR_FILENAME
    try:
        resolved = candidate.resolve()
        resolved_base = anchors_base.resolve()
    except OSError:
        return None
    if not resolved.is_relative_to(resolved_base):
        return None
    return resolved


# ---------------------------------------------------------------------------
# Anchor persistence
# ---------------------------------------------------------------------------


def read_repo_anchor(path: Path) -> RepoAnchor | None:
    """Read a persisted anchor, tolerating any missing/corrupt/stale shape.

    Never raises. A missing
    file is the expected bootstrap case and degrades to `None` SILENTLY. An
    anchor that *does* exist but is unusable -- an unreadable file, corrupt
    JSON, a non-object payload, or a non-integer/mismatched `schema_version` --
    also degrades to `None`, but emits one counts-only diagnostic (a fixed
    reason code, never the payload or path) so a genuinely broken anchor is
    distinguishable from "no anchor yet".
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None  # bootstrap: no prior anchor -- expected, not logged
    except OSError:
        _log_anchor_read_degraded("unreadable")
        return None
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError):
        _log_anchor_read_degraded("corrupt_json")
        return None
    anchor = _parse_anchor_payload(payload)
    if anchor is None:
        _log_anchor_read_degraded("unusable_shape")
    return anchor


def _parse_anchor_payload(payload: Any) -> RepoAnchor | None:
    if not isinstance(payload, dict):
        return None
    schema_version = coerce_optional_int(payload.get("schema_version"))
    if schema_version is None or schema_version != SCHEMA_VERSION:
        return None
    root = payload.get("root")
    head_sha = payload.get("head_sha")
    branch = payload.get("branch")
    # Shape gates as early returns so `root` is narrowed to `str` in-scope for the
    # RepoAnchor construction below (no separate helper + re-narrowing assert).
    if not isinstance(root, str) or not root:
        return None
    if head_sha is not None and not isinstance(head_sha, str):
        return None
    if branch is not None and not isinstance(branch, str):
        return None
    return RepoAnchor(
        head_sha=head_sha or None,
        branch=branch or None,
        root=root,
        schema_version=schema_version,
    )


def _atomic_write_anchor(path: Path, anchor: RepoAnchor) -> None:
    """Write `anchor` via temp-file-in-target-dir + `os.replace`.

    Mirrors `ollama_catalog_cache.py::_atomic_write_json`. Any `OSError`
    (including a Windows `PermissionError` from a concurrently-open handle) is
    swallowed -- the anchor is a regenerable derived cache, so a lost write
    just leaves the prior anchor in place for the next turn.
    """
    payload = {
        "schema_version": anchor.schema_version,
        "head_sha": anchor.head_sha,
        "branch": anchor.branch,
        "root": anchor.root,
    }
    # Not folded into utils.json_io.write_json_atomic: this site must log the
    # actual OSError and let serialization errors propagate, not swallow both.
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = path.with_name(f".{path.name}.tmp")
        temp_path.write_text(
            json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        os.replace(temp_path, path)
    except OSError as exc:
        _log_anchor_write_failed(exc)


def write_repo_anchor(path: Path, anchor: RepoAnchor) -> None:
    """Persist `anchor` under a short, best-effort lock. Never raises."""
    lock_path = path.with_name(f"{path.name}.lock")
    with acquire_regenerable_file_lock(
        lock_path, timeout_seconds=ANCHOR_LOCK_TIMEOUT_SECONDS
    ) as attempt:
        if not attempt.acquired:
            return
        _atomic_write_anchor(path, anchor)


# ---------------------------------------------------------------------------
# Turn-start / run-end orchestration
# ---------------------------------------------------------------------------


def _coerce_root(workspace_root: str | Path | None) -> Path | None:
    text = str(workspace_root or "").strip()
    if not text:
        return None
    return Path(text)


def _resolve_turn_start_positions(
    *,
    config: RuntimeConfig,
    session_id: str | None,
    workspace_root: str | Path | None,
    deadline: float,
) -> tuple[Path, RepoAnchor, RepoAnchor] | None:
    """Resolve `(root, anchor, current)` for a turn-start build, or `None` to skip.

    Centralizes the independent "nothing to do here" gates -- invalid
    session_id, no anchor yet (bootstrap, zero git spawns), an unreadable
    workspace_root, an unreadable current snapshot -- behind one early return
    for the caller instead of four.
    """
    anchor_path = repo_anchor_path(config, session_id)
    if anchor_path is None:
        return None
    anchor = read_repo_anchor(anchor_path)
    if anchor is None:
        return None  # bootstrap: no prior position, zero git spawns
    root = _coerce_root(workspace_root)
    if root is None:
        return None
    current = read_repo_snapshot(root, deadline=deadline)
    if current is None:
        return None
    return root, anchor, current


def build_repository_delta_block(
    *,
    config: RuntimeConfig,
    session_id: str | None,
    workspace_root: str | Path | None,
    budget_s: float = DEFAULT_BUILD_BUDGET_SECONDS,
) -> str | None:
    """Turn-start: render the `<repository-delta>` block, or `None`.

    `None` covers every non-error outcome too: flag off, invalid session_id,
    no anchor yet (bootstrap -- returns before any git spawn), or nothing
    changed since the anchor was last written (cheap short-circuit on raw
    `(head, branch, root)` equality, also before any git spawn beyond the one
    combined snapshot read). Any exception degrades to `None` plus a
    counts-only diagnostic log; this must never surface to the caller.
    """
    if not config.repo_delta_resume_enabled:
        return None
    try:
        deadline = time.monotonic() + max(budget_s, 0.0)
        positions = _resolve_turn_start_positions(
            config=config,
            session_id=session_id,
            workspace_root=workspace_root,
            deadline=deadline,
        )
        if positions is None:
            return None
        root, anchor, current = positions
        # Normalize each root exactly once -- `normalize_root` runs an
        # `os.path.realpath` syscall, so reuse `same_position`'s already-folded
        # normalized root (tuple element [2]) both for the no-op short-circuit
        # and as `compute_repo_delta`'s root-changed verdict, so realpath is not
        # re-run. `compute_repo_delta` owns delta construction for BOTH the
        # root-changed (git-free) and normal-diff cases.
        anchor_pos = anchor.same_position()
        current_pos = current.same_position()
        if anchor_pos == current_pos:
            return None  # nothing moved since the anchor was last written

        delta: RepoDelta | None = compute_repo_delta(
            root,
            anchor,
            current,
            MAX_COMMITS,
            deadline=deadline,
            root_changed=anchor_pos[2] != current_pos[2],  # [2] = normalized root
        )
        if delta is None or not delta.has_signal():
            return None

        _log_delta_detected(delta)
        return render_repository_delta_block(delta)
    except Exception as exc:  # noqa: BLE001 - a resume signal must never break a turn
        _log_build_failed(exc)
        return None


def refresh_repo_anchor(
    *,
    config: RuntimeConfig,
    session_id: str | None,
    workspace_root: str | Path | None,
    budget_s: float = DEFAULT_REFRESH_BUDGET_SECONDS,
) -> None:
    """Run-end: overwrite the anchor with the current repo position.

    Fail-closed: flag off, invalid session_id, an unreadable workspace, or any
    exception all degrade to a no-op. A skipped refresh is always safe -- the
    next turn's `build_repository_delta_block` just compares against a
    one-turn-stale anchor.
    """
    if not config.repo_delta_resume_enabled:
        return
    try:
        anchor_path = repo_anchor_path(config, session_id)
        if anchor_path is None:
            return
        root = _coerce_root(workspace_root)
        if root is None:
            return
        deadline = time.monotonic() + max(budget_s, 0.0)
        current = read_repo_snapshot(root, deadline=deadline)
        if current is None:
            return
        write_repo_anchor(anchor_path, current)
    except Exception as exc:  # noqa: BLE001 - anchor refresh must never break run-end
        # A distinct reason code from the write-syscall failure below: this outer
        # except also covers snapshot-read / path-resolution failures, which are
        # NOT writes -- mislabeling them `anchor_write_failed` misleads triage.
        _log_refresh_failed(exc)


# ---------------------------------------------------------------------------
# Diagnostics (AGENTS.md redaction: counts only -- never paths/branches/shas)
# ---------------------------------------------------------------------------


def _log_delta_detected(delta: RepoDelta) -> None:
    log_event(
        logger,
        logging.INFO,
        component="ai.repo_delta.service",
        event="ai.repo_delta.service.delta_detected",
        message="Repository delta detected at turn start",
        status="detected",
        data={
            "ahead": delta.ahead if isinstance(delta.ahead, int) else -1,
            "behind": delta.behind if isinstance(delta.behind, int) else -1,
            "commit_count": len(delta.commits),
            "files_total": delta.files_total,
            "root_changed": delta.root_changed,
            "history_rewritten": delta.history_rewritten,
        },
    )


def _log_anchor_read_degraded(reason: str) -> None:
    log_event(
        logger,
        logging.WARNING,
        component="ai.repo_delta.service",
        event="ai.repo_delta.service.anchor_read_degraded",
        message="Repository anchor read degraded to bootstrap",
        status="degraded",
        data={"reason": reason},
    )


def _log_failure(event: str, message: str, exc: BaseException) -> None:
    # Shared shape for the fail-closed WARNING loggers -- counts/reason only: the
    # error CLASS name, never its message or any repo-derived value (AGENTS.md §7).
    log_event(
        logger,
        logging.WARNING,
        component="ai.repo_delta.service",
        event=event,
        message=message,
        status="failed",
        data={"error_type": exc.__class__.__name__},
    )


def _log_build_failed(exc: BaseException) -> None:
    _log_failure("ai.repo_delta.service.build_failed", "Repository delta build failed", exc)


def _log_anchor_write_failed(exc: BaseException) -> None:
    _log_failure("ai.repo_delta.service.anchor_write_failed", "Repository anchor write failed", exc)


def _log_refresh_failed(exc: BaseException) -> None:
    _log_failure("ai.repo_delta.service.refresh_failed", "Repository anchor refresh failed", exc)


__all__ = [
    "ANCHOR_LOCK_TIMEOUT_SECONDS",
    "DEFAULT_BUILD_BUDGET_SECONDS",
    "DEFAULT_REFRESH_BUDGET_SECONDS",
    "SCHEMA_VERSION",
    "build_repository_delta_block",
    "read_repo_anchor",
    "refresh_repo_anchor",
    "repo_anchor_path",
    "safe_session_dirname",
    "write_repo_anchor",
]
