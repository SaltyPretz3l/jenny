"""knowledge_exec — bounded read-only operations over the knowledge folders.

Every op is pure Python (no shell-out): ls/tree/find walk the registered
roots with depth/entry bounds and symlink rejection.
"""

from __future__ import annotations

import fnmatch
import json
import os
from dataclasses import dataclass
from pathlib import Path

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH, CMP_TOOL_IO_FAILED
from sidecar.ai.tools.builtins.filesystem import SEARCH_IGNORE_DIRS
from sidecar.ai.tools.builtins.knowledge.roots import (
    KnowledgeRoot,
    display_path,
    require_roots,
    resolve_knowledge_path,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult

_VALID_OPS = ("ls", "tree", "find")
DEFAULT_MAX_ENTRIES = 200
MAX_ENTRIES = 500
DEFAULT_TREE_DEPTH = 3
MAX_TREE_DEPTH = 10
MAX_VISITED_PATHS = 5_000


@dataclass
class _EntryCollector:
    entries: list[dict[str, object]]
    max_entries: int
    max_depth: int
    name_pattern: str | None
    files_only: bool
    max_visited_paths: int = MAX_VISITED_PATHS
    visited_paths: int = 0

    @property
    def full(self) -> bool:
        return len(self.entries) >= self.max_entries

    def try_visit(self) -> bool:
        if self.visited_paths >= self.max_visited_paths:
            return False
        self.visited_paths += 1
        return True


def knowledge_exec_tool(
    arguments: dict[str, object],
    workspace: object,
) -> ToolHandlerResult:
    op = str(arguments.get("op") or "").strip().lower()
    if op not in _VALID_OPS:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=(
                f"unknown knowledge_exec op '{op}'; "
                f"supported ops: {', '.join(_VALID_OPS)}"
            ),
            retryable=False,
        )
    return _run_listing_op(op, arguments)


def _bounded_int(value: object, *, default: int, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return default
    if value < minimum:
        return default
    return min(value, maximum)


def _listing_scopes(arguments: dict[str, object]) -> list[tuple[KnowledgeRoot, Path]]:
    raw_path = arguments.get("path")
    if raw_path is None or (isinstance(raw_path, str) and not raw_path.strip()):
        return [
            (root, root.path)
            for root in require_roots()
            if root.path is not None
        ]
    root, resolved, _display = resolve_knowledge_path(raw_path)
    return [(root, resolved)]


def _run_listing_op(op: str, arguments: dict[str, object]) -> ToolHandlerResult:
    scopes = _listing_scopes(arguments)
    max_entries = _bounded_int(
        arguments.get("max_entries"),
        default=DEFAULT_MAX_ENTRIES,
        minimum=1,
        maximum=MAX_ENTRIES,
    )
    max_depth = _bounded_int(
        arguments.get("max_depth"),
        default=1 if op == "ls" else DEFAULT_TREE_DEPTH,
        minimum=1,
        maximum=MAX_TREE_DEPTH,
    )
    name_pattern: str | None = None
    if op == "find":
        raw_pattern = arguments.get("pattern")
        name_pattern = raw_pattern.strip() if isinstance(raw_pattern, str) else ""
        if not name_pattern:
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message="knowledge_exec op=find requires a 'pattern' file-name glob",
                retryable=False,
            )
    if op == "ls":
        max_depth = 1

    entries: list[dict[str, object]] = []
    collector = _EntryCollector(
        entries=entries,
        max_entries=max_entries,
        max_depth=max_depth,
        name_pattern=name_pattern,
        files_only=op == "find",
    )
    truncated = False
    for root, base in scopes:
        truncated = _collect_entries(root, base, collector=collector)
        if truncated:
            break

    payload: dict[str, object] = {
        "op": op,
        "entries": entries,
        "truncated": truncated,
        "sources": [],
        "missing_source_metadata": True,
    }
    metadata: dict[str, object] = {
        "result_kind": "knowledge_exec",
        "op": op,
        "entry_count": len(entries),
        "truncated": truncated,
    }
    return ToolHandlerResult(
        output=json.dumps(payload, ensure_ascii=False),
        metadata=metadata,
    )


def _collect_entries(
    root: KnowledgeRoot,
    base: Path,
    *,
    collector: _EntryCollector,
) -> bool:
    """Append bounded, guard-validated entries; return True when truncated.

    ``max_depth`` counts directory levels below ``base``: 1 lists only the
    direct children (ls), N lists files whose parent sits fewer than N
    levels down and names the directories at each visited level.
    """
    if base.is_file():
        if not collector.try_visit():
            return True
        matches_pattern = not (
            collector.files_only
            and collector.name_pattern is not None
            and not fnmatch.fnmatch(base.name, collector.name_pattern)
        )
        if matches_pattern:
            collector.entries.append(_entry_for(root, base))
        return False
    try:
        for current_root, dir_names, file_names in os.walk(base, followlinks=False):
            current_path = Path(current_root)
            depth = len(current_path.relative_to(base).parts)
            kept_dirs, visit_budget_exhausted = _kept_dir_names(
                root,
                current_path,
                dir_names,
                collector=collector,
            )
            if visit_budget_exhausted:
                return True
            if _append_files(root, current_path, file_names, collector=collector):
                return True
            if not collector.files_only:
                for name in kept_dirs:
                    if collector.full:
                        return True
                    collector.entries.append(
                        {
                            "path": display_path(root, current_path / name),
                            "type": "dir",
                        }
                    )
            dir_names[:] = kept_dirs if depth + 1 < collector.max_depth else []
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"failed to list {display_path(root, base)}: {error}",
            retryable=True,
        ) from error
    return False


def _append_files(
    root: KnowledgeRoot,
    current_path: Path,
    file_names: list[str],
    *,
    collector: _EntryCollector,
) -> bool:
    """Append safe files from one directory; report an exhausted entry cap."""
    for name in sorted(file_names, key=str.lower):
        if not collector.try_visit():
            return True
        candidate = current_path / name
        if candidate.is_symlink():
            continue
        if collector.name_pattern is not None and not fnmatch.fnmatch(
            name,
            collector.name_pattern,
        ):
            continue
        try:
            resolved = root.guard.ensure_within_root(candidate)
        except ToolExecutionFailure:
            continue
        if not resolved.is_file():
            continue
        if collector.full:
            return True
        collector.entries.append(_entry_for(root, resolved))
    return False


def _kept_dir_names(
    root: KnowledgeRoot,
    current_path: Path,
    dir_names: list[str],
    *,
    collector: _EntryCollector,
) -> tuple[list[str], bool]:
    kept: list[str] = []
    for name in sorted(dir_names, key=str.lower):
        if not collector.try_visit():
            return kept, True
        if name in SEARCH_IGNORE_DIRS:
            continue
        candidate = current_path / name
        if candidate.is_symlink():
            continue
        try:
            root.guard.ensure_within_root(candidate)
        except ToolExecutionFailure:
            continue
        kept.append(name)
    return kept, False


def _entry_for(root: KnowledgeRoot, resolved: Path) -> dict[str, object]:
    entry: dict[str, object] = {
        "path": display_path(root, resolved),
        "type": "file",
    }
    try:
        entry["size_bytes"] = resolved.stat().st_size
    except OSError:
        pass
    return entry
