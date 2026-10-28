"""Find tool calls a model wrote as visible text, so callers can strip them.

Qwen3-Coder-style chat templates render a call as
``<tool_call><function=NAME><parameter=KEY>value</parameter></function></tool_call>``.
The server parses that back into native ``tool_calls`` only when the request
offers tools; on a tools-less leg (the turn's tool budget is spent) the markup
comes back verbatim as content (HB-031), and so does a call to a tool the
request did not offer (deferred or budget-filtered). This module only finds
and strips it; nothing here dispatches a call. On a leg that still has tools,
``tool_loop_text_tool_calls.recover_text_tool_calls`` hands complete calls to the
normal dispatch path, where the per-turn cap and approvals still apply.

Only names in ``known_names`` count, markdown code (fenced blocks and inline
backticks) is skipped, and an opener that never closes counts only when it is
call-shaped (inside ``<tool_call>`` or carrying a ``<parameter=``), so prose
that explains the format or mentions a tag is left untouched.
``is_tool_call_only`` backs the tool-cap ending's "markup-only reply" check.

The ``<tool_call>{json}</tool_call>`` envelope is read by ``inband_parser``'s
dict rules (name allowlist, argument keys, string arguments), so both layers
agree on what counts as a call; only a strict JSON envelope counts here, and a
call whose arguments needed healing is reported incomplete, since a
``TextToolCall`` carries no repair tags for the dispatch policy to check.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Iterable

from .inband_parser import _build_tool_call_from_dict

# Markdown code is matched first so a call shown inside it is skipped whole.
# A tool name is short; the bound keeps a run of unclosed openers linear.
_SCAN_RE = re.compile(
    r"```.*?```|~~~.*?~~~|`[^`\n]*`"
    r"|(?:<tool_call>\s*)?<function=(?P<name>[^>\n]{1,256})>"
    r"|<tool_call>\s*(?P<json>\{)",
    re.DOTALL,
)
_FUNCTION_OPEN = "<function="
_FUNCTION_CLOSE = "</function>"
_ENVELOPE_OPEN = "<tool_call>"
_ENVELOPE_CLOSE = "</tool_call>"
_ENVELOPE_CLOSE_RE = re.compile(r"\s*</tool_call>")
_PARAMETER_OPEN_RE = re.compile(r"<parameter=([A-Za-z0-9_.-]+)>")
_PARAMETER_CLOSE = "</parameter>"
# Provenance only: a JSON-string arguments value that parsed as-is.
_PLAIN_ARGUMENT_TAGS = frozenset({"parsed_string_arguments"})
_DECODER = json.JSONDecoder()
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


def _unframe(value: str) -> str:
    # One leading and one trailing newline are the template's own framing.
    value = value[1:] if value.startswith("\n") else value
    return value[:-1] if value.endswith("\n") else value


def _parse_parameters(body: str) -> tuple[dict[str, str], bool]:
    """The body's parameters, and whether only whitespace trails the last one.

    A parameter ends at its first ``</parameter>``, except the last one, which
    ends at the body's final ``</parameter>``: a value that quotes the tag
    itself (a write_file body about the template) keeps it. Plain ``find``
    scans keep a body full of unclosed parameters linear (tool review C4 #G).
    """
    arguments: dict[str, str] = {}
    last_close = body.rfind(_PARAMETER_CLOSE)
    position = 0
    opener = _PARAMETER_OPEN_RE.search(body)
    while opener is not None and opener.end() <= last_close:
        close = body.find(_PARAMETER_CLOSE, opener.end())
        following = _PARAMETER_OPEN_RE.search(body, close + len(_PARAMETER_CLOSE))
        if following is None or following.end() > last_close:
            close, following = last_close, None
        arguments[opener.group(1)] = _unframe(body[opener.end() : close])
        position = close + len(_PARAMETER_CLOSE)
        opener = following
    return arguments, not body[position:].strip()


def _parameters_well_formed(body: str) -> bool:
    """Every character outside the parameter values is whitespace.

    Decides whether a ``<function=`` opener before the next ``</function>``
    is quoted inside a value (the body still parses as parameters alone) or
    starts the next call (it sits in a gap between parameters).
    """
    last_close = body.rfind(_PARAMETER_CLOSE)
    position = 0
    opener = _PARAMETER_OPEN_RE.search(body)
    while opener is not None and opener.end() <= last_close:
        if body[position : opener.start()].strip():
            return False
        close = body.find(_PARAMETER_CLOSE, opener.end())
        following = _PARAMETER_OPEN_RE.search(body, close + len(_PARAMETER_CLOSE))
        if following is None or following.end() > last_close:
            close, following = last_close, None
        position = close + len(_PARAMETER_CLOSE)
        opener = following
    return position > 0 and not body[position:].strip()


def _call_limit(text: str, start: int) -> int:
    """Where this call's markup must end: the next call's opener, else the end.

    A call that never closed must not absorb the next one, so its close is
    searched for only up to there; the next call's own envelope tag stays with it.
    """
    next_open = text.find(_FUNCTION_OPEN, start)
    if next_open < 0:
        return len(text)
    envelope = text.rfind(_ENVELOPE_OPEN, start, next_open)
    if envelope >= 0 and not text[envelope + len(_ENVELOPE_OPEN) : next_open].strip():
        return envelope
    return next_open


def _qwen_call(text: str, match: re.Match[str], name: str) -> TextToolCall | None:
    limit = _call_limit(text, match.end())
    close = text.find(_FUNCTION_CLOSE, match.end(), limit)
    if close < 0:
        # No close before the next opener: a value may quote ``<function=``
        # (a write_file body about the template). The later close is this
        # call's own when the body up to it is nothing but parameters.
        later = text.find(_FUNCTION_CLOSE, match.end())
        if later >= 0 and _parameters_well_formed(text[match.end() : later]):
            close = later
    if close < 0:
        # Truncated: the opener never closed, so the call runs to the next call
        # or the end. A bare tag with no envelope and no parameter is a mention.
        body, end, complete = text[match.end() : limit], limit, False
        if not match.group(0).startswith("<tool_call") and "<parameter=" not in body:
            return None
    else:
        body, end, complete = text[match.end() : close], close + len(_FUNCTION_CLOSE), True
        envelope_close = _ENVELOPE_CLOSE_RE.match(text, end)
        if envelope_close is not None:
            end = envelope_close.end()
    arguments, clean = _parse_parameters(body)
    return TextToolCall(name, arguments, complete and clean, match.start(), end)


def _json_call(
    text: str, match: re.Match[str], known: frozenset[str], close: int
) -> TextToolCall | None:
    """The envelope from ``match`` to ``close`` (the next ``</tool_call>``).

    An envelope opened again before ``close`` never closed: that close is the
    later envelope's, and decoding up to it per opener would be quadratic.
    """
    if text.find(_ENVELOPE_OPEN, match.start("json"), close) >= 0:
        return None
    try:
        payload, payload_end = _DECODER.raw_decode(text, match.start("json"))
    except ValueError:
        return None
    if payload_end > close or text[payload_end:close].strip():
        return None
    name = payload.get("name") if isinstance(payload, dict) else None
    if not isinstance(name, str) or name not in known:
        return None
    call = _build_tool_call_from_dict(payload, known)
    # Unusable or healed arguments: still markup to strip, never a call to run.
    complete = call is not None and _PLAIN_ARGUMENT_TAGS.issuperset(call.argument_repairs)
    arguments = {
        str(key): value if isinstance(value, str) else json.dumps(value)
        for key, value in (call.arguments if call is not None and complete else {}).items()
    }
    end = close + len(_ENVELOPE_CLOSE)
    return TextToolCall(name, arguments, complete, match.start(), end, "json_envelope")


def find_text_tool_calls(text: str, known_names: Iterable[str]) -> tuple[TextToolCall, ...]:
    """Return the known-tool calls written as text, in order, outside markdown code."""
    known = frozenset(known_names)
    calls: list[TextToolCall] = []
    position = 0
    # The next "</tool_call>" from the last search (-1: none left), reused while
    # it still lies ahead so a run of unclosed envelopes stays linear.
    envelope_close: int | None = None
    while known and (match := _SCAN_RE.search(text, position)) is not None:
        position = match.end()
        name = (match.group("name") or "").strip()
        if name:
            call: TextToolCall | None = _qwen_call(text, match, name) if name in known else None
        elif match.group("json") is not None:
            if envelope_close is None or 0 <= envelope_close < match.start("json"):
                envelope_close = text.find(_ENVELOPE_CLOSE, match.start("json"))
            call = _json_call(text, match, known, envelope_close) if envelope_close >= 0 else None
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
