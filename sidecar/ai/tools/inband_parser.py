"""Parse tool calls from model text output when native tool calling fails.

Local LLMs may describe tool usage in prose or semi-structured text instead
of producing structured ``tool_calls`` in the API response.  This module
extracts those in-band tool call attempts so the agent loop can execute them.
A fenced or bare call that the model follows with a made-up result object is
shown, not issued (gate F26, 2026-10-14: "write the call out, do not call it");
the parser sees only the reply, never the user's instruction, so that is the
whole of the user-intent coverage here.
"""

from __future__ import annotations

import json
import logging
import re
import sys
from bisect import bisect_right
from dataclasses import dataclass, replace
from typing import Iterator, List, Tuple
from uuid import uuid4

from .models import ToolCallRequest
from .tool_call_healing import (
    coerce_arguments,
    extract_balanced_json_objects,
    is_healing_enabled,
    record_repair,
    repair_json_payload,
)

logger = logging.getLogger(__name__)


def _gen_inband_call_id(tool_name: str) -> str:
    return f"inband_{tool_name}_{uuid4().hex[:10]}"


@dataclass(frozen=True)
class _WrappedFormat:
    """An opener ending just before the payload ``{`` and a closer from its ``}``.

    The payload runs from the opener to the first ``}`` the closer follows, the
    lazy ``{.*?}`` rule the old regexes used, found by one forward scan
    instead of retrying the rest of the text from every unclosed opener (tool
    review C4 #G: thousands of unclosed openers took seconds).
    """

    opener: "re.Pattern[str]"
    closer: "re.Pattern[str]"


# Format 1: XML-style <tool_call>{...}</tool_call>
_XML_FORMAT = _WrappedFormat(
    re.compile(r"<tool_call>\s*(?=\{)"), re.compile(r"\}\s*</tool_call>")
)
# Format 2: Markdown code block ```tool_call ... ``` or ```json ... ```
_MD_FORMAT = _WrappedFormat(
    re.compile(r"```(?:tool_call|json)\s*\n(?=\{)"), re.compile(r"\}\s*\n```")
)
# Format 3: tool_name({"param": "value"}); group 1 is the name.
_FUNC_FORMAT = _WrappedFormat(
    re.compile(r"\b([a-z][a-z0-9_]*)\s*\(\s*(?=\{)"), re.compile(r"\}\s*\)")
)
_XML_OPEN = "<tool_call>"
_XML_CLOSE = "</tool_call>"


@dataclass(frozen=True)
class _Wrapped:
    """One wrapped candidate: ``text[start:end]`` is the markup."""

    start: int
    end: int
    payload: str
    name: str = ""


def _wrapped_candidates(text: str, fmt: _WrappedFormat) -> Iterator[_Wrapped]:
    """Non-overlapping candidates in order; stops once no closer is left."""
    position = 0
    close: "re.Match[str] | None" = None
    for opener in fmt.opener.finditer(text):
        if opener.start() < position:
            continue
        if close is None or close.start() < opener.end():
            close = fmt.closer.search(text, opener.end())
            if close is None:
                return  # no closer after here, so none after any later opener
        name = opener.group(1) if fmt.opener.groups else ""
        yield _Wrapped(opener.start(), close.end(), text[opener.end() : close.start() + 1], name)
        position = close.end()


def _xml_candidate_payloads(text: str) -> Iterator[str]:
    """Each ``<tool_call>...</tool_call>`` body, stripped, by plain ``find`` scans."""
    position = 0
    while (start := text.find(_XML_OPEN, position)) >= 0:
        close = text.find(_XML_CLOSE, start + len(_XML_OPEN))
        if close < 0:
            return
        yield text[start + len(_XML_OPEN) : close].strip()
        position = close + len(_XML_CLOSE)


_MARKDOWN_CODE_RE = re.compile(r"```.*?```|`[^`\n]*`", re.DOTALL)
_EXAMPLE_MARKER_RE = re.compile(r"\b(?:example|e\.g\.)", re.IGNORECASE)


def _shown_not_issued(text: str, start: int, *, fenced: bool = False) -> bool:
    """Whether the call at ``start`` is shown as an example rather than issued (BLT-02).

    Line-local on purpose: prose before a call on its own line ("I'll check the
    README first.") never vetoes it. A fence is judged by the line before it.
    """
    line_start = text.rfind("\n", 0, start) + 1
    line = text[line_start:start]
    if fenced and not line.strip():
        previous = text[:line_start].rstrip().rsplit("\n", 1)[-1]
        return previous.rstrip().endswith(":") and _EXAMPLE_MARKER_RE.search(previous) is not None
    stripped = line.strip()
    return (stripped.startswith(">") or stripped[-1:] in {"'", '"'}
            or _EXAMPLE_MARKER_RE.search(line) is not None)



def _result_lead_end(text: str, end: int) -> int | None:
    """Index of the ``{`` reached from ``end`` across whitespace and fence lines.

    A hand-rolled scan: the regex it replaces (``(?:\\s*(?:```|~~~)[^\\n]*)*``
    before the brace) backtracked exponentially on a run of fence markers, so
    a degenerate model loop emitting a run of backtick fences after a call
    blocked the sidecar thread for tens of seconds (tool review C4 #1).
    """
    position = end
    length = len(text)
    while True:
        while position < length and text[position].isspace():
            position += 1
        if position < length and text[position] == "{":
            return position
        if not text.startswith(("```", "~~~"), position):
            return None
        newline = text.find("\n", position)
        line_end = newline if newline >= 0 else length
        brace = text.find("{", position + 3, line_end)
        if brace >= 0:
            return brace
        if newline < 0:
            return None
        position = newline


_CALL_NAME_KEYS = ("name", "tool", "function")
_CALL_ARGS_KEYS = ("arguments", "parameters", "args", "input")


def _result_follows(text: str, end: int, known_tool_names: frozenset[str]) -> bool:
    """Whether a JSON object that is not a call follows the call ending at ``end``.

    An issued call waits for the real result; a reply that goes on to write
    one (``{"output": ...}``) is showing the call (F26). Fences and blank lines
    in between do not count. Only an object that parses counts (a truncated or
    prose-like brace is not a result), and one shaped like a call, in any
    dialect, known tool or not, or an argument-free call to a known tool,
    keeps a multi-call reply issued.
    """
    lead_end = _result_lead_end(text, end)
    if lead_end is None:
        return False
    try:
        value, _end = json.JSONDecoder().raw_decode(text, lead_end)
    except ValueError:
        return False
    if not isinstance(value, dict):
        return False
    named = any(key in value for key in _CALL_NAME_KEYS)
    return not named or not (
        any(key in value for key in _CALL_ARGS_KEYS)
        or str(value.get("name") or "").strip() in known_tool_names
    )


def _is_call(raw_json: str, known_tool_names: frozenset[str]) -> bool:
    obj, _tags = _parse_dict_with_tags(raw_json)
    return _build_tool_call_from_dict(obj, known_tool_names) is not None


def _fenced_calls_shown(text: str, known_tool_names: frozenset[str]) -> int:
    """How many Format 2 candidates the reply shows next to a made-up result (0: issued)."""
    matches = list(_wrapped_candidates(text, _MD_FORMAT))
    for match in matches:
        # A fence labelled as an example is never issued, so its result is no veto.
        if _shown_not_issued(text, match.start, fenced=True):
            continue
        payload = match.payload
        inner = extract_balanced_json_objects(payload)
        if not inner or not _is_call(inner[0], known_tool_names):
            continue
        after_call = payload.find(inner[0]) + len(inner[0])
        if (len(inner) > 1 and _result_follows(payload, after_call, known_tool_names)) \
                or _result_follows(text, match.end, known_tool_names):
            return len(matches)
    return 0


def _code_spans(text: str) -> List[Tuple[int, int]]:
    """Inline code and fenced block spans; a call starting inside one is an example."""
    return [span.span() for span in _MARKDOWN_CODE_RE.finditer(text)]


def _starts_in_code(spans: List[Tuple[int, int]], position: int) -> bool:
    # Only the call's start is judged: backticks inside its JSON arguments
    # (code, Markdown) are file content and are parsed from the original text.
    # The spans come from one finditer, so they are sorted and disjoint.
    index = bisect_right(spans, (position, sys.maxsize)) - 1
    return index >= 0 and spans[index][0] <= position < spans[index][1]


@dataclass(frozen=True)
class InbandExtractionResult:
    """Detailed result from one in-band tool-call parsing attempt.

    ``failed_attempt`` is intentionally narrower than "text looked tool-like":
    it records only a parser-selected, explicit candidate that failed to parse.
    The tool loop uses this boolean instead of rescanning the final answer.
    """

    calls: tuple[ToolCallRequest, ...]
    remaining_text: str
    failed_attempt: bool = False


def _call_arguments(obj: dict) -> tuple[dict, tuple[str, ...]] | None:
    """The call's arguments under the first declared key, with any repair tags.

    A JSON-string value is parsed (tagged ``parsed_string_arguments``, plus the
    heal tags when the net had to repair it); a missing, null or blank value is
    no arguments. Anything else is not a call: ``None``, never a silent ``{}``.
    """
    # The first declared key with a value: ``"arguments": null`` beside a
    # populated ``parameters`` must not hide the real arguments.
    key = next((candidate for candidate in _CALL_ARGS_KEYS if obj.get(candidate) is not None), None)
    value = obj[key] if key is not None else None
    if isinstance(value, dict):
        return value, ()
    if value is None or (isinstance(value, str) and not value.strip()):
        return {}, ()
    if not isinstance(value, str):
        return None
    if is_healing_enabled():
        return coerce_arguments(value)
    try:
        parsed = json.loads(value)
    except ValueError:
        return None
    return (parsed, ("parsed_string_arguments",)) if isinstance(parsed, dict) else None


def _build_tool_call_from_dict(
    obj: object,
    known_tool_names: frozenset[str],
) -> ToolCallRequest | None:
    """Same dict-shape/name-allowlist/arguments checks for any candidate dict.

    ``argument_repairs`` carries the tags from reading the arguments value;
    callers prepend the tags from healing the envelope itself.
    """
    if not isinstance(obj, dict):
        return None
    name = str(obj.get("name") or "").strip()
    if name not in known_tool_names:
        return None
    resolved = _call_arguments(obj)
    if resolved is None:
        return None
    arguments, argument_tags = resolved
    return ToolCallRequest(
        tool_id=name,
        arguments=arguments,
        call_id=_gen_inband_call_id(name),
        argument_repairs=argument_tags,
    )


def _parse_dict_with_tags(raw_json: str) -> tuple[dict | None, tuple[str, ...]]:
    """Parse ``raw_json`` to a dict, reporting any heal tags applied.

    On a clean parse failure, and only when the healing net is enabled, a
    second-chance repair pass runs on the raw text. The returned tags are
    non-empty only when a repair pass actually changed the payload.
    """
    try:
        obj = json.loads(raw_json)
    except json.JSONDecodeError:
        if not is_healing_enabled():
            return None, ()
        healed = repair_json_payload(raw_json)
        if healed.value is None:
            return None, ()
        return healed.value, (healed.repairs or ("healed",))
    return (obj, ()) if isinstance(obj, dict) else (None, ())


def _parse_tool_json_with_tags(
    raw_json: str,
    known_tool_names: frozenset[str],
) -> tuple[ToolCallRequest | None, tuple[str, ...]]:
    """Parse a JSON object as a tool call, reporting any heal tags applied.

    A healed dict goes through the exact same dict-shape/allowlist/arguments
    checks as a clean parse — healing never bypasses the tool-name allowlist.
    """
    obj, tags = _parse_dict_with_tags(raw_json)
    if obj is None:
        return None, ()
    call = _build_tool_call_from_dict(obj, known_tool_names)
    if call is None:
        return None, tags
    tags += call.argument_repairs
    return replace(call, argument_repairs=tags), tags


def _extract_wrapped_calls(
    text: str,
    remaining: str,
    known_tool_names: frozenset[str],
    fmt: _WrappedFormat,
) -> Tuple[List[ToolCallRequest], str]:
    """Shared pass for the XML/fence wrapper formats."""
    calls: List[ToolCallRequest] = []
    code_spans = _code_spans(text)
    for match in _wrapped_candidates(text, fmt):
        if fmt is _XML_FORMAT:
            # The instructed envelope always runs, unless it sits inside code.
            if _starts_in_code(code_spans, match.start):
                continue
        elif _shown_not_issued(text, match.start, fenced=True):
            continue
        call, heal_tags = _parse_tool_json_with_tags(match.payload, known_tool_names)
        if call is not None:
            record_repair(heal_tags)
            calls.append(call)
            remaining = remaining.replace(text[match.start : match.end], "", 1)
    return calls, remaining


def _extract_func_calls(
    text: str,
    remaining: str,
    known_tool_names: frozenset[str],
) -> Tuple[List[ToolCallRequest], str]:
    """Format 3: function-call syntax ``tool_name({...})``."""
    calls: List[ToolCallRequest] = []
    code_spans = _code_spans(text)
    for match in _wrapped_candidates(text, _FUNC_FORMAT):
        func_name = match.name
        if (func_name not in known_tool_names or _starts_in_code(code_spans, match.start)
                or _shown_not_issued(text, match.start)):
            continue
        arguments, heal_tags = _parse_dict_with_tags(match.payload)
        if arguments is None:
            continue
        record_repair(heal_tags)
        calls.append(
            ToolCallRequest(
                tool_id=func_name,
                arguments=arguments,
                call_id=_gen_inband_call_id(func_name),
                argument_repairs=heal_tags,
            )
        )
        remaining = remaining.replace(text[match.start : match.end], "", 1)
    return calls, remaining


def _extract_balanced_calls(
    text: str,
    remaining: str,
    known_tool_names: frozenset[str],
) -> Tuple[List[ToolCallRequest], str]:
    """Format 4 (healing-only): bare balanced JSON objects in prose.

    Extraction itself is the repair (the strict formats missed the payload),
    so a clean inner parse still records ``balanced_extraction``. Unlike the
    anchored formats, a bare object has NO envelope/fence/call-syntax signal,
    so it must additionally carry an explicit ``arguments`` dict to count as a
    call — otherwise prose JSON that merely has a known tool as its ``name``
    value (a config blob, documentation example, …) would phantom-dispatch
    with empty arguments.
    """
    calls: List[ToolCallRequest] = []
    remaining_before = remaining
    code_spans = _code_spans(text)
    for candidate in extract_balanced_json_objects(text):
        position = text.find(candidate)
        if _starts_in_code(code_spans, position) or _shown_not_issued(text, position):
            continue
        obj, heal_tags = _parse_dict_with_tags(candidate)
        if obj is None or not isinstance(obj.get("arguments"), dict):
            continue
        call = _build_tool_call_from_dict(obj, known_tool_names)
        if call is None:
            continue
        if _result_follows(text, position + len(candidate), known_tool_names):
            logger.info("Skipped %d bare tool call(s): a result follows the call", len(calls) + 1)
            return [], remaining_before
        repair_tags = (heal_tags or ("balanced_extraction",)) + call.argument_repairs
        record_repair(repair_tags)
        calls.append(replace(call, argument_repairs=repair_tags))
        remaining = remaining.replace(candidate, "", 1)
    return calls, remaining


def _failed_explicit_attempt(text: str, known_tool_names: frozenset[str]) -> bool:
    """Return whether an explicit non-code candidate failed JSON parsing.

    XML envelopes are the instructed in-band format and therefore strong
    evidence. Function notation is evidence only when it occupies the whole
    response and begins a JSON argument object; retrospective prose such as
    ``edit_file(normalize_bom=true) succeeded`` is deliberately excluded.
    """
    non_code_text = _MARKDOWN_CODE_RE.sub("", text)
    for payload in _xml_candidate_payloads(non_code_text):
        parsed, _tags = _parse_dict_with_tags(payload)
        if parsed is None:
            return True
        if "name" in parsed and _call_arguments(parsed) is None:
            return True  # a named envelope whose arguments value is unusable

    stripped = non_code_text.strip()
    for tool_name in known_tool_names:
        function_match = re.fullmatch(
            re.escape(tool_name) + r"\s*\(\s*(\{.*)\s*",
            stripped,
            re.DOTALL,
        )
        if function_match is None:
            continue
        raw_arguments = function_match.group(1).rstrip()
        if raw_arguments.endswith(")"):
            raw_arguments = raw_arguments[:-1].rstrip()
        arguments, _tags = _parse_dict_with_tags(raw_arguments)
        if arguments is None:
            return True
    return False


def extract_inband_tool_calls_detailed(
    text: str,
    known_tool_names: frozenset[str],
) -> InbandExtractionResult:
    """Extract tool calls and report explicit parse-failure evidence.

    ``remaining_text`` is the original text with successfully extracted tool
    call blocks removed. ``failed_attempt`` is true only when no call survived
    and a parser-selected explicit candidate failed JSON parsing.

    Only tool names present in *known_tool_names* are accepted to prevent
    false positives from the model mentioning tool names in prose.
    """
    if not text or not known_tool_names:
        return InbandExtractionResult((), text)

    # --- Format 1: XML-style tags (highest priority — instructed format) ---
    calls, remaining = _extract_wrapped_calls(text, text, known_tool_names, _XML_FORMAT)

    # --- Format 2: Markdown code blocks ---
    if not calls:
        shown = _fenced_calls_shown(text, known_tool_names)
        if shown:
            logger.info("Skipped %d fenced tool call(s): a result follows the call", shown)
        else:
            calls, remaining = _extract_wrapped_calls(text, remaining, known_tool_names, _MD_FORMAT)

    # --- Format 3: function-call syntax tool_name({...}) ---
    if not calls:
        calls, remaining = _extract_func_calls(text, remaining, known_tool_names)

    # --- Format 4 (healing-only): bare balanced JSON objects in prose ---
    if not calls and is_healing_enabled():
        calls, remaining = _extract_balanced_calls(text, remaining, known_tool_names)

    if calls:
        logger.info(
            "Extracted %d in-band tool call(s) from text: %s",
            len(calls),
            ", ".join(c.tool_id for c in calls),
        )

    return InbandExtractionResult(
        calls=tuple(calls),
        remaining_text=remaining.strip(),
        failed_attempt=(
            not calls and _failed_explicit_attempt(text, known_tool_names)
        ),
    )


def extract_inband_tool_calls(
    text: str,
    known_tool_names: frozenset[str],
) -> Tuple[List[ToolCallRequest], str]:
    """Compatibility wrapper returning ``(calls, remaining_text)``."""
    result = extract_inband_tool_calls_detailed(text, known_tool_names)
    return list(result.calls), result.remaining_text
