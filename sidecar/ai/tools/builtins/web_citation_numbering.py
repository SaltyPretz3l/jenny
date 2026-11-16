"""Turn-wide numbering of ``web:N`` citation markers.

Every web tool payload numbers its citations from 1 (the provider contract in
``web_search_providers``). Within one turn the tool loop shifts each later web
result by the highest number already given, so a marker the model writes points
at exactly one source. ``offset_web_citations`` is the pure rewrite (JSON text in,
JSON text out); ``number_turn_web_citations`` applies it to one tool result and
keeps the turn's highest number on the loop runtime it is given.
"""

from __future__ import annotations

import json
import re
from dataclasses import replace
from typing import Any

_CITATION_ID = re.compile(r"^web:([0-9]{1,9})$")
# A citation id inside a framed history message (untrusted wrapper or result envelope).
_FRAMED_CITATION_ID = re.compile(r'"id"\s*:\s*"web:([0-9]{1,9})"')
OFFSET_FIELD = "citation_offset"
# Calls are canonicalized before they run; the model-facing ``web:`` ids are listed for safety.
_TURN_NUMBERED_WEB_TOOLS = frozenset({"web_search", "fetch_url", "web:web_search", "web:fetch_url"})


def _web_number(entry: object) -> int | None:
    if not isinstance(entry, dict):
        return None
    cid = entry.get("id")
    match = _CITATION_ID.match(cid) if isinstance(cid, str) else None
    return int(match.group(1)) if match else None


def offset_web_citations(output_text: str, offset: int) -> tuple[str, int]:
    """Shift every ``web:N`` citation id by *offset*; return (text, highest N).

    Output that is not a JSON object, or that holds no ``web:N`` citation, comes
    back unchanged with *offset* as the highest number. With an offset of 0 the
    text is also unchanged (the first web call of a turn keeps its own numbers).
    """
    if not output_text.lstrip().startswith("{"):
        return output_text, offset
    try:
        payload = json.loads(output_text)
    except ValueError:
        return output_text, offset
    citations = payload.get("citations") if isinstance(payload, dict) else None
    if not isinstance(citations, list):
        return output_text, offset
    numbers = [(entry, number) for entry in citations if (number := _web_number(entry)) is not None]
    if not numbers:
        return output_text, offset
    highest = max(number for _entry, number in numbers) + offset
    if not offset:
        return output_text, highest
    for entry, number in numbers:
        entry["id"] = f"web:{number + offset}"
    payload[OFFSET_FIELD] = offset
    return json.dumps(payload, ensure_ascii=False), highest


def _turn_web_citation_high(messages: list[dict[str, object]]) -> int:
    # The turn's earlier tool results (back to its prompt) already carry their turn numbers. History
    # messages are framed, so read the ids out of the text; a stray match only moves numbering up.
    highest = 0
    for message in reversed(messages):
        if message.get("role") == "user":
            break
        content = message.get("content")
        if message.get("role") == "tool" and isinstance(content, str) and '"web:' in content:
            for match in _FRAMED_CITATION_ID.finditer(content):
                highest = max(highest, int(match.group(1)))
    return highest


def number_turn_web_citations(
    runtime: Any, tool_result: Any, messages: list[dict[str, object]]
) -> Any:
    """Return *tool_result* with its ``web:N`` ids continued after the turn's highest.

    *runtime* is the loop runtime (``web_citation_high``); when it holds no number
    yet (a fresh turn, or a runtime rebuilt for an approval resume) the count is
    seeded from the turn's earlier tool messages. Other tools pass through.
    """
    if str(tool_result.tool_name or "") not in _TURN_NUMBERED_WEB_TOOLS:
        return tool_result
    if not isinstance(tool_result.output, str):
        return tool_result
    offset = runtime.web_citation_high
    if offset is None:
        offset = _turn_web_citation_high(messages)
    text, runtime.web_citation_high = offset_web_citations(tool_result.output, offset)
    return tool_result if text == tool_result.output else replace(tool_result, output=text)
