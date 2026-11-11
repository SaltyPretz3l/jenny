"""The regex worker process behind ``grep_search``: its request loop and the batched file scan.

The model's pattern runs only here, in a child process the parent can kill. Two
request shapes share one JSON-lines protocol:

- one request, one response: a file path (``search_file``) or a ``lines`` chunk
  (PDF pages, ``knowledge_search``'s ``lines`` and ``match_summary``);
- ``scan_batch`` (row 124 P1): an ordered list of file paths, answered with one
  response per file, in order, as each finishes. The worker opens each file once:
  the binary sniff, the size check, the open-time workspace check and the scan all
  use that handle, in the order the parent used to apply them file by file. It
  tracks the remaining output caps itself exactly as the parent's state would, so
  the result is the one the per-file protocol produced. The parent keeps its
  per-file timeout on every response, so a slow pattern is still killed.

This module imports only what the worker needs, so the worker starts lighter than
the parent's tool module.
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
from concurrent.futures import TimeoutError as FutureTimeoutError
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Callable, Generator, Protocol, Sequence

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.tools.builtins.file_state import (
    MAX_BINARY_SCAN_BYTES,
    is_binary_content,
    open_regular_file,
)
from sidecar.ai.tools.builtins.grep_search_file import (
    FileSearchResult,
    run_lines_request,
    search_file,
    search_lines,
    search_result_from_response,
    worker_error_response,
    worker_ok_response,
    workspace_relative_path,
)
from sidecar.ai.tools.builtins.handle_containment import (
    FinalRoot,
    resolve_final_root,
    verify_handle_within,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.hosted_file_io import configure_hosted_file_io, hosted_file_io_enabled

WORKER_PROTOCOL_MAX_LINE_CHARS = 64 * 1024
WORKER_READY_MESSAGE = {"status": "ready"}
SCAN_BATCH_OP = "scan_batch"
# A batch request stays well inside the protocol line limit: paths plus a small header.
MAX_BATCH_PATH_CHARS = 32 * 1024
MAX_BATCH_FILES = 128
_STATUS_BINARY = "binary"
_STATUS_LARGE = "large"
_REGEX_METACHARACTERS = frozenset(".^$*+?{}[]\\()")
_EMPTY_RESULT = FileSearchResult(
    lines=[],
    returned_match_count=0,
    total_match_count=0,
    truncated=False,
    truncated_by_bytes=False,
    truncated_by_line_length=False,
    output_bytes_used=0,
)


def encode_worker_message(payload: object) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if len(encoded) > WORKER_PROTOCOL_MAX_LINE_CHARS:
        raise ValueError("grep worker request exceeded its protocol limit")
    return encoded + "\n"


def grep_search_worker_main(
    input_stream: IO[str] | None = None,
    output_stream: IO[str] | None = None,
) -> int:
    if input_stream is None and output_stream is None:
        # The parent speaks UTF-8. Without this a Windows worker started without
        # PYTHONIOENCODING (production sets it) used the ANSI code page: a match
        # holding a BOM or U+FFFD crashed it and aborted the search.
        for stream in (sys.stdin, sys.stdout):
            reconfigure = getattr(stream, "reconfigure", None)
            if callable(reconfigure):
                reconfigure(encoding="utf-8", errors="strict")
    source = input_stream if input_stream is not None else sys.stdin
    sink = output_stream if output_stream is not None else sys.stdout

    def emit(response: object) -> None:
        sink.write(encode_worker_message(response))
        sink.flush()

    emit(WORKER_READY_MESSAGE)
    while True:
        line = source.readline(WORKER_PROTOCOL_MAX_LINE_CHARS + 1)
        if not line:
            return 0
        if len(line) > WORKER_PROTOCOL_MAX_LINE_CHARS or not line.endswith("\n"):
            emit(worker_error_response(
                code=CMP_TOOL_IO_FAILED,
                message="grep worker request exceeded its protocol limit",
                retryable=True,
            ))
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            emit(worker_error_response(
                code=CMP_TOOL_IO_FAILED,
                message="grep worker received invalid JSON",
                retryable=True,
            ))
            continue
        if request is None:
            return 0
        if isinstance(request, dict) and request.get("op") == SCAN_BATCH_OP:
            run_scan_batch_request(request, emit)
        else:
            emit(run_worker_request(request))


def run_worker_request(request: object) -> dict[str, object]:
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
        if not isinstance(path_value, str) or not isinstance(pattern_value, str):
            raise ToolExecutionFailure(
                code=CMP_TOOL_IO_FAILED,
                message="grep worker received an invalid path or pattern",
                retryable=True,
            )
        compiled = re.compile(pattern_value, int(request.get("flags", 0)))
        workspace_root = _configure_root(request)
        result = search_file(
            Path(path_value),
            compiled,
            workspace_root,
            int(request.get("context_lines", 0)),
            int(request.get("max_output_matches", 0)),
            int(request.get("max_output_bytes", 0)),
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


def _configure_root(request: dict[str, object]) -> Path | None:
    value = request.get("workspace_root")
    workspace_root = Path(value) if isinstance(value, str) and value else None
    configure_hosted_file_io(
        str(workspace_root) if workspace_root else None,
        enabled=request.get("hosted_file_io") is True,
    )
    return workspace_root


# --- Batched scan: worker side -------------------------------------------------


@dataclass(frozen=True)
class _ScanSettings:
    compiled: re.Pattern[str]
    workspace_root: Path | None
    hosted: bool
    context_lines: int
    max_file_bytes: int
    literals: tuple[bytes, ...] | None
    # Resolved once per batch for the desktop open-time check; None fails closed.
    final_root: FinalRoot | None = None


def run_scan_batch_request(request: dict[str, object], emit: Callable[[object], None]) -> None:
    """Answer a ``scan_batch`` request with exactly one response per listed file, in order."""
    files = request.get("files")
    if not isinstance(files, list) or not all(isinstance(item, str) for item in files):
        emit(worker_error_response(
            code=CMP_TOOL_IO_FAILED,
            message="grep worker received an invalid scan batch",
            retryable=True,
        ))
        return
    try:
        pattern = str(request["pattern"])
        flags = int(str(request.get("flags", 0)))
        workspace_root = _configure_root(request)
        hosted = request.get("hosted_file_io") is True
        settings = _ScanSettings(
            compiled=re.compile(pattern, flags),
            workspace_root=workspace_root,
            hosted=hosted,
            context_lines=int(str(request.get("context_lines", 0))),
            max_file_bytes=int(str(request["max_file_bytes"])),
            literals=literal_alternatives(pattern, flags),
            final_root=(
                None if hosted or workspace_root is None else resolve_final_root(workspace_root)
            ),
        )
        remaining_matches = int(str(request.get("max_output_matches", 0)))
        remaining_bytes = int(str(request.get("max_output_bytes", 0)))
    except Exception as error:  # noqa: BLE001 - one error answer per file keeps the count
        failure = worker_error_response(
            code=CMP_TOOL_IO_FAILED, message=f"grep worker failed: {error}", retryable=True
        )
        for _ in files:
            emit(failure)
        return
    for path_value in files:
        response, result = scan_one_file(
            Path(path_value), settings, remaining_matches, remaining_bytes
        )
        emit(response)
        if result is not None and result.total_match_count:
            # The parent's _SearchState.consume, applied ahead of it.
            remaining_matches = max(0, remaining_matches - result.returned_match_count)
            remaining_bytes = max(0, remaining_bytes - result.output_bytes_used)


def scan_one_file(
    path: Path, settings: _ScanSettings, max_output_matches: int, max_output_bytes: int
) -> tuple[dict[str, object], FileSearchResult | None]:
    """Sniff, size-check, verify and search one file through a single open handle.

    Returns the response and, for a searched file, its result.
    """
    raw = _read_for_scan(path, settings)
    if isinstance(raw, dict):
        return raw, None
    try:
        if settings.literals is not None and not any(item in raw for item in settings.literals):
            return worker_ok_response(_EMPTY_RESULT), _EMPTY_RESULT
        # The same decoder search_file's text-mode open builds.
        text = io.TextIOWrapper(io.BytesIO(raw), encoding="utf-8", errors="replace", newline="")
        result = search_lines(
            text,
            settings.compiled,
            workspace_relative_path(path, settings.workspace_root),
            settings.context_lines,
            max_output_matches,
            max_output_bytes,
        )
    except Exception as error:  # noqa: BLE001
        return worker_error_response(
            code=CMP_TOOL_IO_FAILED, message=f"grep worker failed: {error}", retryable=True
        ), None
    return worker_ok_response(result), result


def _read_for_scan(path: Path, settings: _ScanSettings) -> bytes | dict[str, object]:
    """The file's bytes, or the response that ends its scan (binary, large, error)."""
    try:
        # Desktop opens plainly and verifies the handle after the sniff and size
        # check, the order the parent used; hosted opens descriptor-relative.
        opener = open_regular_file(path, "rb") if settings.hosted else open(path, "rb")
        with opener as handle:
            head = handle.read(MAX_BINARY_SCAN_BYTES)
            if is_binary_content(head):
                return {"status": _STATUS_BINARY}
            if os.fstat(handle.fileno()).st_size > settings.max_file_bytes:
                return {"status": _STATUS_LARGE}
            if not settings.hosted and settings.workspace_root is not None:
                verify_handle_within(handle, path, settings.final_root)
            # A short first read already reached the end of the file.
            return head if len(head) < MAX_BINARY_SCAN_BYTES else head + handle.read()
    except ToolExecutionFailure as error:
        return worker_error_response(
            code=error.code, message=error.message, retryable=error.retryable
        )
    except Exception as error:  # noqa: BLE001 - one file's failure, never the worker's
        return worker_error_response(
            code=CMP_TOOL_IO_FAILED, message=f"grep worker failed: {error}", retryable=True
        )


def literal_alternatives(pattern: str, flags: int) -> tuple[bytes, ...] | None:
    """UTF-8 bytes of each alternative when ``pattern`` is plain text joined by ``|``.

    Then a line matches only if it contains one alternative verbatim, and a file
    whose raw bytes hold none of them has no matching line, so the worker can skip
    decoding it. Exact: no metacharacter, no case folding, no empty alternative
    (which matches every line), and no character a decode could produce from other
    bytes (U+FFFD) or that crosses a line (CR, LF). Anything else returns None and
    gets the full line scan.
    """
    if flags & ~re.UNICODE or not pattern:
        return None
    if any(char in _REGEX_METACHARACTERS or char in "\r\n�" for char in pattern):
        return None
    parts = pattern.split("|")
    if not all(parts):
        return None
    try:
        return tuple(part.encode("utf-8") for part in parts)
    except UnicodeEncodeError:  # a lone surrogate
        return None


# --- Batched scan: parent side -------------------------------------------------


class BatchWorker(Protocol):
    """The two calls the batch driver needs from grep_search's ``_RegexSearchWorker``."""

    def send(self, request: dict[str, object], *, expected_responses: int = 1) -> None: ...

    def receive(self, timeout_seconds: float) -> object: ...


@dataclass(frozen=True)
class ScanOutcome:
    """One file's answer: ``kind`` is result, binary, large, timeout or error."""

    kind: str
    result: FileSearchResult | None = None
    error: ToolExecutionFailure | None = None


def scan_text_batches(  # noqa: PLR0913
    worker: BatchWorker,
    paths: Sequence[Path],
    compiled: re.Pattern[str],
    *,
    workspace_root: Path | None,
    context_lines: int,
    max_output_matches: int,
    max_output_bytes: int,
    max_file_bytes: int,
    timeout_seconds: float,
) -> Generator[ScanOutcome, None, None]:
    """Yield one outcome per path, in order, scanning through ``worker`` in batches.

    Lazy: nothing is sent until the first outcome is asked for, and a caller that
    stops early leaves the worker to be discarded. A timeout kills the worker (its
    ``receive`` does); the files after the slow one go to a fresh worker.
    """
    remaining_matches, remaining_bytes = max_output_matches, max_output_bytes
    index = 0
    hosted = hosted_file_io_enabled()
    while index < len(paths):
        chunk = _next_chunk(paths, index)
        worker.send(
            {
                "op": SCAN_BATCH_OP,
                "files": [str(path) for path in chunk],
                "pattern": compiled.pattern,
                "flags": int(compiled.flags),
                "workspace_root": str(workspace_root) if workspace_root is not None else "",
                "hosted_file_io": hosted,
                "context_lines": context_lines,
                "max_output_matches": remaining_matches,
                "max_output_bytes": remaining_bytes,
                "max_file_bytes": max_file_bytes,
            },
            expected_responses=len(chunk),
        )
        for _ in chunk:
            index += 1
            try:
                outcome = _outcome_from_response(worker.receive(timeout_seconds))
            except FutureTimeoutError:
                yield ScanOutcome("timeout")
                break  # the worker was killed: resend the rest of the chunk
            result = outcome.result
            if result is not None and result.total_match_count:
                remaining_matches = max(0, remaining_matches - result.returned_match_count)
                remaining_bytes = max(0, remaining_bytes - result.output_bytes_used)
            yield outcome


def _next_chunk(paths: Sequence[Path], start: int) -> Sequence[Path]:
    end, used = start, 0
    while end < len(paths) and end - start < MAX_BATCH_FILES:
        used += len(json.dumps(str(paths[end]), ensure_ascii=False)) + 1
        if used > MAX_BATCH_PATH_CHARS and end > start:
            break
        end += 1
    return paths[start:end]


def _outcome_from_response(response: object) -> ScanOutcome:
    status = response.get("status") if isinstance(response, dict) else None
    if status in (_STATUS_BINARY, _STATUS_LARGE):
        return ScanOutcome(str(status))
    try:
        return ScanOutcome("result", result=search_result_from_response(response))
    except ToolExecutionFailure as error:
        return ScanOutcome("error", error=error)
