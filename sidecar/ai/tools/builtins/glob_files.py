"""Read-only workspace glob search tool."""

from __future__ import annotations

import bisect
import logging
import os
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from time import monotonic
from typing import Iterator

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH
from sidecar.ai.tools.builtins.filesystem import SEARCH_IGNORE_DIRS, workspace_relative_path
from sidecar.ai.tools.builtins.grep_search_file import (
    MAX_BRACE_EXPANSIONS,
    BraceExpansionLimitError,
    expand_brace_patterns,
    is_link_entry,
    matches_relative_glob,
    split_top_level_commas,
)
from sidecar.ai.tools.builtins.search_ignore import (
    SearchIgnoreFilter,
    ignored_directories_note,
    load_search_ignore_filter,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

MAX_GLOB_RESULTS = 100
MAX_GLOB_SCAN_FILES = 10_000
MAX_GLOB_SCAN_DIRECTORIES = 10_000
GLOB_SCAN_TIME_BUDGET_SECONDS = 2.0


def glob_files_tool(arguments: dict[str, object], workspace: WorkspaceGuard) -> ToolHandlerResult:
    pattern = _pattern_argument(arguments)
    base_root = _search_root(arguments, workspace)
    display_root = workspace_relative_path(base_root, workspace.root)
    plans = _resolve_search_plans(pattern, base_root, workspace)
    if not plans:
        return ToolHandlerResult(
            output=(
                f"path: {display_root} (workspace-relative)\n\n"
                f"{_format_output(pattern, [], truncation_reason=None, scan_complete=True)}"
            ),
            metadata=_metadata(0, None, 0, True, None),
        )

    matched_paths: list[tuple[int, str]] = []
    matched_count_scanned = 0
    truncation_reason: str | None = None
    scan_complete = False
    # Before the clock starts: the bounded git inventory is not walk time.
    ignore_filter = load_search_ignore_filter(base_root)
    roots = _walk_roots(plans, ignore_filter)
    budget = _ScanBudget(started_at=monotonic())
    try:
        for candidate in _iter_search_files(
            roots, workspace, budget=budget, ignore_filter=ignore_filter
        ):
            if not _matches_any_plan(candidate, plans):
                continue
            relative_path = workspace_relative_path(candidate, workspace.root)
            matched_count_scanned += 1
            bisect.insort(
                matched_paths,
                (_candidate_mtime_ns(candidate), relative_path),
                key=_match_sort_key,
            )
            if len(matched_paths) > MAX_GLOB_RESULTS:
                matched_paths.pop()
    except _ScanBudgetExceeded as error:
        truncation_reason = error.reason
    else:
        scan_complete = True

    ordered_matches = _ordered_matches(matched_paths)
    if scan_complete and matched_count_scanned > MAX_GLOB_RESULTS:
        truncation_reason = "result_limit"
    output = _format_output(
        pattern,
        ordered_matches,
        truncation_reason=truncation_reason,
        scan_complete=scan_complete,
        total_matches=matched_count_scanned,
    )
    ignored_directories = ignore_filter.skipped_directories if ignore_filter else 0
    if ignored_directories and (not ordered_matches or truncation_reason is not None):
        output = f"{output}\n{ignored_directories_note(ignored_directories)}"
    output = f"path: {display_root} (workspace-relative)\n\n{output}"
    metadata = _metadata(
        len(ordered_matches),
        budget,
        matched_count_scanned,
        scan_complete,
        truncation_reason,
    )
    metadata["ignored_directories_skipped"] = ignored_directories
    return ToolHandlerResult(output=output, metadata=metadata)


def _metadata(
    match_count: int,
    budget: _ScanBudget | None,
    matched_count_scanned: int,
    scan_complete: bool,
    truncation_reason: str | None,
) -> dict[str, object]:
    return {
        "match_count": match_count,
        "truncated": truncation_reason is not None,
        "files_scanned": budget.files_scanned if budget is not None else 0,
        "directories_scanned": budget.directories_scanned if budget is not None else 0,
        "matched_count_scanned": matched_count_scanned,
        "scan_complete": scan_complete,
        "truncation_reason": truncation_reason,
        "ignored_directories_skipped": 0,
    }


def _pattern_argument(arguments: dict[str, object]) -> str:
    value = arguments.get("pattern")
    if not isinstance(value, str) or not value.strip():
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'pattern' must be a non-empty string",
            retryable=False,
        )
    return value.strip()


def _search_root(arguments: dict[str, object], workspace: WorkspaceGuard) -> Path:
    raw_path = arguments.get("path", ".")
    if not isinstance(raw_path, str):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'path' must be a string",
            retryable=False,
        )
    resolved = workspace.resolve_list_path(raw_path.strip() or ".")
    if not resolved.is_dir():
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="path must point to a directory",
            retryable=False,
        )
    return resolved


@dataclass(frozen=True)
class _SearchPlan:
    """One comma alternative: its literal base directory and its expanded globs."""

    root: Path
    patterns: tuple[str, ...]


def _resolve_search_plans(
    pattern: str,
    base_root: Path,
    workspace: WorkspaceGuard,
) -> list[_SearchPlan]:
    """One plan per top-level comma alternative whose base directory exists.

    Each alternative keeps the meaning it has alone: its literal prefix narrows
    its own root, then its braces expand relative to that root.
    """
    plans: list[_SearchPlan] = []
    expansions = 0
    for alternative in split_top_level_commas(pattern):
        base_dir, relative_pattern = _extract_glob_base_directory(alternative)
        patterns = _bounded_brace_patterns(relative_pattern)
        expansions += len(patterns)
        if expansions > MAX_BRACE_EXPANSIONS:
            raise _brace_limit_failure()
        if not base_dir:
            plans.append(_SearchPlan(base_root, patterns))
            continue
        candidate_root = workspace.ensure_within_root(base_root / Path(base_dir))
        if candidate_root.exists() and candidate_root.is_dir():
            plans.append(_SearchPlan(candidate_root, patterns))
    return plans


def _walk_roots(plans: list[_SearchPlan], ignore_filter: SearchIgnoreFilter | None) -> list[Path]:
    """Distinct plan roots, dropping any inside another and any git ignores."""
    roots: list[Path] = []
    for plan in sorted(plans, key=lambda item: tuple(part.lower() for part in item.root.parts)):
        if any(plan.root == root or plan.root.is_relative_to(root) for root in roots):
            continue
        if ignore_filter is None or ignore_filter.allows_directory_chain(plan.root):
            roots.append(plan.root)
    return roots


def _matches_any_plan(candidate: Path, plans: list[_SearchPlan]) -> bool:
    for plan in plans:
        try:
            relative = candidate.relative_to(plan.root).as_posix()
        except ValueError:
            continue
        if any(matches_relative_glob(relative, glob) for glob in plan.patterns):
            return True
    return False


def _extract_glob_base_directory(pattern: str) -> tuple[str, str]:
    normalized = pattern.replace("\\", "/")
    first_glob_index = next(
        (index for index, char in enumerate(normalized) if char in {"*", "?", "[", "{"}),
        -1,
    )
    if first_glob_index == -1:
        pure_path = PurePosixPath(normalized)
        if pure_path.parent == PurePosixPath("."):
            return "", pure_path.name
        return pure_path.parent.as_posix(), pure_path.name

    static_prefix = normalized[:first_glob_index]
    last_separator = static_prefix.rfind("/")
    if last_separator == -1:
        return "", normalized
    base_dir = static_prefix[:last_separator]
    relative_pattern = normalized[last_separator + 1 :]
    return base_dir, relative_pattern


def _bounded_brace_patterns(pattern: str) -> tuple[str, ...]:
    try:
        return expand_brace_patterns(pattern)
    except BraceExpansionLimitError as error:
        raise _brace_limit_failure() from error


def _brace_limit_failure() -> ToolExecutionFailure:
    return ToolExecutionFailure(
        code=CMP_TOOL_INVALID_PATH,
        message=(
            "tool argument 'pattern' exceeds the bounded brace expansion limit "
            f"of {MAX_BRACE_EXPANSIONS}"
        ),
        retryable=False,
    )


class _ScanBudgetExceeded(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass
class _ScanBudget:
    started_at: float
    files_scanned: int = 0
    directories_scanned: int = 0
    directories_discovered: int = 1

    def check_time(self) -> None:
        if monotonic() - self.started_at >= GLOB_SCAN_TIME_BUDGET_SECONDS:
            raise _ScanBudgetExceeded("time_budget")

    def enter_directory(self) -> None:
        self.check_time()
        self.directories_scanned += 1

    def discover_directory(self) -> None:
        if self.directories_discovered >= MAX_GLOB_SCAN_DIRECTORIES:
            raise _ScanBudgetExceeded("directory_limit")
        self.directories_discovered += 1

    def scan_file(self) -> None:
        self.check_time()
        if self.files_scanned >= MAX_GLOB_SCAN_FILES:
            raise _ScanBudgetExceeded("scan_limit")
        self.files_scanned += 1


def _iter_search_files(
    roots: list[Path],
    workspace: WorkspaceGuard,
    *,
    budget: _ScanBudget,
    ignore_filter: SearchIgnoreFilter | None = None,
) -> Iterator[Path]:
    pending = list(reversed(roots))
    # Backstop against any link shape the entry check misses.
    seen = {os.path.normcase(str(root)) for root in roots}
    while pending:
        current_path = pending.pop()
        budget.enter_directory()
        child_directories: list[Path] = []
        try:
            with os.scandir(current_path) as entries:
                for entry in entries:
                    budget.check_time()
                    candidate = current_path / entry.name
                    try:
                        # Junctions count as links: Python 3.11 does not report them.
                        is_link = is_link_entry(entry)
                        is_directory = entry.is_dir(follow_symlinks=False)
                        is_file = entry.is_file(follow_symlinks=False)
                    except OSError:
                        _log_skip("stat_failed", candidate)
                        continue
                    if is_link:
                        _log_skip("symlink_dir" if is_directory else "symlink_file", candidate)
                        continue
                    if (
                        is_directory
                        and not _ignored_directory_name(entry.name)
                        and _git_allows(ignore_filter, candidate, directory=True)
                    ):
                        # Containment is resolved once per directory; a regular
                        # non-link file inside a verified directory is contained.
                        try:
                            resolved = workspace.ensure_within_root(candidate)
                        except ToolExecutionFailure:
                            _log_skip("outside_workspace", candidate)
                            continue
                        if os.path.normcase(str(resolved)) in seen:
                            _log_skip("revisited_dir", candidate)
                            continue
                        seen.add(os.path.normcase(str(resolved)))
                        budget.discover_directory()
                        child_directories.append(resolved)
                    elif is_file and _git_allows(ignore_filter, candidate, directory=False):
                        budget.scan_file()
                        yield candidate
        except _ScanBudgetExceeded:
            raise
        except OSError:
            _log_skip("directory_scan_failed", current_path)
            continue
        pending.extend(sorted(child_directories, key=lambda path: path.name.lower(), reverse=True))


def _git_allows(
    ignore_filter: SearchIgnoreFilter | None, candidate: Path, *, directory: bool
) -> bool:
    if ignore_filter is None:
        return True
    if directory:
        return ignore_filter.allows_directory(candidate)
    return ignore_filter.allows_file(candidate)


def _ignored_directory_name(name: str) -> bool:
    candidate = os.path.normcase(name) if os.name == "nt" else name
    ignored = (
        {os.path.normcase(value) for value in SEARCH_IGNORE_DIRS}
        if os.name == "nt"
        else SEARCH_IGNORE_DIRS
    )
    return candidate in ignored


def _candidate_mtime_ns(candidate: Path) -> int:
    try:
        return int(candidate.stat().st_mtime_ns)
    except OSError:
        return 0


def _ordered_matches(matched_paths: list[tuple[int, str]]) -> list[str]:
    ordered = sorted(matched_paths, key=_match_sort_key)
    return [path for _, path in ordered]


def _match_sort_key(item: tuple[int, str]) -> tuple[int, str, str]:
    return (-item[0], PurePosixPath(item[1]).name.lower(), item[1].lower())


def _format_output(
    pattern: str,
    matches: list[str],
    *,
    truncation_reason: str | None,
    scan_complete: bool,
    total_matches: int | None = None,
) -> str:
    if not matches and scan_complete:
        return f"No files matched pattern '{pattern}'."
    if not scan_complete:
        reasons = {
            "scan_limit": "scan limit",
            "directory_limit": "directory limit",
            "time_budget": "time budget",
        }
        reason = reasons.get(truncation_reason or "", "work budget")
        heading = (
            f"Partial results for pattern '{pattern}' ({reason} reached; "
            f"showing newest {len(matches)} within the scanned subset):"
        )
    elif truncation_reason == "result_limit" and total_matches is not None:
        heading = (
            f"Found {total_matches} files matching pattern '{pattern}' "
            f"(showing newest {len(matches)}):"
        )
    else:
        heading = f"Found {len(matches)} files matching pattern '{pattern}':"
    return "\n".join([heading, *matches])


def _log_skip(reason: str, candidate: Path) -> None:
    log_event(
        logger,
        logging.DEBUG,
        component="ai.tools.glob_files",
        event="ai.tools.glob_files.skipped_path",
        message=f"Skipped path during glob search: {candidate.as_posix()}",
        status="skipped",
        data={"reason": reason, "path": candidate.as_posix()},
    )
