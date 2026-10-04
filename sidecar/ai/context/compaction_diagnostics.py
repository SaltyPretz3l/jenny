"""Content-free shape of a rebuilt compaction window for the turn diagnostics dump (FG-008).

Each row is ``{role, kind, chars}`` plus ``tool_name`` where known; message
text never leaves this module. The preflight caller passes the compacted
messages before the runtime system rows are inserted.
"""

from __future__ import annotations

import json
from typing import Any

from sidecar.ai.context.compaction import is_compaction_summary_content
from sidecar.ai.context.compaction_window import _tool_call_name, is_mid_turn_nudge_row

WINDOW_SHAPE_MAX_ROWS = 128
_TOOL_NAME_MAX_CHARS = 128


def _text_chars(content: Any) -> int:
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        return sum(
            len(part["text"])
            for part in content
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        )
    return 0


def _argument_chars(arguments: Any) -> int:
    if arguments is None:
        return 0
    if isinstance(arguments, str):
        return len(arguments)
    return len(json.dumps(arguments, ensure_ascii=False, default=str))


def _tool_calls(row: dict[str, Any]) -> list[dict[str, Any]]:
    calls = row.get("tool_calls")
    return [call for call in calls if isinstance(call, dict)] if isinstance(calls, list) else []


def _call_id(call: dict[str, Any]) -> str:
    return str(call.get("id") or call.get("call_id") or call.get("tool_call_id") or "")


def _call_arguments(call: dict[str, Any]) -> Any:
    function = call.get("function")
    if isinstance(function, dict) and "arguments" in function:
        return function.get("arguments")
    return call.get("arguments")


def compaction_window_shape(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Describe *messages* row by row without any of their content.

    A mid-turn window is ``[summary, task pin, tail..., nudge]``, so the user
    row directly after the summary is the task pin only when the window holds
    the mid-turn nudge; a preflight window keeps its real user rows as text.
    """
    rows = [row for row in messages if isinstance(row, dict)]
    mid_turn = any(is_mid_turn_nudge_row(row) for row in rows)
    tool_names: dict[str, str] = {}
    shape: list[dict[str, Any]] = []
    previous_kind = ""
    for row in rows[:WINDOW_SHAPE_MAX_ROWS]:
        role = str(row.get("role") or "").strip().lower()
        content = row.get("content")
        chars = _text_chars(content)
        tool_name = ""
        calls = _tool_calls(row) if role == "assistant" else []
        if is_compaction_summary_content(content):
            kind = "summary"
        elif is_mid_turn_nudge_row(row):
            kind = "nudge"
        elif role == "user" and mid_turn and previous_kind == "summary":
            kind = "task_pin"
        elif calls:
            kind = "tool_use"
            names = [_tool_call_name(call) for call in calls]
            for call, name in zip(calls, names, strict=True):
                tool_names[_call_id(call)] = name
            tool_name = ",".join(names)
            chars += sum(_argument_chars(_call_arguments(call)) for call in calls)
        elif role == "tool":
            kind = "tool_result"
            row_name = row.get("name")
            tool_name = (
                row_name.strip()
                if isinstance(row_name, str) and row_name.strip()
                else tool_names.get(str(row.get("tool_call_id") or ""), "")
            )
        elif role == "system":
            kind = "system"
        else:
            kind = "text"
        entry: dict[str, Any] = {"role": role, "kind": kind, "chars": chars}
        if tool_name:
            entry["tool_name"] = tool_name[:_TOOL_NAME_MAX_CHARS]
        shape.append(entry)
        previous_kind = kind
    return shape


def compacted_event_extras(result: Any) -> dict[str, Any]:
    """Extra ``ContextCompactedEvent`` fields a preflight compaction result carries."""
    return {
        "window_shape": compaction_window_shape(result.messages),
        "summary_source_dropped_messages": max(0, int(result.summary_input_dropped_messages or 0)),
    }
