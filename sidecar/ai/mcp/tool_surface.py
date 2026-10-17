"""Bounded, deterministic MCP advertised-tool surface summaries."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any

from sidecar.ai.mcp.client_support import claims_read_only
from sidecar.ai.tools.tool_actions import coerce_scalar_side_effecting, parse_tool_actions

MAX_TOOLS = 256
MAX_NAME_CHARS = 128
MAX_DESCRIPTION_CHARS = 2048
MAX_SCHEMA_DEPTH = 32
MAX_SCHEMA_NODES = 4096
MAX_SCHEMA_ITEMS = 256
MAX_SCHEMA_KEYS = 128
MAX_SCHEMA_STRING_CHARS = 4096


class ToolSurfaceError(ValueError):
    """A bounded admission refusal; ``str(error)`` stays the reason string callers compare on."""

    def __init__(
        self,
        reason: str,
        *,
        tool: str | None = None,
        bound: str | None = None,
        limit: int | None = None,
        observed: int | None = None,
    ) -> None:
        super().__init__(reason)
        self.reason = reason
        self.tool = tool[:MAX_NAME_CHARS] if tool is not None else None
        self.bound = bound
        self.limit = limit
        self.observed = observed

    def log_data(self) -> dict[str, object]:
        data: dict[str, object | None] = {
            "reason": self.reason,
            "tool": self.tool,
            "bound": self.bound,
            "limit": self.limit,
            "observed": self.observed,
        }
        return {key: value for key, value in data.items() if value is not None}


def as_log_data(error: BaseException) -> dict[str, object]:
    """Warning-log fields for a failed tool listing, with the bounded surface detail when known."""
    detail = error.log_data() if isinstance(error, ToolSurfaceError) else {}
    return {"error_type": type(error).__name__, **detail}


def _stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _bounded_schema(value: Any, *, depth: int = 0, nodes: list[int] | None = None) -> Any:
    counter = nodes if nodes is not None else [0]
    counter[0] += 1
    if counter[0] > MAX_SCHEMA_NODES:
        raise ToolSurfaceError("schema_structure_exceeded", bound="schema_nodes",
                               limit=MAX_SCHEMA_NODES, observed=counter[0])
    if depth > MAX_SCHEMA_DEPTH:
        raise ToolSurfaceError("schema_structure_exceeded", bound="schema_depth",
                               limit=MAX_SCHEMA_DEPTH, observed=depth)
    if value is None or isinstance(value, bool) or isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ToolSurfaceError("schema_number_invalid")
        return value
    if isinstance(value, str):
        if len(value) > MAX_SCHEMA_STRING_CHARS:
            raise ToolSurfaceError("schema_string_exceeded", bound="schema_string_chars",
                                   limit=MAX_SCHEMA_STRING_CHARS, observed=len(value))
        return value
    if isinstance(value, list):
        if len(value) > MAX_SCHEMA_ITEMS:
            raise ToolSurfaceError("schema_array_exceeded", bound="schema_items",
                                   limit=MAX_SCHEMA_ITEMS, observed=len(value))
        return [_bounded_schema(item, depth=depth + 1, nodes=counter) for item in value]
    if isinstance(value, dict):
        _check_object_keys(value)
        return {
            key: _bounded_schema(item, depth=depth + 1, nodes=counter)
            for key, item in value.items()
        }
    raise ToolSurfaceError("schema_value_invalid")


def _check_object_keys(value: dict[Any, Any]) -> None:
    if len(value) > MAX_SCHEMA_KEYS:
        raise ToolSurfaceError("schema_object_exceeded", bound="schema_keys",
                               limit=MAX_SCHEMA_KEYS, observed=len(value))
    for key in value:
        if not isinstance(key, str):
            raise ToolSurfaceError("schema_object_exceeded")
        if len(key) > MAX_SCHEMA_STRING_CHARS:
            raise ToolSurfaceError("schema_object_exceeded", bound="schema_string_chars",
                                   limit=MAX_SCHEMA_STRING_CHARS, observed=len(key))


def schema_digest(value: Any) -> str:
    schema = _bounded_schema(value if isinstance(value, dict) else {})
    return hashlib.sha256(_stable_json(schema).encode("utf-8")).hexdigest()


def _tool_text(candidate: Any) -> tuple[str, str]:
    if not isinstance(candidate, dict) or not isinstance(candidate.get("name"), str):
        raise ToolSurfaceError("tool_invalid")
    name = candidate["name"].strip()
    raw_description = candidate.get("description")
    if raw_description is not None and not isinstance(raw_description, str):
        raise ToolSurfaceError("tool_invalid", tool=name or None)
    description = (raw_description or "").strip()
    if not name or len(name) > MAX_NAME_CHARS:
        raise ToolSurfaceError("tool_text_exceeded", tool=name or None, bound="name_chars",
                               limit=MAX_NAME_CHARS, observed=len(name))
    if len(description) > MAX_DESCRIPTION_CHARS:
        raise ToolSurfaceError("tool_text_exceeded", tool=name, bound="description_chars",
                               limit=MAX_DESCRIPTION_CHARS, observed=len(description))
    return name, description


def summarize_tools(raw_tools: Any) -> tuple[list[dict[str, Any]], int]:
    if not isinstance(raw_tools, list):
        raise ToolSurfaceError("tool_surface_exceeded")
    if len(raw_tools) > MAX_TOOLS:
        raise ToolSurfaceError("tool_surface_exceeded", bound="tool_count",
                               limit=MAX_TOOLS, observed=len(raw_tools))
    rows: list[dict[str, Any]] = []
    names: set[str] = set()
    for candidate in raw_tools:
        name, description = _tool_text(candidate)
        if name in names:
            raise ToolSurfaceError("tool_name_duplicate", tool=name)
        names.add(name)
        input_schema = candidate.get("inputSchema")
        if not isinstance(input_schema, dict):
            input_schema = candidate.get("input_schema")
        if input_schema is None:
            input_schema = {"type": "object", "properties": {}}
        if not isinstance(input_schema, dict):
            raise ToolSurfaceError("tool_schema_invalid", tool=name)
        try:
            schema = _bounded_schema(input_schema)
            actions = parse_tool_actions(_bounded_schema(candidate.get("actions")))
            annotations = _bounded_schema(candidate.get("annotations"))
        except ToolSurfaceError as error:
            error.tool = name
            raise
        row: dict[str, Any] = {
            "name": name,
            "description": description,
            "inputSchema": schema,
            "schema_digest": hashlib.sha256(_stable_json(schema).encode("utf-8")).hexdigest(),
            "side_effecting": coerce_scalar_side_effecting(
                candidate.get("side_effecting") is not False, actions,
            ),
            "actions": {key: {"side_effecting": spec.side_effecting}
                        for key, spec in actions.items()} if actions else None,
        }
        # Only a qualifying claim adds a key, so a surface without one keeps its digest.
        if claims_read_only(annotations):
            row["read_only_claim"] = True
        rows.append(row)
    rows.sort(key=lambda row: (row["name"], row["schema_digest"]))
    return rows, 0


def tools_digest(rows: list[dict[str, Any]], *, read_only_claims: bool = False) -> str:
    """Digest of the normalized surface.

    A row's ``read_only_claim`` is hashed only when the server's row opted into
    ``read_only_auto_allow`` (owner decision D5): with the switch off the claim is
    display-only, so a surface approved before claims were recorded keeps its
    digest. Flipping the switch changes the row's configuration digest, which
    already sends the server back to review.
    """
    hashed = rows if read_only_claims else [
        {key: value for key, value in row.items() if key != "read_only_claim"} for row in rows
    ]
    surface = {"version": 2, "tools": hashed}
    return hashlib.sha256(_stable_json(surface).encode("utf-8")).hexdigest()
