"""Payload normalization helpers for MCP resources."""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from typing import Any

from sidecar.ai.mcp.models import MCPResourceDescriptor, MCPResourceTemplate
from sidecar.ai.mcp.tool_namespace import namespace_mcp_resource_id
from sidecar.ai.tools.sanitization import sanitize_tool_output

MCP_RESOURCE_TOOL_LIST_RESOURCES = "list_resources"
MCP_RESOURCE_TOOL_READ_RESOURCE = "read_resource"
MCP_RESOURCE_TOOL_LIST_TEMPLATES = "list_resource_templates"
MCP_RESOURCE_PAGE_LIMIT = 4
MCP_RESOURCE_ITEM_LIMIT = 100
MCP_RESOURCE_TEXT_EXCERPT_MAX_CHARS = 20_000
MCP_RESOURCE_STRING_MAX_CHARS = 1_000
MCP_RESOURCE_URI_MAX_CHARS = 4_096


def sanitize_resource_string(
    value: Any,
    *,
    max_chars: int = MCP_RESOURCE_STRING_MAX_CHARS,
) -> str:
    if not isinstance(value, str):
        return ""
    return sanitize_tool_output(value.strip(), max_chars=max_chars, tool_name="mcp_resource")


def resource_uri_from_payload(payload: dict[str, Any]) -> str:
    uri = payload.get("uri")
    if isinstance(uri, str) and uri.strip():
        normalized = uri.strip()
        return normalized if len(normalized) <= MCP_RESOURCE_URI_MAX_CHARS else ""
    return ""


def resource_mime_from_payload(payload: dict[str, Any]) -> str:
    raw_mime = payload.get("mimeType")
    if not isinstance(raw_mime, str):
        raw_mime = payload.get("mime_type")
    return sanitize_resource_string(raw_mime, max_chars=128)


def resource_size_from_payload(payload: dict[str, Any]) -> int | None:
    raw_size = payload.get("size")
    if raw_size is None:
        raw_size = payload.get("sizeBytes")
    if raw_size is None:
        raw_size = payload.get("size_bytes")
    if isinstance(raw_size, bool) or not isinstance(raw_size, (int, float)):
        return None
    if isinstance(raw_size, float) and not math.isfinite(raw_size):
        return None
    size = int(raw_size)
    return size if size >= 0 else None


def normalize_resource_annotations(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, Any] = {}
    for raw_key, raw_value in list(value.items())[:20]:
        key = sanitize_resource_string(raw_key, max_chars=128)
        if not key:
            continue
        if isinstance(raw_value, str):
            result[key] = sanitize_resource_string(raw_value)
        elif isinstance(raw_value, (bool, int, float)) and not isinstance(raw_value, bool):
            if isinstance(raw_value, float) and not math.isfinite(raw_value):
                continue
            result[key] = raw_value
        elif isinstance(raw_value, bool):
            result[key] = raw_value
        elif raw_value is None:
            result[key] = None
        else:
            result[key] = sanitize_resource_string(raw_value)
    return result


def resource_descriptor_from_payload(
    server_name: str,
    payload: Any,
) -> MCPResourceDescriptor | None:
    if not isinstance(payload, dict):
        return None
    uri = resource_uri_from_payload(payload)
    if not uri:
        return None
    name = sanitize_resource_string(payload.get("name")) or sanitize_resource_string(uri)
    return MCPResourceDescriptor(
        server_name=server_name,
        resource_id=namespace_mcp_resource_id(server_name, uri),
        uri=uri,
        name=name,
        description=sanitize_resource_string(payload.get("description")),
        mime_type=resource_mime_from_payload(payload),
        size_bytes=resource_size_from_payload(payload),
        annotations=normalize_resource_annotations(payload.get("annotations")),
    )


def resource_template_from_payload(
    server_name: str,
    payload: Any,
) -> MCPResourceTemplate | None:
    if not isinstance(payload, dict):
        return None
    raw_template = payload.get("uriTemplate")
    if not isinstance(raw_template, str):
        raw_template = payload.get("uri_template")
    uri_template = raw_template.strip() if isinstance(raw_template, str) else ""
    if not uri_template or len(uri_template) > MCP_RESOURCE_URI_MAX_CHARS:
        return None
    return MCPResourceTemplate(
        server_name=server_name,
        name=sanitize_resource_string(payload.get("name"))
        or sanitize_resource_string(uri_template),
        uri_template=uri_template,
        description=sanitize_resource_string(payload.get("description")),
        mime_type=resource_mime_from_payload(payload),
        annotations=normalize_resource_annotations(payload.get("annotations")),
    )


def next_cursor_from_payload(payload: dict[str, Any]) -> str | None:
    raw_cursor = payload.get("nextCursor")
    if not isinstance(raw_cursor, str):
        raw_cursor = payload.get("next_cursor")
    normalized = raw_cursor.strip() if isinstance(raw_cursor, str) else ""
    return normalized or None


def collect_paginated_resource_items(  # noqa: PLR0913 - pagination knobs are per-tool.
    arguments: dict[str, Any],
    *,
    load_page: Callable[[str | None], dict[str, Any]],
    page_item_keys: tuple[str, ...],
    normalize_item: Callable[[Any], Any | None],
    on_item: Callable[[Any], None] | None = None,
) -> tuple[list[Any], str | None, bool, int, int]:
    cursor = arguments.get("cursor")
    next_cursor = cursor.strip() if isinstance(cursor, str) and cursor.strip() else None
    items: list[Any] = []
    malformed_count = 0
    page_count = 0
    truncated = False
    while page_count < MCP_RESOURCE_PAGE_LIMIT and len(items) < MCP_RESOURCE_ITEM_LIMIT:
        page = load_page(next_cursor)
        page_items: list[Any] = []
        for key in page_item_keys:
            candidate_items = page.get(key)
            if isinstance(candidate_items, list):
                page_items = candidate_items
                break
        for item in page_items:
            normalized_item = normalize_item(item)
            if normalized_item is None:
                malformed_count += 1
                continue
            if on_item is not None:
                on_item(normalized_item)
            items.append(normalized_item)
            if len(items) >= MCP_RESOURCE_ITEM_LIMIT:
                truncated = True
                break
        page_count += 1
        next_cursor = next_cursor_from_payload(page)
        if next_cursor is None:
            break
    if next_cursor is not None:
        truncated = True
    return items, next_cursor, truncated, page_count, malformed_count


def resource_result_payload(
    payload: dict[str, Any],
    *,
    success: bool = True,
    error_code: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "content": [
            {
                "type": "text",
                "text": json.dumps(payload, ensure_ascii=False, sort_keys=True, allow_nan=False),
            }
        ],
        "success": success,
        "error_code": error_code,
        "metadata": metadata or {},
    }
