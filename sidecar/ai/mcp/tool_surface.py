"""Bounded, deterministic MCP advertised-tool surface summaries."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any

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


def summarize_tools(raw_tools: Any) -> tuple[list[dict[str, str]], int]:
    rows: list[dict[str, str]] = []
    malformed = 0
    candidates = raw_tools if isinstance(raw_tools, list) else []
    if not isinstance(raw_tools, list):
        malformed += 1
    for candidate in candidates[:MAX_TOOLS]:
        if not isinstance(candidate, dict):
            malformed += 1
            continue
        raw_name = candidate.get("name")
        raw_description = candidate.get("description")
        if not isinstance(raw_name, str) or (
            raw_description is not None and not isinstance(raw_description, str)
        ):
            malformed += 1
            continue
        name = raw_name.strip()[:MAX_NAME_CHARS]
        if not name:
            malformed += 1
            continue
        description = (raw_description or "").strip()[:MAX_DESCRIPTION_CHARS]
        input_schema = candidate.get("inputSchema")
        if not isinstance(input_schema, dict):
            input_schema = candidate.get("input_schema")
        try:
            digest = schema_digest(input_schema)
        except ValueError:
            malformed += 1
            continue
        rows.append(
            {
                "name": name,
                "description": description,
                "schema_digest": digest,
            }
        )
    if len(candidates) > MAX_TOOLS:
        malformed += len(candidates) - MAX_TOOLS
    rows.sort(key=lambda row: (row["name"], row["schema_digest"]))
    return rows, malformed


def tools_digest(rows: list[dict[str, str]]) -> str:
    return hashlib.sha256(_stable_json(rows).encode("utf-8")).hexdigest()
