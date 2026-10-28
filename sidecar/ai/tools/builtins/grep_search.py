"""Read-only workspace content search tool."""

from __future__ import annotations

import json
import logging
import queue
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import TimeoutError as FutureTimeoutError
from pathlib import Path
from typing import IO, Callable, Iterator, Sequence

from sidecar.ai.error_codes import (
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_IO_FAILED,
)
from sidecar.ai.tools.argument_coercion import bounded_int as _bounded_int
from sidecar.ai.tools.builtins.grep_search_file import (
    MATCH_SUMMARY_OP,  # noqa: F401 - re-export for knowledge search
    MAX_BRACE_EXPANSIONS,
    MAX_RENDERED_LINE_CHARS,
    BraceExpansionLimitError,
    FileSearchResult,
    expand_brace_patterns,
    is_binary_file,
    iter_candidate_files,
    matches_relative_glob,
    run_lines_request,
    search_file,
    worker_error_response,
    worker_ok_response,
)
from sidecar.ai.tools.builtins.grep_search_file import (
    search_result_from_response as _response_to_search_result,
)
from sidecar.ai.tools.builtins.grep_search_settings import (
    _SEARCH_SETTINGS,
    DEFAULT_MAX_SEARCH_FILE_BYTES,  # noqa: F401 - re-export
    MAX_CONFIGURED_SEARCH_FILE_BYTES,  # noqa: F401 - re-export
    MIN_CONFIGURED_SEARCH_FILE_BYTES,  # noqa: F401 - re-export
    configure_grep_search,  # noqa: F401 - re-export
)
from sidecar.ai.tools.builtins.regex_safety import compile_safe_pattern
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.hosted_file_io import configure_hosted_file_io, hosted_file_io_enabled
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

DEFAULT_MAX_RESULTS = 100
MAX_CONTEXT_LINES = 10
MAX_RESULTS = 500
REGEX_SEARCH_TIMEOUT_SECONDS = 5.0
REGEX_WORKER_STARTUP_TIMEOUT_SECONDS = 15.0
MAX_TOTAL_RUNTIME_SECONDS = 30.0
MAX_TIMED_OUT_FILES = 3
# Per-file read failures are skipped; this many in a row is a systemic failure.
MAX_CONSECUTIVE_UNREADABLE_FILES = 25
MAX_OUTPUT_BYTES = 20_000
LARGE_FILE_HINT = "Use paginated read_file with offset/limit to inspect large files."
_WORKER_JOIN_TIMEOUT_SECONDS = 0.2
_WORKER_READY_MESSAGE = {"status": "ready"}

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

    def walk_budget_exhausted() -> bool:
        if _runtime_budget_exhausted(started_at):
            search_state.aborted_by_runtime_budget = True
        return search_state.aborted_by_runtime_budget

    try:
        for candidate in _iter_candidate_files(
            search_root, workspace, include_patterns, budget_exhausted=walk_budget_exhausted
        ):
            if _runtime_budget_exhausted(started_at):
                search_state.aborted_by_runtime_budget = True
                break
            search_state.selected_files += 1
            try:
                keep_going = _search_candidate(
                    candidate,
                    compiled,
                    workspace=workspace,
                    context_lines=context_lines,
                    state=search_state,
                    worker=worker,
                    started_at=started_at,
                )
            except ToolExecutionFailure as error:
                _skip_unreadable(search_state, error)
                continue
            search_state.consecutive_unreadable_files = 0
            if not keep_going:
                break
    finally:
        worker.close()

    return _build_result(
        pattern=compiled.pattern,
        state=search_state,
    )


def _search_candidate(
    candidate: Path,
    compiled: re.Pattern[str],
    *,
    workspace: WorkspaceGuard,
    context_lines: int,
    state: _SearchState,
    worker: _RegexSearchWorker,
    started_at: float,
) -> bool:
    """Search one candidate file; False when the whole scan must stop."""

    if candidate.suffix.lower() == ".pdf":
        return _search_pdf_candidate(
            candidate,
            compiled,
            workspace=workspace,
            context_lines=context_lines,
            state=state,
            worker=worker,
            started_at=started_at,
        )
    if is_binary_file(candidate):
        state.skipped_binary_files += 1
        return True
    if _skip_if_oversized(state, candidate, workspace, _max_search_file_bytes(), LARGE_FILE_HINT):
        return True
    try:
        result: FileSearchResult | None = _search_file_with_timeout(
            candidate,
            compiled,
            workspace=workspace,
            context_lines=context_lines,
            max_output_matches=state.remaining_output_matches,
            max_output_bytes=state.remaining_output_bytes,
            worker=worker,
        )
    except FutureTimeoutError:
        result = None
    state.candidate_files += 1
    if result is None:
        return _record_timeout(state, candidate)
    state.consume(result)
    return True


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
) -> Iterator[Path]:
    """The candidate walk (``grep_search_file``); knowledge search shares it."""
    return iter_candidate_files(
        search_root, workspace, include_patterns, budget_exhausted=budget_exhausted
    )


def _matches_glob(path: Path, *, search_root: Path, pattern: str) -> bool:
    """``include_glob`` matching, shared with ``glob_files`` (``**`` spans directories)."""
    return matches_relative_glob(path.relative_to(search_root).as_posix(), pattern)


_GREP_WORKER_FLAG = "--grep-search-worker"
_WORKER_PROTOCOL_MAX_LINE_CHARS = 64 * 1024
_WORKER_STDERR_MAX_CHARS = 2000
_WORKER_EOF = object()


def _grep_worker_command() -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, _GREP_WORKER_FLAG]
    return [sys.executable, "-m", "sidecar", _GREP_WORKER_FLAG]


class _WorkerUnavailable(ToolExecutionFailure):
    """The regex worker itself failed (start, pipes, exit); never one file's error."""


class _RegexSearchWorker:
    """Persistent regex worker with dedicated, non-MCP stdio pipes.

    Python's Windows ``multiprocessing`` bootstrap can deadlock before the target
    is entered when another thread is blocked reading the parent's stdin pipe.
    The builtin MCP server necessarily has exactly such a thread so cancellation
    notifications can interrupt a running tool. An explicit subprocess gives the
    regex worker its own stdin/stdout pair, avoids that inherited-stream bootstrap,
    and still preserves the hard kill boundary required for pathological regexes.
    """

    def __init__(
        self,
        *,
        popen_factory: Callable[..., subprocess.Popen[str]] | None = None,
        command_factory: Callable[[], Sequence[str]] | None = None,
    ) -> None:
        self._popen_factory = popen_factory or subprocess.Popen
        self._command_factory = command_factory or _grep_worker_command
        self._process: subprocess.Popen[str] | None = None
        self._responses: queue.Queue[object] | None = None
        self._stderr_tail = ""
        self._stderr_lock = threading.Lock()

    def search(
        self,
        *,
        path: Path,
        compiled: re.Pattern[str],
        workspace_root: Path | None,
        context_lines: int,
        max_output_matches: int,
        max_output_bytes: int,
        timeout_seconds: float,
    ) -> FileSearchResult:
        return self.request(
            {
                "path": str(path),
                "pattern": compiled.pattern,
                "flags": int(compiled.flags),
                "workspace_root": str(workspace_root) if workspace_root is not None else "",
                "hosted_file_io": hosted_file_io_enabled(),
                "context_lines": context_lines,
                "max_output_matches": max_output_matches,
                "max_output_bytes": max_output_bytes,
            },
            timeout_seconds,
        )

    def request(self, request: dict[str, object], timeout_seconds: float) -> FileSearchResult:
        """Send one search request (a file path, or a ``lines`` chunk) to the worker."""

        self._ensure_started()
        process = self._process
        responses = self._responses
        if process is None or process.stdin is None or responses is None:
            raise _WorkerUnavailable(
                code=CMP_TOOL_IO_FAILED,
                message="grep worker failed to start",
                retryable=True,
            )
        try:
            process.stdin.write(_encode_worker_message(request))
            process.stdin.flush()
        except (BrokenPipeError, OSError, ValueError) as error:
            self._reset(force=True)
            raise _WorkerUnavailable(
                code=CMP_TOOL_IO_FAILED,
                message=f"grep worker communication failed: {error}",
                retryable=True,
            ) from error

        response = self._wait_for_response(timeout_seconds)
        if response is _WORKER_EOF:
            detail = self._bounded_stderr_detail()
            self._reset(force=True)
            suffix = f": {detail}" if detail else ""
            raise _WorkerUnavailable(
                code=CMP_TOOL_IO_FAILED,
                message=f"grep worker exited unexpectedly{suffix}",
                retryable=True,
            )
        if response is None:
            alive = process.poll() is None
            self._reset(force=True)
            if not alive:
                raise _WorkerUnavailable(
                    code=CMP_TOOL_IO_FAILED,
                    message="grep worker exited unexpectedly",
                    retryable=True,
                )
            raise FutureTimeoutError()
        return _response_to_search_result(response)

    def close(self) -> None:
        self._reset(force=False)

    def _ensure_started(self) -> None:
        if self._process is not None and self._process.poll() is None:
            return
        self._reset(force=True)
        try:
            process = self._popen_factory(
                list(self._command_factory()),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
        except (OSError, ValueError) as error:
            raise _WorkerUnavailable(
                code=CMP_TOOL_IO_FAILED,
                message=f"grep worker failed to start: {error}",
                retryable=True,
            ) from error
        if process.stdin is None or process.stdout is None or process.stderr is None:
            process.kill()
            process.wait(timeout=_WORKER_JOIN_TIMEOUT_SECONDS)
            raise _WorkerUnavailable(
                code=CMP_TOOL_IO_FAILED,
                message="grep worker failed to create dedicated protocol pipes",
                retryable=True,
            )

        self._process = process
        self._responses = queue.Queue()
        self._stderr_tail = ""
        threading.Thread(
            target=self._pump_stdout,
            args=(process.stdout, self._responses),
            name="grep-worker-stdout",
            daemon=True,
        ).start()
        threading.Thread(
            target=self._pump_stderr,
            args=(process.stderr,),
            name="grep-worker-stderr",
            daemon=True,
        ).start()

        ready_message = self._wait_for_response(REGEX_WORKER_STARTUP_TIMEOUT_SECONDS)
        if ready_message is None:
            message = (
                "grep worker exited during startup"
                if process.poll() is not None
                else "grep worker startup timed out"
            )
            self._reset(force=True)
            raise _WorkerUnavailable(
                code=CMP_TOOL_IO_FAILED,
                message=message,
                retryable=True,
            )
        if ready_message is _WORKER_EOF:
            detail = self._bounded_stderr_detail()
            self._reset(force=True)
            suffix = f": {detail}" if detail else ""
            raise _WorkerUnavailable(
                code=CMP_TOOL_IO_FAILED,
                message=f"grep worker exited during startup{suffix}",
                retryable=True,
            )
        if ready_message != _WORKER_READY_MESSAGE:
            self._reset(force=True)
            raise _WorkerUnavailable(
                code=CMP_TOOL_IO_FAILED,
                message="grep worker returned an invalid readiness response",
                retryable=True,
            )

    def _wait_for_response(self, timeout_seconds: float) -> object | None:
        responses = self._responses
        if responses is None:
            return _WORKER_EOF
        try:
            return responses.get(timeout=max(0.0, float(timeout_seconds)))
        except queue.Empty:
            return None

    def _pump_stdout(self, stream: IO[str], responses: queue.Queue[object]) -> None:
        try:
            while True:
                line = stream.readline(_WORKER_PROTOCOL_MAX_LINE_CHARS + 1)
                if not line:
                    break
                if len(line) > _WORKER_PROTOCOL_MAX_LINE_CHARS or not line.endswith("\n"):
                    responses.put({
                        "status": "error",
                        "error_code": CMP_TOOL_IO_FAILED,
                        "message": "grep worker response exceeded its protocol limit",
                        "retryable": True,
                    })
                    break
                try:
                    responses.put(json.loads(line))
                except json.JSONDecodeError:
                    responses.put({
                        "status": "error",
                        "error_code": CMP_TOOL_IO_FAILED,
                        "message": "grep worker returned invalid JSON",
                        "retryable": True,
                    })
                    break
        except (OSError, ValueError):
            pass
        finally:
            responses.put(_WORKER_EOF)

    def _pump_stderr(self, stream: IO[str]) -> None:
        try:
            while True:
                chunk = stream.read(512)
                if not chunk:
                    return
                with self._stderr_lock:
                    self._stderr_tail = (self._stderr_tail + chunk)[-_WORKER_STDERR_MAX_CHARS:]
        except (OSError, ValueError):
            return

    def _bounded_stderr_detail(self) -> str:
        with self._stderr_lock:
            return " ".join(self._stderr_tail.strip().split())[-_WORKER_STDERR_MAX_CHARS:]

    def _reset(self, *, force: bool) -> None:
        process = self._process
        self._process = None
        self._responses = None
        if process is not None:
            _shutdown_worker_process(process, force=force)


def _shutdown_worker_process(process: subprocess.Popen[str], *, force: bool) -> None:
    if not force and process.poll() is None and process.stdin is not None:
        try:
            process.stdin.write(_encode_worker_message(None))
            process.stdin.flush()
        except (BrokenPipeError, OSError, ValueError):
            pass
    _close_worker_stream(process.stdin)
    _reap_worker_process(process)
    _close_worker_stream(process.stdout)
    _close_worker_stream(process.stderr)


def _reap_worker_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is None:
        try:
            process.wait(timeout=_WORKER_JOIN_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            process.terminate()
    if process.poll() is None:
        try:
            process.wait(timeout=_WORKER_JOIN_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def _close_worker_stream(stream: IO[str] | None) -> None:
    if stream is None:
        return
    try:
        stream.close()
    except OSError:
        pass


def _search_file_with_timeout(
    path: Path,
    compiled: re.Pattern[str],
    *,
    workspace: WorkspaceGuard,
    context_lines: int,
    max_output_matches: int,
    max_output_bytes: int,
    worker: _RegexSearchWorker | None = None,
) -> FileSearchResult:
    active_worker = worker or _RegexSearchWorker()
    try:
        return active_worker.search(
            path=path,
            compiled=compiled,
            workspace_root=workspace.root,
            context_lines=context_lines,
            max_output_matches=max_output_matches,
            max_output_bytes=max_output_bytes,
            timeout_seconds=REGEX_SEARCH_TIMEOUT_SECONDS,
        )
    finally:
        if worker is None:
            active_worker.close()


def _encode_worker_message(payload: object) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if len(encoded) > _WORKER_PROTOCOL_MAX_LINE_CHARS:
        raise ValueError("grep worker request exceeded its protocol limit")
    return encoded + "\n"


def _grep_search_worker_main(
    input_stream: IO[str] | None = None,
    output_stream: IO[str] | None = None,
) -> int:
    source = input_stream if input_stream is not None else sys.stdin
    sink = output_stream if output_stream is not None else sys.stdout
    sink.write(_encode_worker_message(_WORKER_READY_MESSAGE))
    sink.flush()
    while True:
        line = source.readline(_WORKER_PROTOCOL_MAX_LINE_CHARS + 1)
        if not line:
            return 0
        if len(line) > _WORKER_PROTOCOL_MAX_LINE_CHARS or not line.endswith("\n"):
            response = worker_error_response(
                code=CMP_TOOL_IO_FAILED,
                message="grep worker request exceeded its protocol limit",
                retryable=True,
            )
        else:
            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                response = worker_error_response(
                    code=CMP_TOOL_IO_FAILED,
                    message="grep worker received invalid JSON",
                    retryable=True,
                )
            else:
                if request is None:
                    return 0
                response = _run_worker_request(request)
        sink.write(_encode_worker_message(response))
        sink.flush()


def _run_worker_request(request: object) -> dict[str, object]:
    if not isinstance(request, dict):
        return worker_error_response(
            code=CMP_TOOL_IO_FAILED,
            message="grep worker received an invalid request payload",
            retryable=True,
        )
    if "lines" in request:
        return run_lines_request(request)
    try:
        path_value = request.get("path")
        pattern_value = request.get("pattern")
        flags_value = request.get("flags", 0)
        context_lines_value = request.get("context_lines", 0)
        max_output_matches_value = request.get("max_output_matches", 0)
        max_output_bytes_value = request.get("max_output_bytes", 0)
        workspace_root_value = request.get("workspace_root")
        if not isinstance(path_value, str) or not isinstance(pattern_value, str):
            raise ToolExecutionFailure(
                code=CMP_TOOL_IO_FAILED,
                message="grep worker received an invalid path or pattern",
                retryable=True,
            )
        compiled = re.compile(pattern_value, int(flags_value))
        workspace_root = (
            Path(workspace_root_value)
            if isinstance(workspace_root_value, str) and workspace_root_value
            else None
        )
        configure_hosted_file_io(
            str(workspace_root) if workspace_root else None,
            enabled=request.get("hosted_file_io") is True,
        )
        result = search_file(
            Path(path_value),
            compiled,
            workspace_root,
            int(context_lines_value),
            int(max_output_matches_value),
            int(max_output_bytes_value),
        )
    except ToolExecutionFailure as error:
        return worker_error_response(
            code=error.code,
            message=error.message,
            retryable=error.retryable,
        )
    except Exception as error:  # noqa: BLE001
        return worker_error_response(
            code=CMP_TOOL_IO_FAILED,
            message=f"grep worker failed: {error}",
            retryable=True,
        )
    return worker_ok_response(result)


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
