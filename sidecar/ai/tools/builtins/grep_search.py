"""Read-only workspace content search tool."""

from __future__ import annotations

import logging
import re
import time
from pathlib import Path
from typing import Callable, Iterator, Sequence

from sidecar.ai.error_codes import (
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_IO_FAILED,
)
from sidecar.ai.tools.argument_coercion import bounded_int as _bounded_int
from sidecar.ai.tools.builtins.file_state import is_binary_extension
from sidecar.ai.tools.builtins.grep_search_client import (
    REGEX_SEARCH_TIMEOUT_SECONDS,
    _RegexSearchWorker,
    _WorkerUnavailable,
)
from sidecar.ai.tools.builtins.grep_search_file import (
    MATCH_SUMMARY_OP,  # noqa: F401 - re-export for knowledge search
    MAX_BRACE_EXPANSIONS,
    MAX_RENDERED_LINE_CHARS,
    BraceExpansionLimitError,
    FileSearchResult,
    expand_brace_patterns,
    iter_candidate_files,
    matches_relative_glob,
)
from sidecar.ai.tools.builtins.grep_search_settings import (
    _SEARCH_SETTINGS,
    DEFAULT_MAX_SEARCH_FILE_BYTES,  # noqa: F401 - re-export
    MAX_CONFIGURED_SEARCH_FILE_BYTES,  # noqa: F401 - re-export
    MIN_CONFIGURED_SEARCH_FILE_BYTES,  # noqa: F401 - re-export
    configure_grep_search,  # noqa: F401 - re-export
)
from sidecar.ai.tools.builtins.grep_search_worker import (
    MAX_BATCH_FILES,
    ScanOutcome,
)
from sidecar.ai.tools.builtins.grep_search_worker import (
    run_worker_request as _run_worker_request,  # noqa: F401 - re-export for tests
)
from sidecar.ai.tools.builtins.grep_search_worker import (
    scan_text_batches as _scan_text_batches,
)
from sidecar.ai.tools.builtins.regex_safety import compile_safe_pattern
from sidecar.ai.tools.builtins.search_ignore import (
    SearchIgnoreFilter,
    ignored_directories_note,
    load_search_ignore_filter,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

DEFAULT_MAX_RESULTS = 100
MAX_CONTEXT_LINES = 10
MAX_RESULTS = 500
MAX_TOTAL_RUNTIME_SECONDS = 30.0
MAX_TIMED_OUT_FILES = 3
# Per-file read failures are skipped; this many in a row is a systemic failure.
MAX_CONSECUTIVE_UNREADABLE_FILES = 25
MAX_OUTPUT_BYTES = 20_000
LARGE_FILE_HINT = "Use paginated read_file with offset/limit to inspect large files."

def grep_search_tool(arguments: dict[str, object], workspace: WorkspaceGuard) -> ToolHandlerResult:
    compiled = _compile_pattern(arguments)
    search_root = _resolve_search_root(arguments, workspace)
    include_glob = _optional_string(arguments.get("include_glob"))
    include_patterns = _bounded_include_patterns(include_glob)
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

    search_state = _SearchState(
        max_results=max_results,
        searched_root=search_root.relative_to(workspace.require_root()).as_posix(),
    )
    started_at = _monotonic_seconds()
    worker = _RegexSearchWorker()
    worker.prestart()  # its start overlaps the git ignore inventory and the walk
    try:
        ignore_filter = load_search_ignore_filter(search_root)
    except BaseException:
        worker.close()
        raise

    def walk_budget_exhausted() -> bool:
        if _runtime_budget_exhausted(started_at):
            search_state.aborted_by_runtime_budget = True
        return search_state.aborted_by_runtime_budget

    scan = _CandidateScan(compiled, workspace, context_lines, search_state, worker, started_at)
    pending: list[Path] = []
    # The walk runs ahead of the scan: keep the ignored-directory count per candidate.
    walked_skips: dict[Path, int] = {}
    keep_going = True
    try:
        for candidate in _iter_candidate_files(
            search_root,
            workspace,
            include_patterns,
            budget_exhausted=walk_budget_exhausted,
            ignore_filter=ignore_filter,
        ):
            pending.append(candidate)
            if ignore_filter is not None:
                walked_skips[candidate] = ignore_filter.skipped_directories
            if len(pending) >= MAX_BATCH_FILES:
                keep_going = scan.run(pending)
                if not keep_going:
                    break
                pending, walked_skips = [], {}
        if keep_going and pending:
            keep_going = scan.run(pending)
    finally:
        worker.close()
    stopped_at = None if keep_going else scan.current
    if ignore_filter is not None:
        search_state.ignored_directories_skipped = (
            ignore_filter.skipped_directories if stopped_at is None else walked_skips[stopped_at]
        )

    return _build_result(
        pattern=compiled.pattern,
        state=search_state,
    )


class _CandidateScan:
    """Searches walk-ordered candidates; text files go to the worker in batches.

    Each candidate gets, in walk order, what the old one-file-at-a-time loop gave
    it: the runtime-budget check, ``selected_files``, then its outcome. A PDF needs
    the worker idle, so it splits the text files around it into separate batches.
    """

    def __init__(
        self,
        compiled: re.Pattern[str],
        workspace: WorkspaceGuard,
        context_lines: int,
        state: _SearchState,
        worker: _RegexSearchWorker,
        started_at: float,
    ) -> None:
        self.compiled, self.workspace, self.context_lines = compiled, workspace, context_lines
        self.state, self.worker, self.started_at = state, worker, started_at
        self.current: Path | None = None  # the candidate the scan reached last

    def run(self, candidates: list[Path]) -> bool:
        """Search ``candidates``; False when the whole scan must stop."""
        start = 0
        while start < len(candidates):
            end = next(
                (index for index in range(start, len(candidates)) if _is_pdf(candidates[index])),
                len(candidates),
            )
            if not self._run_segment(candidates[start:end]):
                return False
            if end < len(candidates) and not self._run_one(candidates[end], self._search_pdf):
                return False
            start = end + 1
        return True

    def _run_segment(self, segment: list[Path]) -> bool:
        binary = [is_binary_extension(path) for path in segment]
        text_files = [path for path, skip in zip(segment, binary, strict=True) if not skip]
        outcomes = _scan_text_batches(
            self.worker,
            text_files,
            self.compiled,
            workspace_root=self.workspace.root,
            context_lines=self.context_lines,
            max_output_matches=self.state.remaining_output_matches,
            max_output_bytes=self.state.remaining_output_bytes,
            max_file_bytes=_max_search_file_bytes(),
            timeout_seconds=REGEX_SEARCH_TIMEOUT_SECONDS,
        )

        def scan_next(path: Path) -> bool:
            # next() runs inside _run_one, after the runtime-budget check.
            return self._apply(path, next(outcomes))

        def count_binary(path: Path) -> bool:
            return self._apply(path, _BINARY_BY_EXTENSION)

        try:
            for candidate, skip in zip(segment, binary, strict=True):
                keep_going = self._run_one(candidate, count_binary if skip else scan_next)
                if not keep_going:
                    return False
        finally:
            outcomes.close()
        return True

    def _run_one(self, candidate: Path, search: Callable[[Path], bool]) -> bool:
        state = self.state
        self.current = candidate
        if _runtime_budget_exhausted(self.started_at):
            state.aborted_by_runtime_budget = True
            return False
        state.selected_files += 1
        try:
            keep_going = search(candidate)
        except ToolExecutionFailure as error:
            _skip_unreadable(state, error)
            return True
        state.consecutive_unreadable_files = 0
        return keep_going

    def _search_pdf(self, candidate: Path) -> bool:
        return _search_pdf_candidate(
            candidate,
            self.compiled,
            workspace=self.workspace,
            context_lines=self.context_lines,
            state=self.state,
            worker=self.worker,
            started_at=self.started_at,
        )

    def _apply(self, candidate: Path, outcome: ScanOutcome) -> bool:
        state = self.state
        if _count_skipped(state, candidate, outcome):
            return True
        state.candidate_files += 1
        if outcome.result is None:
            return _record_timeout(state, candidate)
        state.consume(outcome.result)
        return True


def _count_skipped(state: _SearchState, candidate: Path, outcome: ScanOutcome) -> bool:
    """Count a binary or over-cap outcome and return True; raise a read error."""
    if outcome.error is not None:
        raise outcome.error
    if outcome.kind == "binary":
        state.skipped_binary_files += 1
        return True
    if outcome.kind == "large":
        state.skipped_large_files += 1
        # workspace.check_file_size's wording, which the per-file path showed.
        state.record_large_file_message(
            f"file exceeds {_max_search_file_bytes()} byte limit: {candidate.name}. "
            f"{LARGE_FILE_HINT}"
        )
        return True
    return False


_BINARY_BY_EXTENSION = ScanOutcome("binary")


def _is_pdf(path: Path) -> bool:
    return path.suffix.lower() == ".pdf"


def _skip_unreadable(state: _SearchState, error: ToolExecutionFailure) -> None:
    """Count one per-file read failure; re-raise anything systemic.

    Worker failures and other error codes propagate, and so does a long run of
    failures. The error message is never kept: it can carry an absolute path.
    """

    if error.code != CMP_TOOL_IO_FAILED or isinstance(error, _WorkerUnavailable):
        raise error
    state.skipped_unreadable_files += 1
    state.consecutive_unreadable_files += 1
    if state.consecutive_unreadable_files >= MAX_CONSECUTIVE_UNREADABLE_FILES:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=(
                f"grep_search stopped after {MAX_CONSECUTIVE_UNREADABLE_FILES} files in a row "
                f"could not be read below '{state.searched_root}'."
            ),
            retryable=True,
        ) from error


class _SearchState:
    def __init__(self, *, max_results: int, searched_root: str = ".") -> None:
        self.max_results = max_results
        self.lines: list[str] = []
        self.returned_match_count = 0
        self.total_match_count = 0
        self.file_count = 0
        self.truncated = False
        self.truncated_by_bytes = False
        self.truncated_by_line_length = False
        self.timed_out_files = 0
        self.skipped_binary_files = 0
        self.skipped_large_files = 0
        self.skipped_pdf_pages = 0
        self.skipped_unreadable_files = 0
        self.consecutive_unreadable_files = 0
        self.candidate_files = 0
        self.selected_files = 0
        self.aborted_by_runtime_budget = False
        self.aborted_by_timeout_cap = False
        self.output_bytes_used = 0
        self.large_file_message: str | None = None
        self.searched_root = searched_root
        self.ignored_directories_skipped = 0

    @property
    def remaining_output_matches(self) -> int:
        return max(0, self.max_results - self.returned_match_count)

    @property
    def remaining_output_bytes(self) -> int:
        return max(0, MAX_OUTPUT_BYTES - self.output_bytes_used)

    def record_large_file_message(self, message: str) -> None:
        if self.large_file_message is None:
            self.large_file_message = message

    def consume(self, result: FileSearchResult) -> None:
        if result.total_match_count:
            self.total_match_count += result.total_match_count
            self.returned_match_count += result.returned_match_count
            self.file_count += 1
            self.output_bytes_used += result.output_bytes_used
            self.lines.extend(result.lines)
        self.truncated = self.truncated or result.truncated
        self.truncated_by_bytes = self.truncated_by_bytes or result.truncated_by_bytes
        self.truncated_by_line_length = (
            self.truncated_by_line_length or result.truncated_by_line_length
        )


def _search_pdf_candidate(
    candidate: Path,
    compiled: re.Pattern[str],
    *,
    workspace: WorkspaceGuard,
    context_lines: int,
    state: _SearchState,
    worker: _RegexSearchWorker,
    started_at: float,
) -> bool:
    """Search one PDF by page text; False when the whole scan must stop."""

    # Lazy: the PDF stack stays out of the sidecar.server import graph.
    from sidecar.ai.tools.builtins import grep_search_pdf

    if _skip_if_oversized(
        state,
        candidate,
        workspace,
        grep_search_pdf.MAX_PDF_SEARCH_BYTES,
        grep_search_pdf.LARGE_PDF_HINT,
    ):
        return True
    outcome = grep_search_pdf.search_pdf(
        candidate,
        compiled,
        workspace_root=workspace.root,
        context_lines=context_lines,
        max_output_matches=state.remaining_output_matches,
        max_output_bytes=state.remaining_output_bytes,
        deadline=started_at + MAX_TOTAL_RUNTIME_SECONDS,
        send=lambda request: worker.request(request, REGEX_SEARCH_TIMEOUT_SECONDS),
    )
    if outcome is None:
        # No PDF reading add-on, or a PDF PyMuPDF cannot read: the old binary skip.
        state.skipped_binary_files += 1
        return True
    state.candidate_files += 1
    state.skipped_pdf_pages += outcome.skipped_pages
    state.consume(outcome.result)
    if outcome.timed_out and not _record_timeout(state, candidate):
        return False
    if outcome.runtime_exhausted:
        state.aborted_by_runtime_budget = True
        return False
    return True


def _skip_if_oversized(
    state: _SearchState, path: Path, workspace: WorkspaceGuard, limit: int, hint: str
) -> bool:
    """Count ``path`` as a skipped large file when it exceeds ``limit``."""

    try:
        workspace.check_file_size(path, limit, hint=hint)
    except ToolExecutionFailure as error:
        if error.retryable:
            raise
        state.skipped_large_files += 1
        state.record_large_file_message(error.message)
        return True
    return False


def _record_timeout(state: _SearchState, path: Path) -> bool:
    """Count one regex timeout; False once the cap stops the whole scan."""

    state.timed_out_files += 1
    _log_timeout(path)
    if state.timed_out_files >= MAX_TIMED_OUT_FILES:
        state.aborted_by_timeout_cap = True
        return False
    return True


def _compile_pattern(arguments: dict[str, object]) -> re.Pattern[str]:
    ignore_case = arguments.get("ignore_case")
    return compile_safe_pattern(
        arguments.get("pattern"),
        ignore_case=isinstance(ignore_case, bool) and ignore_case,
        error_code=CMP_TOOL_INVALID_PATH,
    )


def _resolve_search_root(arguments: dict[str, object], workspace: WorkspaceGuard) -> Path:
    raw_path = arguments.get("path", ".")
    if not isinstance(raw_path, str):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'path' must be a string",
            retryable=False,
        )
    resolved = workspace.resolve_list_path(raw_path.strip() or ".")
    if not resolved.exists():
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="path does not exist",
            retryable=False,
        )
    if not resolved.is_file() and not resolved.is_dir():
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="path must point to a file or directory",
            retryable=False,
        )
    return resolved


def _optional_string(value: object) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _bounded_include_patterns(pattern: str | None) -> tuple[str, ...] | None:
    if pattern is None:
        return None
    try:
        return expand_brace_patterns(pattern)
    except BraceExpansionLimitError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=(
                "tool argument 'include_glob' exceeds the bounded brace expansion limit "
                f"of {MAX_BRACE_EXPANSIONS}"
            ),
            retryable=False,
        ) from error


def _monotonic_seconds() -> float:
    return time.monotonic()


def _runtime_budget_exhausted(started_at: float) -> bool:
    return (_monotonic_seconds() - started_at) >= MAX_TOTAL_RUNTIME_SECONDS


def _iter_candidate_files(
    search_root: Path,
    workspace: WorkspaceGuard,
    include_patterns: Sequence[str] | None,
    *,
    budget_exhausted: Callable[[], bool] | None = None,
    ignore_filter: SearchIgnoreFilter | None = None,
) -> Iterator[Path]:
    """The candidate walk (``grep_search_file``); knowledge search shares it."""
    return iter_candidate_files(
        search_root,
        workspace,
        include_patterns,
        budget_exhausted=budget_exhausted,
        ignore_filter=ignore_filter,
    )


def _matches_glob(path: Path, *, search_root: Path, pattern: str) -> bool:
    """``include_glob`` matching, shared with ``glob_files`` (``**`` spans directories)."""
    return matches_relative_glob(path.relative_to(search_root).as_posix(), pattern)


def _build_result(*, pattern: str, state: _SearchState) -> ToolHandlerResult:
    scan_complete = not (
        state.aborted_by_runtime_budget
        or state.aborted_by_timeout_cap
        or state.skipped_pdf_pages
    )
    narrowing_hint = (
        f"Narrow path below '{state.searched_root}' or add include_glob, then retry."
        if not scan_complete
        else None
    )
    metadata: dict[str, object] = {
        "match_count": state.total_match_count,
        "returned_match_count": state.returned_match_count,
        "total_match_count": state.total_match_count,
        "file_count": state.file_count,
        "truncated": state.truncated,
        "truncated_by_bytes": state.truncated_by_bytes,
        "truncated_by_line_length": state.truncated_by_line_length,
        "timed_out_files": state.timed_out_files,
        "skipped_binary_files": state.skipped_binary_files,
        "skipped_large_files": state.skipped_large_files,
        "skipped_pdf_pages": state.skipped_pdf_pages,
        "skipped_unreadable_files": state.skipped_unreadable_files,
        "selected_files": state.selected_files,
        "candidate_files": state.candidate_files,
        "aborted_by_runtime_budget": state.aborted_by_runtime_budget,
        "aborted_by_timeout_cap": state.aborted_by_timeout_cap,
        "scan_complete": scan_complete,
        "files_scanned": state.selected_files,
        "files_candidates": state.candidate_files,
        "files_remaining": None if not scan_complete else 0,
        "remaining_count_known": scan_complete,
        "searched_root": state.searched_root,
        "narrowing_hint": narrowing_hint,
        "ignored_directories_skipped": state.ignored_directories_skipped,
    }
    if state.candidate_files == 0 and state.skipped_large_files > 0:
        output = state.large_file_message or (
            f"All candidate files exceeded the {_max_search_file_bytes()} byte search limit. "
            f"{LARGE_FILE_HINT}"
        )
        return ToolHandlerResult(
            output=output,
            success=False,
            error_code=CMP_TOOL_IO_FAILED,
            metadata=metadata,
        )

    if state.aborted_by_runtime_budget and state.total_match_count == 0:
        return ToolHandlerResult(
            output=(
                "Regex search stopped because the total runtime budget was exhausted. "
                f"No complete zero-match conclusion is available. {narrowing_hint}"
            ),
            success=False,
            error_code=CMP_TOOL_EXECUTION_FAILED,
            metadata=metadata,
        )

    if state.aborted_by_timeout_cap and state.total_match_count == 0:
        return ToolHandlerResult(
            output=(
                "Regex search stopped because too many files timed out. Simplify the pattern "
                "or use a literal string."
            ),
            success=False,
            error_code=CMP_TOOL_EXECUTION_FAILED,
            metadata=metadata,
        )

    if state.total_match_count:
        heading = (
            f"Found {state.total_match_count} matches in {state.file_count} files "
            f"for pattern '{pattern}':"
        )
        body = "\n".join(state.lines).rstrip()
        notes = _result_notes(state)
        output = "\n".join(part for part in [heading, body, notes] if part)
        return ToolHandlerResult(
            output=f"path: {state.searched_root} (workspace-relative)\n\n{output}",
            metadata=metadata,
        )

    if state.timed_out_files and state.timed_out_files == state.candidate_files:
        return ToolHandlerResult(
            output=(
                "Regex pattern timed out while searching files. Simplify the pattern or use a "
                "literal string."
            ),
            success=False,
            error_code=CMP_TOOL_EXECUTION_FAILED,
            metadata=metadata,
        )

    output = "\n".join(
        part
        for part in [
            f"No matches found for pattern '{pattern}'.",
            _result_notes(state),
        ]
        if part
    )
    return ToolHandlerResult(
        output=f"path: {state.searched_root} (workspace-relative)\n\n{output}",
        metadata=metadata,
    )


def _result_notes(state: _SearchState) -> str:
    notes: list[str] = []
    if state.total_match_count > state.returned_match_count:
        notes.append(
            f"Displayed {state.returned_match_count} of {state.total_match_count} matches."
        )
    if state.truncated_by_bytes:
        notes.append(f"Output truncated at {MAX_OUTPUT_BYTES} bytes.")
    if state.truncated_by_line_length:
        notes.append(
            f"Lines longer than {MAX_RENDERED_LINE_CHARS} characters were trimmed to a window "
            "around the first match; [col N] gives the window's first column."
        )
    if state.timed_out_files:
        notes.append(f"Skipped {state.timed_out_files} file(s) because the regex timed out.")
    if state.aborted_by_timeout_cap:
        notes.append("Search stopped because too many files timed out.")
    if state.aborted_by_runtime_budget:
        notes.append("Search stopped because the total runtime budget was exhausted.")
    if state.skipped_binary_files:
        notes.append(f"Skipped {state.skipped_binary_files} binary file(s).")
    if state.skipped_large_files:
        notes.append(
            f"Skipped {state.skipped_large_files} file(s) larger than "
            f"{_max_search_file_bytes()} bytes."
        )
    if state.skipped_unreadable_files:
        notes.append(f"Skipped {state.skipped_unreadable_files} file(s) that could not be read.")
    if state.ignored_directories_skipped and (not state.total_match_count or state.truncated):
        notes.append(ignored_directories_note(state.ignored_directories_skipped))
    if state.skipped_pdf_pages:
        notes.append(
            f"Skipped {state.skipped_pdf_pages} PDF page(s) (uncached scanned pages, or the "
            "tail of a long PDF) to stay within the per-PDF time budget, so they were not "
            "searched. Retry grep_search to cover more of them, or read them with read_file; "
            "extracted pages are cached for later searches."
        )
    return "\n".join(notes)


def _log_timeout(path: Path) -> None:
    log_event(
        logger,
        logging.WARNING,
        component="ai.tools.grep_search",
        event="ai.tools.grep_search.regex_timeout",
        message=f"Regex search timed out for {path.as_posix()}",
        status="timeout",
        data={"path": path.as_posix(), "timeout_seconds": REGEX_SEARCH_TIMEOUT_SECONDS},
    )


def _max_search_file_bytes() -> int:
    return int(_SEARCH_SETTINGS["max_search_file_bytes"])
