"""Bounded, deterministic MCP advertised-tool surface summaries."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any

from sidecar.ai.tools.tool_actions import coerce_scalar_side_effecting, parse_tool_actions

MAX_TOOLS = 256
MAX_NAME_CHARS = 128
MAX_DESCRIPTION_CHARS = 512
MAX_SCHEMA_DEPTH = 12
MAX_SCHEMA_NODES = 4096
MAX_SCHEMA_ITEMS = 256
MAX_SCHEMA_KEYS = 128
MAX_SCHEMA_STRING_CHARS = 4096


def _stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _bounded_schema(value: Any, *, depth: int = 0, nodes: list[int] | None = None) -> Any:
    counter = nodes if nodes is not None else [0]
    counter[0] += 1
    if counter[0] > MAX_SCHEMA_NODES or depth > MAX_SCHEMA_DEPTH:
        raise ValueError("schema_structure_exceeded")
    if value is None or isinstance(value, bool) or isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("schema_number_invalid")
        return value
    if isinstance(value, str):
        if len(value) > MAX_SCHEMA_STRING_CHARS:
            raise ValueError("schema_string_exceeded")
        return value
    if isinstance(value, list):
        if len(value) > MAX_SCHEMA_ITEMS:
            raise ValueError("schema_array_exceeded")
        return [_bounded_schema(item, depth=depth + 1, nodes=counter) for item in value]
    if isinstance(value, dict):
        if len(value) > MAX_SCHEMA_KEYS or any(
            not isinstance(key, str) or len(key) > MAX_SCHEMA_STRING_CHARS for key in value
        ):
            raise ValueError("schema_object_exceeded")
        return {
            key: _bounded_schema(item, depth=depth + 1, nodes=counter)
            for key, item in value.items()
        }
    raise ValueError("schema_value_invalid")


def schema_digest(value: Any) -> str:
    schema = _bounded_schema(value if isinstance(value, dict) else {})
    return hashlib.sha256(_stable_json(schema).encode("utf-8")).hexdigest()


def summarize_tools(raw_tools: Any) -> tuple[list[dict[str, Any]], int]:
    if not isinstance(raw_tools, list) or len(raw_tools) > MAX_TOOLS:
        raise ValueError("tool_surface_exceeded")
    rows: list[dict[str, Any]] = []
    names: set[str] = set()
    for candidate in raw_tools:
        if not isinstance(candidate, dict):
            raise ValueError("tool_invalid")
        raw_name = candidate.get("name")
        raw_description = candidate.get("description")
        if not isinstance(raw_name, str) or (
            raw_description is not None and not isinstance(raw_description, str)
        ):
            raise ValueError("tool_invalid")
        name = raw_name.strip()
        description = (raw_description or "").strip()
        if not name or len(name) > MAX_NAME_CHARS or len(description) > MAX_DESCRIPTION_CHARS:
            raise ValueError("tool_text_exceeded")
        if name in names:
            raise ValueError("tool_name_duplicate")
        names.add(name)
        input_schema = candidate.get("inputSchema")
        if not isinstance(input_schema, dict):
            input_schema = candidate.get("input_schema")
        if input_schema is None:
            input_schema = {"type": "object", "properties": {}}
        if not isinstance(input_schema, dict):
            raise ValueError("tool_schema_invalid")
        schema = _bounded_schema(input_schema)
        actions = parse_tool_actions(_bounded_schema(candidate.get("actions")))
        rows.append({
            "name": name,
            "description": description,
            "inputSchema": schema,
            "schema_digest": hashlib.sha256(_stable_json(schema).encode("utf-8")).hexdigest(),
            "side_effecting": coerce_scalar_side_effecting(
                candidate.get("side_effecting") is not False, actions,
            ),
            "actions": {key: {"side_effecting": spec.side_effecting}
                        for key, spec in actions.items()} if actions else None,
        })
    rows.sort(key=lambda row: (row["name"], row["schema_digest"]))
    return rows, 0


def tools_digest(rows: list[dict[str, Any]]) -> str:
    surface = {"version": 2, "tools": rows}
    return hashlib.sha256(_stable_json(surface).encode("utf-8")).hexdigest()
