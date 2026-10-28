"""knowledge_view — paginated document reads from the knowledge folders.

Text files stream line-windows directly; rich formats (pdf/docx/xlsx/pptx/
ipynb) dispatch to the rich-file inspect adapters injected at registration
time (see registry.py), each validated against the owning root's guard.
Every view carries the source's current ``source_hash``. An optional ``locator``
(``L10-12``, ``p2``, ``para3``) is checked against the file's kind before any
read, sets the read window when none is given, and is range-checked against the
extent the read reports.
"""

from __future__ import annotations

import json
import os
import re
import threading
from collections import OrderedDict
from collections.abc import Callable
from pathlib import Path

from sidecar.ai.error_codes import (
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_IO_FAILED,
    CMP_TOOL_RICH_FILES_DEPENDENCY_MISSING,
)
from sidecar.ai.semantic.evidence import locator_check, pdf_evidence, source_hash
from sidecar.ai.tools.argument_coercion import bounded_int as _bounded_int
from sidecar.ai.tools.builtins.file_state import is_binary_file, open_regular_file
from sidecar.ai.tools.builtins.knowledge.roots import (
    KnowledgeRoot,
    bound_snippet,
    build_sources,
    resolve_knowledge_path,
    rich_adapters,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult

DEFAULT_VIEW_LIMIT = 200
MAX_VIEW_LIMIT = 500
MAX_LINE_CHARS = 500
MAX_OUTPUT_BYTES = 20_000
# Mirrors the rich-file source ceiling so text and rich reads degrade alike.
MAX_TEXT_FILE_BYTES = 25 * 1024 * 1024
MAX_LOCATOR_ECHO_CHARS = 64
# The summary field each rich adapter reports a locator kind's extent in. Docx
# paragraph_count counts every paragraph, an upper bound on catalog ``para<N>``.
_EXTENT_KEYS = {"pages": "page_count", "paragraphs": "paragraph_count"}

_ADAPTER_BY_EXTENSION: dict[str, str] = {
    ".pdf": "pdf",
    ".docx": "document",
    ".docm": "document",
    ".xlsx": "spreadsheet",
    ".xlsm": "spreadsheet",
    ".pptx": "presentation",
    ".pptm": "presentation",
    ".ipynb": "notebook",
}


def knowledge_view_tool(
    arguments: dict[str, object],
    workspace: object,
) -> ToolHandlerResult:
    _ = workspace  # knowledge tools are scoped to registered roots, not the workspace
    root, resolved, display = resolve_knowledge_path(arguments.get("path"))
    if not resolved.is_file():
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"path must point to a file: {display}",
            retryable=False,
        )
    adapter_key = _ADAPTER_BY_EXTENSION.get(resolved.suffix.lower())
    requested = arguments.get("locator")
    locator, verdict, kind = locator_check(requested, resolved)
    if verdict != "ok":
        return _invalid_locator(display, verdict, requested, kind)
    window = arguments
    if locator is not None:
        window = _locator_window(arguments, adapter_key, locator.start, locator.end)

    def read() -> ToolHandlerResult:
        if adapter_key is not None:
            return _view_rich(root, resolved, display, adapter_key=adapter_key, arguments=window)
        return _view_text(root, resolved, display, arguments=window,
                          count_to_eof=locator is not None)

    try:
        result = _view_with_identity(root, resolved, display, arguments, read)
    except ToolExecutionFailure as error:
        # A page window derived from the locator ran past the PDF's last page.
        if window is not arguments and adapter_key == "pdf" and "references page" in error.message:
            return _invalid_locator(display, "locator_out_of_range", requested, kind)
        raise
    if locator is None or not result.success:
        return result
    extent = _reported_extent(result, kind, adapter_key)
    _, verdict, _ = locator_check(requested, resolved, extent=extent)
    return result if verdict == "ok" else _invalid_locator(display, verdict, requested, kind)


def _locator_window(
    arguments: dict[str, object], adapter_key: str | None, start: int, end: int,
) -> dict[str, object]:
    """The locator's own read window, unless the caller passed an explicit one."""
    if adapter_key is None and arguments.get("offset") is None and arguments.get("limit") is None:
        return {**arguments, "offset": start - 1, "limit": min(end - start + 1, MAX_VIEW_LIMIT)}
    if adapter_key == "pdf" and arguments.get("pages") is None and arguments.get("cursor") is None:
        return {**arguments, "pages": f"{start}-{end}"}
    return arguments


def _reported_extent(result: ToolHandlerResult, kind: str, adapter_key: str | None) -> int | None:
    """The line/page/paragraph count the read reported, when it reported one."""
    payload = json.loads(result.output)
    value: object = None
    if adapter_key is None:
        value = payload.get("total_lines")
    elif isinstance(payload.get("summary"), dict) and kind in _EXTENT_KEYS:
        value = payload["summary"].get(_EXTENT_KEYS[kind])
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _invalid_locator(
    display: str, reason: str, requested: object, expected_kind: str,
) -> ToolHandlerResult:
    return ToolHandlerResult(output=json.dumps({"path": display, "reason": reason,
        "locator": str(requested)[:MAX_LOCATOR_ECHO_CHARS],
        "expected_locator_kind": expected_kind, "status": "unavailable", "sources": [],
        "missing_source_metadata": True,
        "message": (f"This locator does not fit this file; use the {expected_kind} locator "
                    "knowledge_search returned for it, or omit locator.")}),
        success=False, error_code=CMP_TOOL_INVALID_PATH)


def _changed_source(display: str) -> ToolHandlerResult:
    return ToolHandlerResult(output=json.dumps({"path": display, "reason": "source_changed",
        "status": "unavailable", "sources": [], "missing_source_metadata": True,
        "message": "The source changed since retrieval. Search again before citing it."}),
        success=False, error_code=CMP_TOOL_EXECUTION_FAILED)


_StatIdentity = tuple[str, int, int, int]
# Source hashes keyed by stat identity, so paging through one document hashes
# it once rather than once per page (bounded; least recently used drops first).
_HASH_MEMO_LIMIT = 64
_HASH_MEMO: OrderedDict[_StatIdentity, str] = OrderedDict()
_HASH_MEMO_LOCK = threading.Lock()


def _stat_identity(path: Path) -> _StatIdentity | None:
    try:
        file_stat = os.stat(path)
    except OSError:
        return None
    return (os.path.realpath(path), file_stat.st_size, file_stat.st_mtime_ns, file_stat.st_ino)


def _memoized_source_hash(
    resolved: Path, root: KnowledgeRoot, identity: _StatIdentity | None,
) -> str:
    if identity is not None:
        with _HASH_MEMO_LOCK:
            cached = _HASH_MEMO.get(identity)
            if cached is not None:
                _HASH_MEMO.move_to_end(identity)
                return cached
    digest = source_hash(resolved, root.guard)
    if identity is not None and _stat_identity(resolved) == identity:
        with _HASH_MEMO_LOCK:
            _HASH_MEMO[identity] = digest
            while len(_HASH_MEMO) > _HASH_MEMO_LIMIT:
                _HASH_MEMO.popitem(last=False)
    return digest


def _view_with_identity(
    root: KnowledgeRoot, resolved: Path, display: str, arguments: dict[str, object],
    read: Callable[[], ToolHandlerResult],
) -> ToolHandlerResult:
    expected = arguments.get("expected_source_hash")
    if expected is not None and (
        not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected)
    ):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="expected_source_hash must be a SHA-256 hash", retryable=False)
    is_pdf = resolved.suffix.lower() == ".pdf"
    identity = _stat_identity(resolved)
    before = _memoized_source_hash(resolved, root, identity)
    if expected is not None and before != expected:
        return _changed_source(display)
    result = read()
    # A rewrite during the read changes the stat identity; no second full hash.
    if identity is None or _stat_identity(resolved) != identity:
        return _changed_source(display)
    payload = json.loads(result.output)
    payload["source_hash"] = before
    for source in payload.get("sources", []):
        source["source_hash"] = before
    if is_pdf:
        summary = payload.get("summary", {})
        pages = summary.get("pages", [])
        missing = [p["page"] for p in pages if not p.get("text_layer")]
        ocr = [{"page": p["page"], "engine": p.get("ocr_engine")}
               for p in pages if p.get("ocr") and p.get("text_excerpt")]
        has_text = any(p.get("text_layer") for p in pages) or bool(ocr)
        info = pdf_evidence(source_hash=before, total_pages=summary.get("page_count"),
                            examined_pages=len(pages), pages_without_text=missing,
                            budget_truncation="view_window" if summary.get("truncated") else None,
                            unavailable="needs_ocr" if pages and not has_text else
                            "pdf_unreadable" if not pages else None)
        if ocr:
            info["content_kind"] = "pdf_text_with_ocr"
            info["supplemental_ocr"] = ocr
        payload["extraction"] = info
        for source in payload.get("sources", []):
            source["extraction"] = info
    return ToolHandlerResult(output=json.dumps(payload, ensure_ascii=False), success=result.success,
                             error_code=result.error_code, metadata=result.metadata,
                             generated_artifacts=result.generated_artifacts)


def _view_text(
    root: KnowledgeRoot,
    resolved: Path,
    display: str,
    *,
    arguments: dict[str, object],
    count_to_eof: bool = False,
) -> ToolHandlerResult:
    if is_binary_file(resolved):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=(
                f"file appears to be binary: {display}. knowledge_view reads "
                "text files and pdf/docx/xlsx/pptx/ipynb documents"
            ),
            retryable=False,
        )
    root.guard.check_file_size(
        resolved,
        MAX_TEXT_FILE_BYTES,
        hint="The file is too large for knowledge_view.",
    )
    offset = _bounded_int(arguments.get("offset"), default=0, minimum=0, maximum=10_000_000)
    limit = _bounded_int(
        arguments.get("limit"),
        default=DEFAULT_VIEW_LIMIT,
        minimum=1,
        maximum=MAX_VIEW_LIMIT,
    )

    lines: list[str] = []
    total_lines = 0
    output_bytes = 0
    truncated_by_bytes = False
    has_more = False
    scanned_to_eof = True
    try:
        with open_regular_file(
            resolved,
            "r",
            authorized_root=root.guard.require_root(),
            encoding="utf-8",
            errors="replace",
            newline="",
        ) as handle:
            for line_number, line in enumerate(handle, start=1):
                total_lines = line_number
                if line_number <= offset:
                    continue
                if line_number > offset + limit:
                    # One line past the window proves has_more — stop instead
                    # of scanning the rest of a potentially large file.
                    has_more = True
                    scanned_to_eof = False
                    break
                content = line.rstrip("\r\n")
                if len(content) > MAX_LINE_CHARS:
                    content = content[:MAX_LINE_CHARS] + " [truncated]"
                encoded_bytes = len(content.encode("utf-8")) + (1 if lines else 0)
                if output_bytes + encoded_bytes > MAX_OUTPUT_BYTES:
                    truncated_by_bytes = True
                    has_more = True
                    scanned_to_eof = False
                    break
                lines.append(content)
                output_bytes += encoded_bytes
            if count_to_eof and not scanned_to_eof:
                # A cited locator is range-checked against the whole file.
                total_lines += sum(1 for _ in handle)
                scanned_to_eof = True
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"failed to read {display}: {error}",
            retryable=True,
        ) from error

    content_text = "\n".join(lines)
    payload: dict[str, object] = {
        "path": display,
        "offset": offset,
        "limit": limit,
        "returned_lines": len(lines),
        "has_more": has_more,
        "content": content_text,
        "sources": build_sources([(display, content_text)]),
        "missing_source_metadata": False,
    }
    if truncated_by_bytes:
        payload["truncated_by_bytes"] = True
    if scanned_to_eof:
        payload["total_lines"] = total_lines
    metadata: dict[str, object] = {
        "result_kind": "knowledge_view",
        "path": display,
        "returned_lines": len(lines),
        "has_more": has_more,
        "truncated_by_bytes": truncated_by_bytes,
    }
    return ToolHandlerResult(
        output=json.dumps(payload, ensure_ascii=False),
        metadata=metadata,
    )


def _view_rich(
    root: KnowledgeRoot,
    resolved: Path,
    display: str,
    *,
    adapter_key: str,
    arguments: dict[str, object],
) -> ToolHandlerResult:
    handler = rich_adapters().get(adapter_key)
    if handler is None:
        payload = {
            "path": display,
            "error": (
                f"the {adapter_key} inspector is not available in this build; "
                "knowledge_view cannot extract this document"
            ),
            "sources": [],
            "missing_source_metadata": True,
        }
        return ToolHandlerResult(
            output=json.dumps(payload, ensure_ascii=False),
            success=False,
            error_code=CMP_TOOL_RICH_FILES_DEPENDENCY_MISSING,
        )

    if root.path is None:  # pragma: no cover - resolve_knowledge_path guarantees this
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"knowledge folder for {display} is not accessible",
            retryable=False,
        )
    # knowledge_view is a read-only projection. Rich inspectors may expose
    # artifact-producing controls; only PDF and Word read pagination joins the path.
    adapter_arguments: dict[str, object] = {
        "path": resolved.relative_to(root.path).as_posix()
    }
    paging_keys = {"pdf": ("pages", "cursor"), "document": ("cursor",)}.get(adapter_key, ())
    for key in paging_keys:
        if key in arguments:
            adapter_arguments[key] = arguments[key]
    try:
        adapter_result = handler(adapter_arguments, root.guard)
    except ToolExecutionFailure:
        raise
    except Exception as error:  # noqa: BLE001 - adapter crashes must not kill the turn
        payload = {
            "path": display,
            "error": f"document extraction failed: {type(error).__name__}",
            "sources": [],
            "missing_source_metadata": True,
        }
        return ToolHandlerResult(
            output=json.dumps(payload, ensure_ascii=False),
            success=False,
            error_code=CMP_TOOL_EXECUTION_FAILED,
        )

    return _merge_sources_into_adapter_result(adapter_result, display=display)


def _merge_sources_into_adapter_result(
    adapter_result: ToolHandlerResult,
    *,
    display: str,
) -> ToolHandlerResult:
    try:
        parsed = json.loads(adapter_result.output)
    except ValueError:
        parsed = None
    payload: dict[str, object]
    if isinstance(parsed, dict):
        payload = parsed
    else:
        payload = {"result": adapter_result.output}
    summary = payload.get("summary")
    if isinstance(summary, dict) and isinstance(summary.get("continuation_hint"), str):
        summary["continuation_hint"] = summary["continuation_hint"].replace(
            "call read_file again", "call knowledge_view again"
        )
    snippet = bound_snippet(summary or payload.get("result") or "")
    payload["sources"] = build_sources([(display, snippet)])
    payload["missing_source_metadata"] = False
    return ToolHandlerResult(
        output=json.dumps(payload, ensure_ascii=False),
        success=adapter_result.success,
        generated_artifacts=adapter_result.generated_artifacts,
        error_code=adapter_result.error_code,
        metadata={
            **adapter_result.metadata,
            **({"summary": summary} if isinstance(summary, dict) else {}),
        },
    )
