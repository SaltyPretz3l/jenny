"""Runtime workspace manifest generation and bounded in-process caching.

The bounded filesystem traversal itself lives in
:mod:`sidecar.ai.tools.workspace_manifest_scan` (WIDE-025); this module owns
project detection, git snapshotting, caching, and rendering/summarizing.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Callable, cast

from sidecar.ai.tools.builtins.owned_process import (
    OwnedProcessError,
    get_owned_process_service,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_manifest_policy import build_manifest_scan_policy
from sidecar.ai.tools.workspace_manifest_scan import (
    WorkspaceManifestLimits,  # noqa: F401 - re-exported public API.
    read_readme_excerpt,
    scan_workspace,
)
from sidecar.runtime.diagnostics import log_event, sanitize_diagnostic_text

logger = logging.getLogger(__name__)

MANIFEST_VERSION = 2
WORKSPACE_MANIFEST_PROMPT_HEADING = "## Workspace Manifest"
MANIFEST_GENERATED_LINE_PREFIX = "Generated: "
MANIFEST_PROJECT_TYPE_LINE_PREFIX = "Project type: "
MANIFEST_TOP_DIRS_LINE_PREFIX = "Top directories: "
MANIFEST_ENTRY_POINTS_LINE_PREFIX = "Entry points: "
MANIFEST_GIT_LINE_PREFIX = "Git: "
PROMPT_LIST_LIMIT = 6
HARNESS_ENTRY_POINT_LIMIT = 2
HARNESS_TOP_DIR_LIMIT = 3
# Per-command ceiling for the owned-process git transport (~8x the measured
# warm Windows spawn cost). Do NOT size this to a warm-cache measurement: a
# ceiling below real spawn cost makes every git command here "time out" and
# its correct result gets discarded. It exists only to bound a hung git.
MAX_GIT_COMMAND_SECONDS = 1.5
MIN_GIT_COMMAND_SECONDS = 0.05

# Fresh aggregate budget for the four-command snapshot (~3x the measured
# process-cold run). The margin is deliberately asymmetric: an under-sized
# budget silently reports an unmeasured working tree, while an over-sized one
# only costs a bounded wait when git is genuinely wedged.
MANIFEST_GIT_BUDGET_SECONDS = 4.0

# Why a git field is unknown. "budget_exhausted" is only claimed when the budget
# was actually checked and found spent; a git command that failed for any other
# reason reports the neutral cause rather than guessing.
GIT_REASON_BUDGET_EXHAUSTED = "budget_exhausted"
GIT_REASON_COMMAND_FAILED = "command_failed"


@dataclass(frozen=True)
class _CacheEntry:
    generated_at_monotonic: float
    payload: dict[str, object]


def _default_manifest_generator(root: Path) -> dict[str, object]:
    return build_workspace_manifest(root)


def _object_dict(value: object) -> dict[str, object]:
    if isinstance(value, dict):
        return cast(dict[str, object], value)
    return {}


_PROJECT_MARKERS: tuple[tuple[str, str], ...] = (
    ("package.json", "node"),
    ("pnpm-lock.yaml", "node"),
    ("yarn.lock", "node"),
    ("pyproject.toml", "python"),
    ("setup.py", "python"),
    ("requirements.txt", "python"),
    ("Pipfile", "python"),
    ("Cargo.toml", "rust"),
    ("go.mod", "go"),
    ("pom.xml", "java"),
    ("build.gradle", "java"),
    ("build.gradle.kts", "java"),
    ("composer.json", "php"),
    ("Gemfile", "ruby"),
)

_AHEAD_RE = re.compile(r"\bahead (?P<count>\d+)\b")
_BEHIND_RE = re.compile(r"\bbehind (?P<count>\d+)\b")


class WorkspaceManifestCache:
    """Bounded manifest cache keyed by resolved workspace root."""

    def __init__(
        self,
        *,
        generator: Callable[[Path], dict[str, object]] | None = None,
        clock: Callable[[], float] = time.monotonic,
        max_roots: int = 4,
        soft_ttl_seconds: float = 30.0,
        hard_ttl_seconds: float = 300.0,
    ) -> None:
        self._generator = generator if generator is not None else _default_manifest_generator
        self._clock = clock
        self._max_roots = max(1, int(max_roots))
        self._soft_ttl_seconds = max(0.0, float(soft_ttl_seconds))
        self._hard_ttl_seconds = max(self._soft_ttl_seconds, float(hard_ttl_seconds))
        self._entries: OrderedDict[str, _CacheEntry] = OrderedDict()
        self._refreshing: set[str] = set()
        self._lock = threading.RLock()

    def read(self, workspace_root: str | Path | None) -> dict[str, object]:
        root = _resolve_workspace_root(workspace_root)
        if root is None:
            return _error_payload("tools workspace root is not configured")
        key = str(root)
        now = self._clock()

        with self._lock:
            entry = self._entries.get(key)
            if entry is not None:
                age = now - entry.generated_at_monotonic
                if age < self._soft_ttl_seconds:
                    self._entries.move_to_end(key)
                    return _copy_payload(entry.payload)
                if age < self._hard_ttl_seconds:
                    self._entries.move_to_end(key)
                    self._refresh_async(root, key)
                    return _copy_payload(entry.payload)

        return self._refresh_sync(root, key)

    def _refresh_sync(self, root: Path, key: str) -> dict[str, object]:
        payload = _safe_generate(self._generator, root)
        self._store(key, payload)
        return _copy_payload(payload)

    def _refresh_async(self, root: Path, key: str) -> None:
        if key in self._refreshing:
            return
        self._refreshing.add(key)
        thread = threading.Thread(
            target=self._refresh_worker,
            args=(root, key),
            name="workspace-manifest-refresh",
            daemon=True,
        )
        thread.start()

    def _refresh_worker(self, root: Path, key: str) -> None:
        try:
            payload = _safe_generate(self._generator, root)
            self._store(key, payload)
        finally:
            with self._lock:
                self._refreshing.discard(key)

    def _store(self, key: str, payload: dict[str, object]) -> None:
        with self._lock:
            self._entries[key] = _CacheEntry(
                generated_at_monotonic=self._clock(),
                payload=_copy_payload(payload),
            )
            self._entries.move_to_end(key)
            while len(self._entries) > self._max_roots:
                self._entries.popitem(last=False)


_CACHE = WorkspaceManifestCache()


def get_workspace_manifest_cache() -> WorkspaceManifestCache:
    return _CACHE


def build_workspace_manifest(
    workspace_root: str | Path | None,
    *,
    limits: WorkspaceManifestLimits | None = None,
    clock: Callable[[], float] | None = None,
) -> dict[str, object]:
    """Generate a best-effort JSON-serializable workspace manifest.

    ``clock`` (default ``time.monotonic``) drives every budget deadline so the
    elapsed-time contract is testable without real waiting.
    """
    root = _resolve_workspace_root(workspace_root)
    if root is None:
        return _error_payload("tools workspace root is not configured")
    try:
        return _build_workspace_manifest(
            root,
            limits=limits or WorkspaceManifestLimits(),
            clock=clock if clock is not None else time.monotonic,
        )
    except Exception as exc:  # noqa: BLE001 - generator failures are fail-soft by contract.
        _log_generate_failure(root, exc)
        return _error_payload(
            sanitize_diagnostic_text(str(exc), limit=180) or exc.__class__.__name__,
            root=root,
        )


def render_workspace_manifest_block(workspace_root: str | Path | None) -> str:
    if workspace_root is None:
        return ""
    manifest = get_workspace_manifest_cache().read(workspace_root)
    if _manifest_error(manifest):
        return ""

    project_type = _join_limited_strings(manifest.get("project_type"), fallback="unknown")
    top_dirs = _top_dir_names(manifest.get("top_dirs"), limit=PROMPT_LIST_LIMIT)
    entry_points = _string_list(manifest.get("entry_points"), limit=PROMPT_LIST_LIMIT)
    git = _object_dict(manifest.get("git"))
    totals = _object_dict(manifest.get("totals"))
    partial = " (partial)" if bool(totals.get("truncated")) else ""

    lines = [
        WORKSPACE_MANIFEST_PROMPT_HEADING,
        f"{MANIFEST_GENERATED_LINE_PREFIX}"
        f"{_string_value(manifest.get('generated_at'), 'unknown')}{partial}",
        f"{MANIFEST_PROJECT_TYPE_LINE_PREFIX}{project_type}",
        f"{MANIFEST_TOP_DIRS_LINE_PREFIX}{_format_list(top_dirs)}",
        f"{MANIFEST_ENTRY_POINTS_LINE_PREFIX}{_format_list(entry_points)}",
    ]
    git_line = _git_prompt_line(git)
    if git_line:
        lines.append(git_line)
    lines.append("Use workspace_manifest_read for full JSON detail when needed.")
    return "\n".join(lines)


def _git_prompt_line(git: dict[str, object]) -> str:
    """Render git state, or say it is unknown -- never imply a clean tree."""
    if not git.get("available"):
        # A confirmed non-repo stays silent, as before. A snapshot that never
        # ran must say so rather than look identical to "not a repository".
        if git.get("known", True):
            return ""
        return f"{MANIFEST_GIT_LINE_PREFIX}state unknown (git snapshot did not complete)"
    branch = _string_value(git.get("branch"), "unknown")
    dirty_count = _optional_int(git.get("dirty_count"))
    if dirty_count is None:
        return f"{MANIFEST_GIT_LINE_PREFIX}{branch}, changed files unknown (git status did not complete)"
    return f"{MANIFEST_GIT_LINE_PREFIX}{branch}, {dirty_count} changed files"


def summarize_workspace_manifest(manifest: dict[str, object]) -> dict[str, object]:
    if _manifest_error(manifest):
        return {
            "available": False,
            "error": _string_value(manifest.get("error"), "manifest unavailable"),
        }
    git = _object_dict(manifest.get("git"))
    totals = _object_dict(manifest.get("totals"))
    # None here means "not measured". Collapsing it to 0 would tell the model a
    # dirty tree is clean, so the unknown-ness is carried through explicitly.
    dirty_count = _optional_int(git.get("dirty_count"))
    return {
        "available": True,
        "generated_at": _string_value(manifest.get("generated_at"), ""),
        "project_type": _string_list(manifest.get("project_type")),
        "project_markers": _string_list(manifest.get("project_markers")),
        "entry_points": _string_list(
            manifest.get("entry_points"),
            limit=HARNESS_ENTRY_POINT_LIMIT,
        ),
        "top_dirs": _top_dir_names(manifest.get("top_dirs"), limit=HARNESS_TOP_DIR_LIMIT),
        "git": {
            "branch": _string_value(git.get("branch"), ""),
            "dirty_count": dirty_count,
            "dirty_count_known": dirty_count is not None,
        },
        "totals": {
            "files_scanned": _int_value(totals.get("files_scanned"), 0),
            "truncated": bool(totals.get("truncated", False)),
        },
    }


def _build_workspace_manifest(
    root: Path,
    *,
    limits: WorkspaceManifestLimits,
    clock: Callable[[], float],
) -> dict[str, object]:
    generated_at = _utc_now()
    project_markers, project_type = _detect_project(root)
    readme_excerpt = read_readme_excerpt(root)
    policy = build_manifest_scan_policy(
        root,
        timeout_seconds=max(0.0, limits.inventory_budget_seconds),
    )
    scan = scan_workspace(root, limits, policy=policy, clock=clock)
    orientation_diagnostics = _object_dict(scan.get("orientation_diagnostics"))
    _log_orientation_degradation(root, orientation_diagnostics)
    # Fresh deadline, computed AFTER the scan rather than shared with it. The
    # scan owns wall_budget_seconds and stops only when it trips that budget, so
    # a deadline anchored at generation start reaches this line with nothing
    # left on any repo large enough to matter -- git would then be skipped
    # entirely and the snapshot would report an unmeasured tree as clean.
    git_deadline = clock() + max(MIN_GIT_COMMAND_SECONDS, limits.git_budget_seconds)
    return {
        "version": MANIFEST_VERSION,
        "root": str(root),
        "generated_at": generated_at,
        "project_type": project_type,
        "project_markers": project_markers,
        "readme_excerpt": readme_excerpt,
        "top_dirs": scan["top_dirs"],
        "extension_counts": scan["extension_counts"],
        "entry_points": scan["entry_points"],
        "recent_files": scan["recent_files"],
        "classification_counts": scan["classification_counts"],
        "ranked_files": scan["ranked_files"],
        "git": _build_git_snapshot(root, deadline_monotonic=git_deadline, clock=clock),
        "totals": {
            "files_scanned": scan["files_scanned"],
            "entries_scanned": scan["entries_scanned"],
            "directories_scanned": scan["directories_scanned"],
            "entries_skipped": scan["entries_skipped"],
            "links_skipped": scan["links_skipped"],
            "orientation_excluded_entries": scan["orientation_excluded_entries"],
            "truncated": scan["truncated"],
            "truncation_reason": scan["truncation_reason"],
            "totals_known": scan["totals_known"],
            "cursor": scan["cursor"],
        },
        "diagnostics": {"orientation": orientation_diagnostics},
    }


def _detect_project(root: Path) -> tuple[list[str], list[str]]:
    markers: list[str] = []
    project_types: list[str] = []
    seen_types: set[str] = set()
    for marker, project_type in _PROJECT_MARKERS:
        if (root / marker).exists():
            markers.append(marker)
            if project_type not in seen_types:
                project_types.append(project_type)
                seen_types.add(project_type)
    return markers, project_types


def _utc_now() -> str:
    return datetime.now(tz=UTC).isoformat().replace("+00:00", "Z")


def _build_git_snapshot(
    root: Path,
    *,
    deadline_monotonic: float | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, object]:
    """Snapshot git state, reporting unknown fields as ``None`` -- never as zero.

    ``known`` is False whenever any command did not return, and every field it
    would have produced stays ``None``. An unmeasured working tree must never be
    rendered as a clean one: absence and zero are different claims, and only one
    of them is true when the budget runs out.
    """
    inside = _run_git(
        root,
        "rev-parse",
        "--is-inside-work-tree",
        deadline_monotonic=deadline_monotonic,
        clock=clock,
    )
    if inside is None:
        # The check itself did not run, so repo-ness was never established.
        # Returning a bare {"available": False} here would assert "not a git
        # repository" on evidence we do not have.
        return {
            "available": False,
            "known": False,
            "degraded_reason": _git_unknown_reason(deadline_monotonic, clock=clock),
        }
    if inside != "true":
        return {"available": False, "known": True}

    branch = _run_git(
        root,
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
        deadline_monotonic=deadline_monotonic,
        clock=clock,
    )
    head_sha7 = _run_git(
        root,
        "rev-parse",
        "--short=7",
        "HEAD",
        deadline_monotonic=deadline_monotonic,
        clock=clock,
    )
    status = _run_git(
        root,
        "status",
        "--porcelain=v1",
        "--branch",
        deadline_monotonic=deadline_monotonic,
        clock=clock,
    )
    # ahead/behind/dirty_count all derive from the single status call and so
    # share its fate: measured together, or unknown together.
    if status is None:
        ahead: int | None = None
        behind: int | None = None
        dirty_count: int | None = None
    else:
        ahead, behind = _parse_ahead_behind(status)
        dirty_count = sum(
            1 for line in status.splitlines() if line.strip() and not line.startswith("##")
        )

    known = None not in (branch, head_sha7, status)
    snapshot: dict[str, object] = {
        "available": True,
        "known": known,
        "branch": branch,
        "ahead": ahead,
        "behind": behind,
        "dirty_count": dirty_count,
        "head_sha7": head_sha7,
    }
    if not known:
        snapshot["degraded_reason"] = _git_unknown_reason(deadline_monotonic, clock=clock)
    return snapshot


def _git_unknown_reason(
    deadline_monotonic: float | None,
    *,
    clock: Callable[[], float] = time.monotonic,
) -> str:
    """Name the cause of an unknown git field without guessing at it."""
    if _git_command_timeout(deadline_monotonic, clock=clock) is None:
        return GIT_REASON_BUDGET_EXHAUSTED
    return GIT_REASON_COMMAND_FAILED


def _run_git(
    root: Path,
    *args: str,
    deadline_monotonic: float | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> str | None:
    timeout_seconds = _git_command_timeout(deadline_monotonic, clock=clock)
    if timeout_seconds is None:
        return None
    try:
        completed = get_owned_process_service().run(
            ["git", "-C", str(root), *args],
            cwd=root,
            timeout_seconds=timeout_seconds,
        )
    except (OSError, OwnedProcessError):
        return None
    if (
        completed.returncode != 0
        or completed.timed_out
        or completed.aborted
        or getattr(completed, "drain_incomplete", False)
        or completed.output.truncated
    ):
        return None
    return completed.stdout.strip()


def _git_command_timeout(
    deadline_monotonic: float | None,
    *,
    clock: Callable[[], float] = time.monotonic,
) -> float | None:
    if deadline_monotonic is None:
        return MAX_GIT_COMMAND_SECONDS
    remaining = deadline_monotonic - clock()
    if remaining < MIN_GIT_COMMAND_SECONDS:
        return None
    return min(MAX_GIT_COMMAND_SECONDS, remaining)


def _parse_ahead_behind(status: str) -> tuple[int, int]:
    first_line = next((line for line in status.splitlines() if line.startswith("##")), "")
    ahead_match = _AHEAD_RE.search(first_line)
    behind_match = _BEHIND_RE.search(first_line)
    ahead = int(ahead_match.group("count")) if ahead_match else 0
    behind = int(behind_match.group("count")) if behind_match else 0
    return ahead, behind


def _resolve_workspace_root(workspace_root: str | Path | None) -> Path | None:
    if workspace_root is None:
        return None
    try:
        return WorkspaceGuard(str(workspace_root)).require_root()
    except ToolExecutionFailure:
        return None


def _safe_generate(
    generator: Callable[[Path], dict[str, object]],
    root: Path,
) -> dict[str, object]:
    try:
        return generator(root)
    except Exception as exc:  # noqa: BLE001 - cache must fail soft.
        _log_generate_failure(root, exc)
        return _error_payload(
            sanitize_diagnostic_text(str(exc), limit=180) or exc.__class__.__name__,
            root=root,
        )


def _error_payload(message: str, *, root: Path | None = None) -> dict[str, object]:
    payload: dict[str, object] = {
        "version": MANIFEST_VERSION,
        "generated_at": _utc_now(),
        "error": message,
    }
    if root is not None:
        payload["root"] = str(root)
    return payload


def _log_generate_failure(root: Path, exc: BaseException) -> None:
    log_event(
        logger,
        logging.WARNING,
        component="ai.tools.workspace_manifest",
        event="ai.tools.workspace_manifest.generate_failed",
        message="Workspace manifest generation failed",
        status="failed",
        data={
            "root_hash": _hash_root(root),
            "error_type": exc.__class__.__name__,
            "message": sanitize_diagnostic_text(str(exc), limit=180),
        },
    )


def _log_orientation_degradation(root: Path, diagnostics: dict[str, object]) -> None:
    inventory = _object_dict(diagnostics.get("inventory"))
    raw_sources = diagnostics.get("ignore_sources")
    source_rows = raw_sources if isinstance(raw_sources, list) else []
    source_failures = [
        {
            "name": _string_value(source.get("name"), "unknown"),
            "status": _string_value(source.get("status"), "unknown"),
        }
        for raw_source in source_rows
        if isinstance(raw_source, dict)
        for source in [_object_dict(raw_source)]
        if source.get("status") not in {"git", "loaded", "missing"}
    ]
    if inventory.get("status") != "degraded" and not source_failures:
        return
    log_event(
        logger,
        logging.WARNING,
        component="ai.tools.workspace_manifest",
        event="ai.tools.workspace_manifest.orientation_degraded",
        message="Workspace orientation policy degraded to a bounded fallback.",
        status="degraded",
        data={
            "root_hash": _hash_root(root),
            "inventory_reason": inventory.get("degraded_reason"),
            "ignore_sources": source_failures,
        },
    )


def _hash_root(root: Path) -> str:
    return hashlib.sha256(str(root).encode("utf-8", errors="replace")).hexdigest()[:16]


def _copy_payload(payload: dict[str, object]) -> dict[str, object]:
    return json.loads(json.dumps(payload, ensure_ascii=False))


def _manifest_error(manifest: dict[str, object]) -> bool:
    return bool(manifest.get("error"))


def _string_list(value: object, *, limit: int | None = None) -> list[str]:
    if not isinstance(value, list):
        return []
    items = [item for item in value if isinstance(item, str) and item.strip()]
    if limit is not None:
        return items[:limit]
    return items


def _top_dir_names(value: object, *, limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    names: list[str] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if isinstance(name, str) and name.strip():
            names.append(name)
    return names[:limit]


def _join_limited_strings(value: object, *, fallback: str) -> str:
    items = _string_list(value, limit=PROMPT_LIST_LIMIT)
    return ", ".join(items) if items else fallback


def _format_list(items: list[str]) -> str:
    return ", ".join(items) if items else "none detected"


def _string_value(value: object, fallback: str) -> str:
    return value if isinstance(value, str) and value.strip() else fallback


def _int_value(value: object, fallback: int) -> int:
    if isinstance(value, bool):
        return fallback
    if isinstance(value, int):
        return value
    return fallback


def _optional_int(value: object) -> int | None:
    """Return the int, or ``None`` for anything that is not a measured count."""
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value
