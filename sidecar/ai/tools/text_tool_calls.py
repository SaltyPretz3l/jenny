"""Find tool calls a model wrote as visible text, so callers can strip them.

Qwen3-Coder-style chat templates render a call as
``<tool_call><function=NAME><parameter=KEY>value</parameter></function></tool_call>``.
The server parses that back into native ``tool_calls`` only when the request
offers tools; on a tools-less leg (the turn's tool budget is spent) the markup
comes back verbatim as content (HB-031). This module only finds and strips it.
Nothing here dispatches a call: running one would bypass the per-turn tool cap.

Only names in ``known_names`` count, markdown code (fenced blocks and inline
backticks) is skipped, and an opener that never closes counts only when it is
call-shaped (inside ``<tool_call>`` or carrying a ``<parameter=``), so prose
that explains the format or mentions a tag is left untouched.
``is_tool_call_only`` backs the tool-cap ending's "markup-only reply" check.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Iterable

# Markdown code is matched first so a call shown inside it is skipped whole.
_SCAN_RE = re.compile(
    r"```.*?```|~~~.*?~~~|`[^`\n]*`"
    r"|(?:<tool_call>\s*)?<function=(?P<name>[^>\n]+)>"
    r"|<tool_call>\s*(?P<json>\{)",
    re.DOTALL,
)
_FUNCTION_CLOSE = "</function>"
_ENVELOPE_CLOSE_RE = re.compile(r"\s*</tool_call>")
# One leading and one trailing newline are the template's own framing.
_PARAMETER_RE = re.compile(r"<parameter=([A-Za-z0-9_.-]+)>\n?(.*?)\n?</parameter>", re.DOTALL)
_BLANK_RUN_RE = re.compile(r"\n[ \t]*(?:\n[ \t]*)+\n")
_LEADING_FENCE_RE = re.compile(r"^```[a-z]*\s*", re.IGNORECASE)


@dataclass(frozen=True)
class TextToolCall:
    """One tool call found in visible text; ``text[start:end]`` is its markup."""

    name: str
    arguments: dict[str, str]
    complete: bool
    start: int
    end: int
    shape: str = "qwen_xml"  # or "json_envelope"


def contract_tool_names(tool_contract: Any) -> tuple[str, ...]:
    """Every tool the turn's contract describes, available or not.

    A deferred or blocked tool can still be written as text, and its markup is
    just as unexecuted as an available tool's.
    """
    names = {
        str(getattr(getattr(entry, "descriptor", None), "name", "") or "").strip()
        for entry in getattr(tool_contract, "entries", ()) or ()
    }
    return tuple(sorted(names - {""}))


def _qwen_call(text: str, match: re.Match[str], name: str) -> TextToolCall | None:
    close = text.find(_FUNCTION_CLOSE, match.end())
    if close < 0:
        # Truncated: the opener never closed, so the call runs to the end. A bare
        # tag with no envelope and no parameter is a mention, not a call.
        body, end, complete = text[match.end() :], len(text), False
        if not match.group(0).startswith("<tool_call") and "<parameter=" not in body:
            return None
    else:
        body, end, complete = text[match.end() : close], close + len(_FUNCTION_CLOSE), True
        envelope_close = _ENVELOPE_CLOSE_RE.match(text, end)
        if envelope_close is not None:
            end = envelope_close.end()
    arguments = {key: value for key, value in _PARAMETER_RE.findall(body)}
    return TextToolCall(name, arguments, complete, match.start(), end)


def _json_call(text: str, match: re.Match[str], known: frozenset[str]) -> TextToolCall | None:
    close = _ENVELOPE_CLOSE_RE.search(text, match.start("json"))
    if close is None:
        return None
    try:
        payload = json.loads(text[match.start("json") : close.start()])
    except json.JSONDecodeError:
        return None
    name = payload.get("name") if isinstance(payload, dict) else None
    if not isinstance(name, str) or name not in known:
        return None
    raw_arguments = payload.get("arguments")
    arguments = {
        str(key): value if isinstance(value, str) else json.dumps(value)
        for key, value in (raw_arguments if isinstance(raw_arguments, dict) else {}).items()
    }
    return TextToolCall(name, arguments, True, match.start(), close.end(), "json_envelope")


def find_text_tool_calls(text: str, known_names: Iterable[str]) -> tuple[TextToolCall, ...]:
    """Return the known-tool calls written as text, in order, outside markdown code."""
    known = frozenset(known_names)
    calls: list[TextToolCall] = []
    position = 0
    while known and (match := _SCAN_RE.search(text, position)) is not None:
        position = match.end()
        name = (match.group("name") or "").strip()
        if name:
            call: TextToolCall | None = _qwen_call(text, match, name) if name in known else None
        elif match.group("json") is not None:
            call = _json_call(text, match, known)
        else:
            continue  # markdown code
        if call is not None:
            calls.append(call)
            position = call.end
    return tuple(calls)


def strip_text_tool_calls(
    text: str, known_names: Iterable[str]
) -> tuple[str, tuple[TextToolCall, ...]]:
    """Remove the calls ``find_text_tool_calls`` finds; ``text`` is unchanged when none."""
    calls = find_text_tool_calls(text, known_names)
    if not calls:
        return text, calls
    kept: list[str] = []
    position = 0
    for call in calls:
        kept.append(text[position : call.start])
        position = call.end
    kept.append(text[position:])
    return _BLANK_RUN_RE.sub("\n\n", "".join(kept)).strip(), calls


def is_tool_call_only(text: str, known_names: Iterable[str]) -> bool:
    """Return whether ``text`` is nothing but a tool-call attempt.

    Known-tool calls are stripped first. What is left counts when it starts
    with native XML (the whole reply is markup, whatever the name) or is an
    in-band JSON / ``name({...})`` shape for a known tool, optionally fenced.
    Prose that merely mentions a tag or a tool never counts.
    """
    names = tuple(known_names)
    body, calls = strip_text_tool_calls(str(text or "").strip(), names)
    if not body or body.lower().startswith(("<tool_call", "<function=")):
        return bool(body or calls)
    body = _LEADING_FENCE_RE.sub("", body).lstrip()
    json_like = body.startswith("{") and '"arguments"' in body
    return any(body.startswith(f"{name}(") or (json_like and f'"{name}"' in body) for name in names)
