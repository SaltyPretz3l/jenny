"""knowledge_view — paginated document reads from the knowledge folders.

Text files stream line-windows directly; rich formats (pdf/docx/xlsx/pptx/
ipynb) dispatch to the rich-file inspect adapters injected at registration
time (see registry.py), each validated against the owning root's guard.
"""

from __future__ import annotations

import json
from pathlib import Path

from sidecar.ai.error_codes import (
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_IO_FAILED,
    CMP_TOOL_RICH_FILES_DEPENDENCY_MISSING,
)
from sidecar.ai.tools.argument_coercion import bounded_int as _bounded_int
from sidecar.ai.tools.builtins.filesystem import is_binary_file
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
    if adapter_key is not None:
        return _view_rich(
            root,
            resolved,
            display,
            adapter_key=adapter_key,
            arguments=arguments,
        )
    return _view_text(root, resolved, display, arguments=arguments)


def _view_text(
    root: KnowledgeRoot,
    resolved: Path,
    display: str,
    *,
    arguments: dict[str, object],
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
        with resolved.open("r", encoding="utf-8", errors="replace", newline="") as handle:
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
    # additional artifact-producing controls, so forward only the path owned
    # by this adapter rather than arbitrary caller keys.
    adapter_arguments: dict[str, object] = {
        "path": resolved.relative_to(root.path).as_posix()
    }
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
    snippet = bound_snippet(payload.get("summary") or payload.get("result") or "")
    payload["sources"] = build_sources([(display, snippet)])
    payload["missing_source_metadata"] = False
    return ToolHandlerResult(
        output=json.dumps(payload, ensure_ascii=False),
        success=adapter_result.success,
        generated_artifacts=adapter_result.generated_artifacts,
        error_code=adapter_result.error_code,
        metadata=adapter_result.metadata,
    )
