"""Parse tool calls from model text output when native tool calling fails.

Local LLMs may describe tool usage in prose or semi-structured text instead
of producing structured ``tool_calls`` in the API response.  This module
extracts those in-band tool call attempts so the agent loop can execute them.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, replace
from typing import List, Tuple
from uuid import uuid4

from .models import ToolCallRequest
from .tool_call_healing import (
    extract_balanced_json_objects,
    is_healing_enabled,
    record_repair,
    repair_json_payload,
)

logger = logging.getLogger(__name__)


def _gen_inband_call_id(tool_name: str) -> str:
    return f"inband_{tool_name}_{uuid4().hex[:10]}"


# ---------------------------------------------------------------------------
# Format 1: XML-style <tool_call>...</tool_call>
# ---------------------------------------------------------------------------
_TOOL_CALL_XML_RE = re.compile(
    r"<tool_call>\s*(\{.*?\})\s*</tool_call>",
    re.DOTALL,
)

# ---------------------------------------------------------------------------
# Format 2: Markdown code block ```tool_call ... ``` or ```json ... ```
# ---------------------------------------------------------------------------
_TOOL_CALL_MD_RE = re.compile(
    r"```(?:tool_call|json)\s*\n(\{.*?\})\s*\n```",
    re.DOTALL,
)

# ---------------------------------------------------------------------------
# Format 3: tool_name({"param": "value"})
# ---------------------------------------------------------------------------
_TOOL_CALL_FUNC_RE = re.compile(
    r"\b([a-z][a-z0-9_]*)\s*\(\s*(\{.*?\})\s*\)",
    re.DOTALL,
)

_TOOL_CALL_XML_CANDIDATE_RE = re.compile(
    r"<tool_call>\s*(.*?)\s*</tool_call>",
    re.DOTALL,
)
_MARKDOWN_CODE_RE = re.compile(r"```.*?```|`[^`\n]*`", re.DOTALL)


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


def _build_tool_call_from_dict(
    obj: object,
    known_tool_names: frozenset[str],
) -> ToolCallRequest | None:
    """Same dict-shape/name-allowlist/arguments checks for any candidate dict."""
    if not isinstance(obj, dict):
        return None
    name = str(obj.get("name") or "").strip()
    if name not in known_tool_names:
        return None
    arguments = obj.get("arguments", {})
    if not isinstance(arguments, dict):
        arguments = {}
    return ToolCallRequest(
        tool_id=name,
        arguments=arguments,
        call_id=_gen_inband_call_id(name),
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
    return (replace(call, argument_repairs=tags) if call is not None else None), tags


def _extract_wrapped_calls(
    text: str,
    remaining: str,
    known_tool_names: frozenset[str],
    pattern: "re.Pattern[str]",
) -> Tuple[List[ToolCallRequest], str]:
    """Shared pass for the XML/fence wrapper formats (payload in group 1)."""
    calls: List[ToolCallRequest] = []
    for match in pattern.finditer(text):
        call, heal_tags = _parse_tool_json_with_tags(match.group(1), known_tool_names)
        if call is not None:
            record_repair(heal_tags)
            calls.append(call)
            remaining = remaining.replace(match.group(0), "", 1)
    return calls, remaining


def _parse_func_arguments(raw_json: str) -> tuple[dict | None, tuple[str, ...]]:
    """Parse a func-syntax arguments object, with the gated heal second chance."""
    try:
        arguments = json.loads(raw_json)
    except json.JSONDecodeError:
        if not is_healing_enabled():
            return None, ()
        healed = repair_json_payload(raw_json)
        if healed.value is None:
            return None, ()
        return healed.value, (healed.repairs or ("healed",))
    return (arguments, ()) if isinstance(arguments, dict) else (None, ())


def _extract_func_calls(
    text: str,
    remaining: str,
    known_tool_names: frozenset[str],
) -> Tuple[List[ToolCallRequest], str]:
    """Format 3: function-call syntax ``tool_name({...})``."""
    calls: List[ToolCallRequest] = []
    for match in _TOOL_CALL_FUNC_RE.finditer(text):
        func_name = match.group(1)
        if func_name not in known_tool_names:
            continue
        arguments, heal_tags = _parse_func_arguments(match.group(2))
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
        remaining = remaining.replace(match.group(0), "", 1)
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
    for candidate in extract_balanced_json_objects(text):
        obj, heal_tags = _parse_dict_with_tags(candidate)
        if obj is None or not isinstance(obj.get("arguments"), dict):
            continue
        call = _build_tool_call_from_dict(obj, known_tool_names)
        if call is not None:
            repair_tags = heal_tags or ("balanced_extraction",)
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
    for match in _TOOL_CALL_XML_CANDIDATE_RE.finditer(non_code_text):
        parsed, _tags = _parse_dict_with_tags(match.group(1))
        if parsed is None:
            return True

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
        arguments, _tags = _parse_func_arguments(raw_arguments)
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
    calls, remaining = _extract_wrapped_calls(
        text, text, known_tool_names, _TOOL_CALL_XML_RE
    )

    # --- Format 2: Markdown code blocks ---
    if not calls:
        calls, remaining = _extract_wrapped_calls(
            text, remaining, known_tool_names, _TOOL_CALL_MD_RE
        )

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
