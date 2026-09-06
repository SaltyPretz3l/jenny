"""Bounded iterative workspace scanning for manifest generation.

Traversal is iterative and enforces entry, directory, depth, wall-clock,
link-refusal, bounded-README, and truthful-truncation contracts.
"""

from __future__ import annotations

import os
import re
import stat as stat_module
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Callable, Iterable

from sidecar.ai.tools.builtins.filesystem import SEARCH_IGNORE_DIRS, workspace_relative_path
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_manifest_policy import (
    ManifestScanPolicy,
    RankedFileCandidate,
    build_manifest_scan_policy,
    empty_classification_counts,
    make_ranked_file_candidate,
    order_ranked_files,
)
from sidecar.ai.tools.workspace_path_identity import is_link_object

README_MAX_CHARS = 400
# Bounded prefix pulled from disk for the README excerpt. The excerpt itself is
# capped at README_MAX_CHARS; reading a small multiple of that is enough to
# survive whitespace collapsing without ever loading a huge README.
README_MAX_READ_BYTES = 8_192
RECENT_FILE_LIMIT = 10
ENTRY_POINT_LIMIT = 12
TOP_DIR_LIMIT = 12
EXTENSION_COUNT_LIMIT = 20
_WINDOWS_REPARSE_POINT_ATTRIBUTE = 0x400

TRUNCATION_ENTRY_BUDGET = "entry_budget"
TRUNCATION_DIRECTORY_BUDGET = "directory_budget"
TRUNCATION_TIME_BUDGET = "time_budget"
TRUNCATION_DEPTH_BUDGET = "depth_budget"


@dataclass(frozen=True)
class WorkspaceManifestLimits:
    """Budgets for one manifest generation.

    ``wall_budget_seconds`` bounds the filesystem traversal in this module.
    ``inventory_budget_seconds`` bounds the pre-scan Git inventory used only for
    orientation filtering. ``git_budget_seconds`` independently bounds the Git
    working-tree snapshot, which runs afterwards in
    :mod:`sidecar.ai.tools.workspace_manifest` and gets its OWN deadline: the
    scan expands to fill whatever wall budget it is given (it stops on
    ``time_budget``), so any deadline shared with the scan reaches Git already
    spent. See ``MANIFEST_GIT_BUDGET_SECONDS`` for how the snapshot default is
    sized.
    """

    max_entries: int = 5_000
    max_depth: int = 4
    wall_budget_seconds: float = 1.0
    max_directories: int = 2_000
    git_budget_seconds: float = 4.0
    inventory_budget_seconds: float = 1.5


_ENTRY_POINT_PRIORITY: tuple[str, ...] = (
    "src/index.ts",
    "src/index.tsx",
    "src/index.js",
    "src/main.ts",
    "src/main.tsx",
    "src/main.js",
    "main.py",
    "app.py",
    "server.py",
    "index.js",
    "main.js",
    "package.json",
    "pyproject.toml",
)

_ENTRY_POINT_NAMES = frozenset(
    {
        "main.py",
        "app.py",
        "server.py",
        "manage.py",
        "index.js",
        "index.ts",
        "index.tsx",
        "main.js",
        "main.ts",
        "main.tsx",
    }
)

_TEXT_CODE_EXTENSIONS = frozenset(
    {
        ".bat",
        ".c",
        ".cfg",
        ".cmd",
        ".cpp",
        ".cs",
        ".css",
        ".csv",
        ".go",
        ".h",
        ".hpp",
        ".htm",
        ".html",
        ".ini",
        ".java",
        ".js",
        ".json",
        ".jsx",
        ".kt",
        ".log",
        ".lua",
        ".mjs",
        ".md",
        ".php",
        ".ps1",
        ".py",
        ".rb",
        ".rs",
        ".sh",
        ".sql",
        ".toml",
        ".ts",
        ".tsx",
        ".txt",
        ".xml",
        ".yaml",
        ".yml",
    }
)

_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


@dataclass
class _ScanState:
    extension_counts: dict[str, int] = field(default_factory=dict)
    top_dirs: dict[str, dict[str, int]] = field(default_factory=dict)
    entry_points: set[str] = field(default_factory=set)
    recent_candidates: list[tuple[float, str]] = field(default_factory=list)
    files_scanned: int = 0
    entries_scanned: int = 0
    directories_scanned: int = 0
    entries_skipped: int = 0
    links_skipped: int = 0
    orientation_excluded_entries: int = 0
    classification_counts: dict[str, int] = field(default_factory=empty_classification_counts)
    ranked_candidates: list[RankedFileCandidate] = field(default_factory=list)
    truncation_reason: str | None = None
    halted: bool = False
    resume_at: Path | None = None

    def note_truncation(self, reason: str, *, halt: bool) -> None:
        if self.truncation_reason is None:
            self.truncation_reason = reason
        if halt:
            self.halted = True


def scan_workspace(
    root: Path,
    limits: WorkspaceManifestLimits,
    *,
    policy: ManifestScanPolicy | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, object]:
    """Iteratively scan ``root`` under explicit entry/directory/time budgets.

    Traversal is breadth-first over an explicit queue consumed via a head
    index — never ``os.walk``, never a full directory materialization — and
    every budget is enforced while iterating, so tripping a cap stops the
    remaining work rather than merely truncating already-computed results.
    """
    workspace = WorkspaceGuard(str(root))
    active_policy = policy or build_manifest_scan_policy(
        root,
        timeout_seconds=limits.inventory_budget_seconds,
    )
    state = _ScanState()
    deadline = clock() + max(0.001, limits.wall_budget_seconds)
    max_entries = max(1, limits.max_entries)
    max_directories = max(1, limits.max_directories)
    queue: list[tuple[Path, int]] = [(root, 0)]
    head = 0

    while head < len(queue) and not state.halted:
        if state.directories_scanned >= max_directories:
            state.resume_at = queue[head][0]
            state.note_truncation(TRUNCATION_DIRECTORY_BUDGET, halt=True)
            break
        if clock() >= deadline:
            state.resume_at = queue[head][0]
            state.note_truncation(TRUNCATION_TIME_BUDGET, halt=True)
            break
        current, depth = queue[head]
        head += 1
        state.directories_scanned += 1
        _scan_one_directory(
            current=current,
            depth=depth,
            root=root,
            workspace=workspace,
            limits=limits,
            state=state,
            queue=queue,
            deadline=deadline,
            clock=clock,
            max_entries=max_entries,
            policy=active_policy,
        )

    return {
        "top_dirs": _ordered_top_dirs(state.top_dirs),
        "extension_counts": _ordered_extension_counts(state.extension_counts),
        "entry_points": _ordered_entry_points(state.entry_points),
        "recent_files": _ordered_recent_files(state.recent_candidates),
        "classification_counts": dict(state.classification_counts),
        "ranked_files": order_ranked_files(state.ranked_candidates),
        "files_scanned": state.files_scanned,
        "entries_scanned": state.entries_scanned,
        "directories_scanned": state.directories_scanned,
        "entries_skipped": state.entries_skipped,
        "links_skipped": state.links_skipped,
        "orientation_excluded_entries": state.orientation_excluded_entries,
        "truncated": state.truncation_reason is not None,
        "truncation_reason": state.truncation_reason,
        "totals_known": state.truncation_reason is None,
        "cursor": _build_cursor(queue=queue, head=head, root=root, state=state),
        "orientation_diagnostics": active_policy.diagnostics(
            excluded_entries=state.orientation_excluded_entries,
            ranked_candidates=len(state.ranked_candidates),
        ),
    }


def _scan_one_directory(  # noqa: PLR0913 - explicit traversal seam.
    *,
    current: Path,
    depth: int,
    root: Path,
    workspace: WorkspaceGuard,
    limits: WorkspaceManifestLimits,
    state: _ScanState,
    queue: list[tuple[Path, int]],
    deadline: float,
    clock: Callable[[], float],
    max_entries: int,
    policy: ManifestScanPolicy,
) -> None:
    try:
        with os.scandir(current) as entries:
            for entry in entries:
                if clock() >= deadline:
                    state.resume_at = current
                    state.note_truncation(TRUNCATION_TIME_BUDGET, halt=True)
                    return
                classified = _classify_entry(entry)
                if classified is None:
                    # One bad dirent (permission error, raced delete, ...) must
                    # not fail the whole scan — same isolation as list_dir.
                    state.entries_skipped += 1
                    continue
                is_link, is_directory, is_file = classified
                if is_link:
                    # Reparse points / symlinked entries are refused, never
                    # followed; the scan continues past them.
                    state.links_skipped += 1
                    continue
                if _skip_orientation_entry(
                    entry=entry,
                    root=root,
                    is_directory=is_directory,
                    policy=policy,
                    state=state,
                ):
                    continue
                if state.entries_scanned >= max_entries:
                    state.resume_at = current
                    state.note_truncation(TRUNCATION_ENTRY_BUDGET, halt=True)
                    return
                state.entries_scanned += 1
                try:
                    resolved = workspace.ensure_within_root(Path(entry.path))
                except ToolExecutionFailure:
                    state.entries_skipped += 1
                    continue
                if is_directory:
                    _record_top_dir(state.top_dirs, resolved, root, is_dir=True)
                    if depth >= limits.max_depth:
                        # Prune (do not descend). Completeness is lost, but the
                        # scan itself keeps going — depth is not a hard stop.
                        state.note_truncation(TRUNCATION_DEPTH_BUDGET, halt=False)
                        continue
                    queue.append((resolved, depth + 1))
                elif is_file:
                    _record_file_entry(entry=entry, resolved=resolved, root=root, state=state)
    except OSError:
        # One unreadable directory must not fail the manifest; isolate it.
        state.entries_skipped += 1


def _classify_entry(entry: os.DirEntry[str]) -> tuple[bool, bool, bool] | None:
    """Classify one dirent from its cached metadata; ``None`` isolates a failure.

    Link detection mirrors ``workspace_path_identity.is_link_object`` (symlink
    or Windows reparse attribute) but runs on the scandir-cached ``DirEntry``
    so the traversal does not pay an extra ``stat`` per entry.
    """
    try:
        is_link = entry.is_symlink()
        if not is_link and os.name == "nt":
            attributes = getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0)
            is_link = bool(int(attributes) & _WINDOWS_REPARSE_POINT_ATTRIBUTE)
        return (
            is_link,
            entry.is_dir(follow_symlinks=False),
            entry.is_file(follow_symlinks=False),
        )
    except OSError:
        return None


def _skip_orientation_entry(
    *,
    entry: os.DirEntry[str],
    root: Path,
    is_directory: bool,
    policy: ManifestScanPolicy,
    state: _ScanState,
) -> bool:
    if is_directory and _ignored_directory_name(entry.name):
        return True
    relative_path = _lexical_relative_path(Path(entry.path), root)
    if policy.allows(relative_path, is_directory=is_directory):
        return False
    state.orientation_excluded_entries += 1
    return True


def _ignored_directory_name(name: str) -> bool:
    candidate = os.path.normcase(name) if os.name == "nt" else name
    ignored = (
        {os.path.normcase(value) for value in SEARCH_IGNORE_DIRS}
        if os.name == "nt"
        else SEARCH_IGNORE_DIRS
    )
    return candidate in ignored


def _build_cursor(
    *,
    queue: list[tuple[Path, int]],
    head: int,
    root: Path,
    state: _ScanState,
) -> dict[str, object] | None:
    """Describe where a halted scan stopped so callers can tell what was skipped.

    ``None`` means the traversal itself ran to completion (though depth pruning
    may still have marked it truncated). ``next_directory`` is the directory
    where work stopped — partially scanned if a budget tripped mid-listing —
    and ``pending_directories`` counts discovered-but-unvisited directories.
    """
    if not state.halted:
        return None
    next_directory = (
        workspace_relative_path(state.resume_at, root) if state.resume_at is not None else None
    )
    return {
        "next_directory": next_directory,
        "pending_directories": max(0, len(queue) - head),
    }


def _record_file_entry(
    *,
    entry: os.DirEntry[str],
    resolved: Path,
    root: Path,
    state: _ScanState,
) -> None:
    state.files_scanned += 1
    _record_top_dir(state.top_dirs, resolved, root, is_dir=False)
    relative_path = workspace_relative_path(resolved, root)
    extension = resolved.suffix.lower()
    if extension:
        state.extension_counts[extension] = state.extension_counts.get(extension, 0) + 1
    is_entry_point = _looks_like_entry_point(relative_path, resolved.name)
    if is_entry_point:
        state.entry_points.add(relative_path)
    candidate = make_ranked_file_candidate(relative_path, is_entry_point=is_entry_point)
    state.classification_counts[candidate.classification] += 1
    state.ranked_candidates.append(candidate)
    if _is_text_or_code_path(resolved):
        state.recent_candidates.append((_entry_mtime(entry), relative_path))


def _entry_mtime(entry: os.DirEntry[str]) -> float:
    try:
        return entry.stat(follow_symlinks=False).st_mtime
    except OSError:
        return 0.0


def _lexical_relative_path(path: Path, root: Path) -> str:
    """Return a normalized lexical path for pre-budget policy filtering."""
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.name


def read_readme_excerpt(root: Path) -> str:
    """Return a bounded README excerpt without ever reading the whole file."""
    try:
        candidates = sorted(root.glob("README*"), key=lambda path: path.name.lower())
    except OSError:
        return ""
    for candidate in candidates:
        excerpt = _read_bounded_readme_prefix(candidate)
        if excerpt is not None:
            return excerpt
    return ""


def _read_bounded_readme_prefix(candidate: Path) -> str | None:
    """Read at most README_MAX_READ_BYTES from a regular, non-link README.

    The open is no-follow style: links are refused up front via the existing
    ``is_link_object`` helper, ``O_NOFOLLOW`` is applied where the platform
    supports it, and the opened handle is fstat-verified to be a regular file
    before the single bounded ``os.read``.
    """
    try:
        if is_link_object(candidate):
            return None
    except ToolExecutionFailure:
        return None
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(str(candidate), flags)
    except OSError:
        return None
    try:
        if not stat_module.S_ISREG(os.fstat(fd).st_mode):
            return None
        data = os.read(fd, README_MAX_READ_BYTES)
    except OSError:
        return None
    finally:
        os.close(fd)
    return _truncate_excerpt(_normalize_excerpt(data.decode("utf-8", errors="replace")))


def _normalize_excerpt(content: str) -> str:
    cleaned = _CONTROL_CHARS_RE.sub(" ", content)
    return " ".join(cleaned.split())


def _truncate_excerpt(content: str) -> str:
    if len(content) <= README_MAX_CHARS:
        return content
    cutoff = content.rfind(" ", 0, README_MAX_CHARS)
    if cutoff < README_MAX_CHARS // 2:
        cutoff = README_MAX_CHARS
    return f"{content[:cutoff].rstrip()}..."


def _record_top_dir(
    top_dirs: dict[str, dict[str, int]],
    path: Path,
    root: Path,
    *,
    is_dir: bool,
) -> None:
    relative = workspace_relative_path(path, root)
    if not is_dir and "/" not in relative:
        return
    first = relative.split("/", 1)[0]
    if not first or first == ".":
        return
    stats = top_dirs.setdefault(first, {"files": 0, "subdirs": 0})
    if is_dir:
        stats["subdirs"] += 1
    else:
        stats["files"] += 1


def _ordered_top_dirs(top_dirs: dict[str, dict[str, int]]) -> list[dict[str, int | str]]:
    items = sorted(
        top_dirs.items(),
        key=lambda item: (-(item[1]["files"] + item[1]["subdirs"]), item[0].lower()),
    )
    return [
        {"name": name, "files": stats["files"], "subdirs": stats["subdirs"]}
        for name, stats in items[:TOP_DIR_LIMIT]
    ]


def _ordered_extension_counts(extension_counts: dict[str, int]) -> dict[str, int]:
    items = sorted(extension_counts.items(), key=lambda item: (-item[1], item[0]))
    return dict(items[:EXTENSION_COUNT_LIMIT])


def _looks_like_entry_point(relative_path: str, file_name: str) -> bool:
    return relative_path in _ENTRY_POINT_PRIORITY or file_name in _ENTRY_POINT_NAMES


def _ordered_entry_points(entry_points: Iterable[str]) -> list[str]:
    priority = {path: index for index, path in enumerate(_ENTRY_POINT_PRIORITY)}
    return sorted(
        entry_points,
        key=lambda path: (priority.get(path, len(priority)), path.lower()),
    )[:ENTRY_POINT_LIMIT]


def _ordered_recent_files(recent_candidates: list[tuple[float, str]]) -> list[dict[str, str]]:
    ordered = sorted(recent_candidates, key=lambda item: (-item[0], item[1].lower()))
    return [
        {"path": path, "mtime": _timestamp_from_epoch(mtime)}
        for mtime, path in ordered[:RECENT_FILE_LIMIT]
    ]


def _is_text_or_code_path(path: Path) -> bool:
    if path.name.lower().startswith("readme"):
        return True
    return path.suffix.lower() in _TEXT_CODE_EXTENSIONS


def _timestamp_from_epoch(value: float) -> str:
    return datetime.fromtimestamp(value, tz=UTC).isoformat().replace("+00:00", "Z")
