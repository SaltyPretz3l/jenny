"""knowledge_search — regex search across the registered knowledge folders.

Reuses grep_search's pure-Python worker pipeline (spawned subprocess with a
per-file timeout) scoped to each registered root's WorkspaceGuard. No
ripgrep, no index — live filesystem reads, bounded per call.
"""

from __future__ import annotations

import json
import re
import time
from concurrent.futures import TimeoutError as FutureTimeoutError
from dataclasses import dataclass, replace
from pathlib import Path

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH
from sidecar.ai.tools.builtins.filesystem import is_binary_file
from sidecar.ai.tools.builtins.grep_search import (
    DEFAULT_MAX_RESULTS,
    LARGE_FILE_HINT,
    MAX_CONTEXT_LINES,
    MAX_RESULTS,
    MAX_TIMED_OUT_FILES,
    MAX_TOTAL_RUNTIME_SECONDS,
    _bounded_int,
    _build_result,
    _iter_candidate_files,
    _max_search_file_bytes,
    _optional_string,
    _RegexSearchWorker,
    _search_file_with_timeout,
    _SearchState,
)
from sidecar.ai.tools.builtins.knowledge.roots import (
    KnowledgeRoot,
    build_sources,
    display_path,
    resolve_knowledge_path,
    select_roots,
    skipped_root_labels,
)
from sidecar.ai.tools.builtins.regex_safety import compile_safe_pattern
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult

# Corpus-wide traversal cap, independent of the per-call runtime budget.
MAX_TOTAL_FILES_VISITED = 5000
_MATCH_LINE_PARTS = 3


@dataclass
class _RootSearchContext:
    compiled: re.Pattern[str]
    include_glob: str | None
    context_lines: int
    state: _SearchState
    source_entries: list[tuple[str, str]]
    worker: _RegexSearchWorker
    started_at: float
    files_visited: int = 0


def knowledge_search_tool(
    arguments: dict[str, object],
    workspace: object,
) -> ToolHandlerResult:
    _ = workspace  # knowledge tools are scoped to registered roots, not the workspace
    ignore_case = arguments.get("ignore_case")
    compiled = compile_safe_pattern(
        arguments.get("pattern"),
        ignore_case=isinstance(ignore_case, bool) and ignore_case,
        error_code=CMP_TOOL_INVALID_PATH,
    )
    roots, start_paths = _resolve_search_scope(
        root_argument=arguments.get("root"),
        path_argument=arguments.get("path"),
    )
    include_glob = _optional_string(arguments.get("include_glob"))
    context_lines = _bounded_int(
        arguments.get("context_lines"),
        default=0,
        maximum=MAX_CONTEXT_LINES,
    )
    max_results = _bounded_int(
        arguments.get("max_results"),
        default=DEFAULT_MAX_RESULTS,
        maximum=MAX_RESULTS,
    )

    state = _SearchState(max_results=max_results)
    search_context = _RootSearchContext(
        compiled=compiled,
        include_glob=include_glob,
        context_lines=context_lines,
        state=state,
        source_entries=[],
        worker=_RegexSearchWorker(),
        started_at=time.monotonic(),
    )
    aborted_by_file_budget = False
    try:
        for scope_index, root in enumerate(roots):
            if root.path is None:
                continue
            _search_root(
                root,
                start_path=start_paths[scope_index],
                context=search_context,
            )
            if search_context.files_visited >= MAX_TOTAL_FILES_VISITED:
                aborted_by_file_budget = True
                break
            if state.aborted_by_runtime_budget or state.aborted_by_timeout_cap:
                break
    finally:
        search_context.worker.close()

    return _knowledge_search_result(
        context=search_context,
        roots=roots,
        aborted_by_file_budget=aborted_by_file_budget,
    )


def _resolve_search_scope(
    *,
    root_argument: object,
    path_argument: object,
) -> tuple[tuple[KnowledgeRoot, ...], list[Path | None]]:
    """Resolve the optional root/path scoping arguments.

    ``path`` narrows the search to a directory (or single file) inside one
    root and is mutually exclusive with ``root``; without either, every
    registered root is searched from its top.
    """
    has_path = isinstance(path_argument, str) and path_argument.strip()
    if has_path and isinstance(root_argument, str) and root_argument.strip():
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="pass either 'root' or 'path', not both",
            retryable=False,
        )
    if has_path:
        root, resolved, _display = resolve_knowledge_path(path_argument)
        return (root,), [resolved]
    roots = select_roots(root_argument)
    return roots, [None] * len(roots)


def _search_root(
    root: KnowledgeRoot,
    *,
    start_path: Path | None = None,
    context: _RootSearchContext,
) -> None:
    if root.path is None:
        return
    for candidate in _iter_candidate_files(
        start_path or root.path,
        root.guard,
        context.include_glob,
    ):
        if time.monotonic() - context.started_at >= MAX_TOTAL_RUNTIME_SECONDS:
            context.state.aborted_by_runtime_budget = True
            return
        context.files_visited += 1
        if context.files_visited >= MAX_TOTAL_FILES_VISITED:
            return
        context.state.selected_files += 1
        if is_binary_file(candidate):
            context.state.skipped_binary_files += 1
            continue
        try:
            root.guard.check_file_size(
                candidate,
                _max_search_file_bytes(),
                hint=LARGE_FILE_HINT,
            )
        except ToolExecutionFailure as error:
            if error.retryable:
                raise
            context.state.skipped_large_files += 1
            context.state.record_large_file_message(error.message)
            continue
        context.state.candidate_files += 1
        try:
            result = _search_file_with_timeout(
                candidate,
                context.compiled,
                workspace=root.guard,
                context_lines=context.context_lines,
                max_output_matches=context.state.remaining_output_matches,
                max_output_bytes=context.state.remaining_output_bytes,
                worker=context.worker,
            )
        except FutureTimeoutError:
            context.state.timed_out_files += 1
            if context.state.timed_out_files >= MAX_TIMED_OUT_FILES:
                context.state.aborted_by_timeout_cap = True
                return
            continue
        if result.total_match_count:
            context.source_entries.append(
                (display_path(root, candidate), _first_match_snippet(result.lines))
            )
        # Worker lines are root-relative; re-anchor them to the display label.
        context.state.consume(
            replace(
                result,
                lines=[
                    f"{root.label}/{line}" if line else line for line in result.lines
                ],
            )
        )


def _first_match_snippet(lines: list[str]) -> str:
    for line in lines:
        if not line:
            continue
        parts = line.split(":", 2)
        if len(parts) == _MATCH_LINE_PARTS:
            return parts[2]
        return line
    return ""


def _knowledge_search_result(
    *,
    context: _RootSearchContext,
    roots: tuple[KnowledgeRoot, ...],
    aborted_by_file_budget: bool,
) -> ToolHandlerResult:
    pattern = context.compiled.pattern
    text_result = _build_result(pattern=pattern, state=context.state)
    sources = build_sources(context.source_entries)
    payload: dict[str, object] = {
        "pattern": pattern,
        "result": text_result.output,
        "sources": sources,
        "missing_source_metadata": len(sources) == 0,
    }
    skipped = skipped_root_labels()
    if skipped:
        payload["skipped_roots"] = list(skipped)
    if aborted_by_file_budget:
        payload["file_budget_exhausted"] = True
    metadata = dict(text_result.metadata)
    metadata["files_visited"] = context.files_visited
    metadata["roots_searched"] = [root.label for root in roots]
    metadata["source_count"] = len(sources)
    if aborted_by_file_budget:
        metadata["aborted_by_file_budget"] = True
    return ToolHandlerResult(
        output=json.dumps(payload, ensure_ascii=False),
        success=text_result.success,
        error_code=text_result.error_code,
        metadata=metadata,
    )
