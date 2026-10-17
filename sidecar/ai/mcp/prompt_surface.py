"""Bounded, deterministic MCP prompt summaries and text rendering."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from sidecar.ai.mcp.tool_surface import MAX_DESCRIPTION_CHARS, ToolSurfaceError

MAX_PROMPTS = 32
MAX_PROMPT_ARGUMENTS = 16
MAX_PROMPT_TEXT_CHARS = 16_000
MAX_PROMPT_ARGUMENT_VALUE_CHARS = 4_096
PROMPT_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")


def _description(value: Any) -> str:
    return value[:MAX_DESCRIPTION_CHARS] if isinstance(value, str) else ""


def _prompt_row(candidate: Any) -> dict[str, Any] | None:
    if not isinstance(candidate, dict):
        return None
    name = candidate.get("name")
    arguments = candidate.get("arguments", [])
    if (not isinstance(name, str) or PROMPT_NAME_RE.fullmatch(name) is None
            or not isinstance(arguments, list) or len(arguments) > MAX_PROMPT_ARGUMENTS):
        return None
    rows = []
    seen: set[str] = set()
    for argument in arguments:
        if not isinstance(argument, dict):
            return None
        argument_name = argument.get("name")
        if (not isinstance(argument_name, str) or PROMPT_NAME_RE.fullmatch(argument_name) is None
                or argument_name in seen):
            return None
        seen.add(argument_name)
        rows.append({"name": argument_name,
                     "description": _description(argument.get("description")),
                     "required": argument.get("required") is True})
    return {"name": name, "description": _description(candidate.get("description")),
            "arguments": rows}


def summarize_prompts(raw: Any) -> tuple[list[dict[str, Any]], int]:
    if not isinstance(raw, list):
        raise ToolSurfaceError("prompt_surface_invalid")
    if len(raw) > MAX_PROMPTS:
        raise ToolSurfaceError("too_many_prompts", bound="prompt_count",
                               limit=MAX_PROMPTS, observed=len(raw))
    rows: dict[str, dict[str, Any]] = {}
    malformed = 0
    for candidate in raw:
        row = _prompt_row(candidate)
        if row is None:
            malformed += 1
        else:
            rows.setdefault(row["name"], row)
    return [rows[name] for name in sorted(rows)], malformed


def prompts_digest(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return ""
    stable = json.dumps(rows, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(stable.encode("utf-8")).hexdigest()


def prompt_text_from_messages(result: Any) -> str:
    messages = result.get("messages") if isinstance(result, dict) else None
    if not isinstance(messages, list):
        raise ToolSurfaceError("prompt_result_invalid")
    text = ""
    for index, message in enumerate(messages):
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, dict):
            raise ToolSurfaceError("prompt_result_invalid")
        if content.get("type") != "text":
            raise ToolSurfaceError("prompt_content_unsupported")
        part = content.get("text")
        if not isinstance(part, str):
            raise ToolSurfaceError("prompt_result_invalid")
        separator = "\n\n" if index else ""
        remaining = MAX_PROMPT_TEXT_CHARS - len(text)
        text += (separator + part[:remaining])[:remaining]
    if not text.strip():
        raise ToolSurfaceError("prompt_result_invalid")
    return text
