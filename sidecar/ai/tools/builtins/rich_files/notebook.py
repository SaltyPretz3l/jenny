"""Read-only Jupyter notebook inspect tool."""

from __future__ import annotations

import json
import re
from collections import Counter
from typing import Any

from sidecar.ai.tools.builtins import filesystem_content
from sidecar.ai.tools.builtins.rich_files.base import (
    RichFileSource,
    RichInspectResult,
    build_unsupported_result,
    read_bounded_file_bytes,
    rich_inspect_result_to_tool_result,
    string_argument,
    validate_rich_file_source,
)
from sidecar.ai.tools.builtins.rich_files.ooxml import (
    bounded_excerpt,
    collapse_whitespace,
    integer_cap,
)
from sidecar.ai.tools.contracts import ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard

SUPPORTED_NOTEBOOK_EXTENSIONS = frozenset({".ipynb"})
DEFAULT_MAX_CELLS = 30
MAX_CELLS = 100
DEFAULT_MAX_SOURCE_CHARS = 400
MAX_SOURCE_CHARS = 1000
KNOWN_CELL_TYPES = frozenset({"code", "markdown", "raw"})
KNOWN_OUTPUT_TYPES = frozenset(
    {"display_data", "error", "execute_result", "stream", "update_display_data"}
)
DATA_URI_RE = re.compile(r"data:[^\s\"'<>)}\]]+", re.IGNORECASE)


def notebook_inspect_tool(
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> ToolHandlerResult:
    requested_path = string_argument(arguments, "path", required=True)
    source = validate_rich_file_source(
        requested_path=requested_path,
        workspace=workspace,
        adapter="notebook",
        max_bytes=filesystem_content.MAX_MEDIA_FILE_BYTES,
    )
    if source.absolute_path.suffix.lower() not in SUPPORTED_NOTEBOOK_EXTENSIONS:
        return rich_inspect_result_to_tool_result(
            build_unsupported_result(
                adapter="notebook",
                source=source,
                reason="notebook_format_unsupported",
            )
        )

    caps = _inspect_caps(arguments)
    try:
        notebook = json.loads(
            read_bounded_file_bytes(
                source.absolute_path,
                max_bytes=filesystem_content.MAX_MEDIA_FILE_BYTES,
                message="notebook source changed beyond rich-file size limit",
            ).decode("utf-8")
        )
        if not isinstance(notebook, dict):
            raise ValueError("notebook root must be an object")
        result = _inspect_notebook(source=source, notebook=notebook, caps=caps)
    except Exception:  # noqa: BLE001
        return rich_inspect_result_to_tool_result(
            build_unsupported_result(
                adapter="notebook",
                source=source,
                reason="notebook_parse_failed",
            )
        )
    return rich_inspect_result_to_tool_result(result)


def _inspect_notebook(
    *,
    source: RichFileSource,
    notebook: dict[str, object],
    caps: dict[str, int],
) -> RichInspectResult:
    metadata = _dict_value(notebook.get("metadata"))
    cells = _list_value(notebook.get("cells"))
    sampled_cells, stats = _sample_cells(cells, caps=caps)
    summary = {
        "nbformat": _int_or_none(notebook.get("nbformat")),
        "nbformat_minor": _int_or_none(notebook.get("nbformat_minor")),
        "kernel_name": _kernel_name(metadata),
        "language": _language_name(metadata),
        "cell_count": len(cells),
        "cell_type_counts": dict(stats["cell_type_counts"]),
        "execution_count_present": stats["execution_count_present"],
        "outputs_present": stats["output_count"] > 0,
        "output_count": stats["output_count"],
        "output_type_counts": dict(stats["output_type_counts"]),
        "attachments_present": stats["attachments_present"],
        "widgets_metadata_present": _widgets_metadata_present(metadata),
        "hidden_source_cell_count": stats["hidden_source_cell_count"],
        "hidden_output_cell_count": stats["hidden_output_cell_count"],
        "omitted_cell_count": max(0, len(cells) - len(sampled_cells)),
        "sample_caps": caps,
        "cells": sampled_cells,
    }
    return RichInspectResult(
        status="inspected",
        adapter="notebook",
        source=source,
        summary=summary,
    )


def _sample_cells(
    cells: list[object],
    *,
    caps: dict[str, int],
) -> tuple[list[dict[str, object]], dict[str, Any]]:
    sampled: list[dict[str, object]] = []
    cell_type_counts: Counter[str] = Counter()
    output_type_counts: Counter[str] = Counter()
    stats: dict[str, Any] = {
        "cell_type_counts": cell_type_counts,
        "output_type_counts": output_type_counts,
        "output_count": 0,
        "execution_count_present": False,
        "attachments_present": False,
        "hidden_source_cell_count": 0,
        "hidden_output_cell_count": 0,
    }
    for index, raw_cell in enumerate(cells):
        cell = _dict_value(raw_cell)
        cell_type = _cell_type(cell.get("cell_type"))
        cell_type_counts[cell_type] += 1
        metadata = _dict_value(cell.get("metadata"))
        outputs = _list_value(cell.get("outputs"))
        output_types = _output_types(outputs)
        output_type_counts.update(output_types)
        stats["output_count"] += len(outputs)
        stats["execution_count_present"] |= cell.get("execution_count") is not None
        stats["attachments_present"] |= bool(cell.get("attachments"))
        source_hidden = _source_hidden(metadata)
        outputs_hidden = _outputs_hidden(metadata)
        stats["hidden_source_cell_count"] += int(source_hidden)
        stats["hidden_output_cell_count"] += int(outputs_hidden)
        if len(sampled) < caps["max_cells"]:
            sampled.append(
                _cell_payload(
                    cell=cell,
                    index=index,
                    output_types=output_types,
                    caps=caps,
                )
            )
    return sampled, stats


def _cell_payload(
    *,
    cell: dict[str, object],
    index: int,
    output_types: list[str],
    caps: dict[str, int],
) -> dict[str, object]:
    metadata = _dict_value(cell.get("metadata"))
    source_hidden = _source_hidden(metadata)
    outputs_hidden = _outputs_hidden(metadata)
    payload: dict[str, object] = {
        "index": index,
        "cell_type": _cell_type(cell.get("cell_type")),
        "source_hidden": source_hidden,
        "outputs_hidden": outputs_hidden,
        "output_count": len(output_types),
        "output_types": output_types,
        "attachments_present": bool(cell.get("attachments")),
    }
    if source_hidden:
        payload["source_skipped"] = "hidden_source"
        return payload
    excerpt, truncated = bounded_excerpt(
        _source_to_text(cell.get("source")),
        tool_name="notebook_inspect",
        max_chars=caps["max_source_chars_per_cell"],
    )
    payload["source_excerpt"] = excerpt
    payload["source_truncated"] = truncated
    return payload


def _inspect_caps(arguments: dict[str, object]) -> dict[str, int]:
    return {
        "max_cells": integer_cap(
            arguments,
            "max_cells",
            default=DEFAULT_MAX_CELLS,
            maximum=MAX_CELLS,
            tool_name="notebook inspect",
        ),
        "max_source_chars_per_cell": integer_cap(
            arguments,
            "max_source_chars_per_cell",
            default=DEFAULT_MAX_SOURCE_CHARS,
            maximum=MAX_SOURCE_CHARS,
            tool_name="notebook inspect",
        ),
    }


def _source_to_text(value: object) -> str:
    if isinstance(value, list):
        return _omit_data_uris(collapse_whitespace("".join(str(part) for part in value)))
    if isinstance(value, str):
        return _omit_data_uris(value)
    return ""


def _output_types(outputs: list[object]) -> list[str]:
    types: list[str] = []
    for output in outputs:
        if isinstance(output, dict):
            types.append(_output_type(output.get("output_type")))
        else:
            types.append("unknown")
    return types


def _cell_type(value: object) -> str:
    return _known_token(value, known=KNOWN_CELL_TYPES)


def _output_type(value: object) -> str:
    return _known_token(value, known=KNOWN_OUTPUT_TYPES)


def _known_token(value: object, *, known: frozenset[str]) -> str:
    if not isinstance(value, str):
        return "unknown"
    token = value.strip()
    if token in known:
        return token
    return "unknown"


def _omit_data_uris(value: str) -> str:
    return DATA_URI_RE.sub("[data URI omitted]", value)


def _source_hidden(metadata: dict[str, object]) -> bool:
    jupyter = _dict_value(metadata.get("jupyter"))
    tags = _string_list(metadata.get("tags"))
    return bool(
        metadata.get("hide_input")
        or metadata.get("source_hidden")
        or jupyter.get("source_hidden")
        or "hide-input" in tags
    )


def _outputs_hidden(metadata: dict[str, object]) -> bool:
    jupyter = _dict_value(metadata.get("jupyter"))
    tags = _string_list(metadata.get("tags"))
    return bool(
        metadata.get("hide_output")
        or metadata.get("outputs_hidden")
        or jupyter.get("outputs_hidden")
        or "hide-output" in tags
    )


def _kernel_name(metadata: dict[str, object]) -> str:
    kernelspec = _dict_value(metadata.get("kernelspec"))
    return str(kernelspec.get("name") or "")


def _language_name(metadata: dict[str, object]) -> str:
    language_info = _dict_value(metadata.get("language_info"))
    return str(language_info.get("name") or "")


def _widgets_metadata_present(metadata: dict[str, object]) -> bool:
    widgets = metadata.get("widgets")
    if widgets:
        return True
    return any(str(key).startswith("application/vnd.jupyter.widget") for key in metadata)


def _dict_value(value: object) -> dict[str, object]:
    return value if isinstance(value, dict) else {}


def _list_value(value: object) -> list[object]:
    return value if isinstance(value, list) else []


def _string_list(value: object) -> set[str]:
    if not isinstance(value, list):
        return set()
    return {str(item) for item in value}


def _int_or_none(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value
