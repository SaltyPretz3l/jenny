"""Conservative ordered JSON repair for near-miss tool calls.

Feature gating is request-local, while repair helpers are pure and never invent
content.
"""

from __future__ import annotations

import json
import re
from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import Any

_HEALING_SETTINGS = {
    "enabled": False,
}
_REQUEST_HEALING_ENABLED: ContextVar[bool | None] = ContextVar(
    "sidecar_tool_call_healing_enabled",
    default=None,
)


def _enabled_from_config(config: Any | None) -> bool:
    if isinstance(config, dict):
        value = config.get("tool_call_reliability_net_enabled")
    else:
        value = getattr(config, "tool_call_reliability_net_enabled", None)
    return value is True


def configure_tool_call_healing(config: Any | None) -> None:
    """Cache the ``tool_call_reliability_net_enabled`` flag.

    Mirrors ``configure_grep_search``/``configure_distill``: accepts either a
    dict-like config or an attribute-bearing config object. Only a real
    ``bool`` value of ``True`` enables the net; anything else (missing key,
    ``None``, or a non-bool value) resets the cache to disabled.
    """
    _HEALING_SETTINGS["enabled"] = _enabled_from_config(config)


def default_tool_call_healing_enabled() -> bool:
    return bool(_HEALING_SETTINGS["enabled"])


def restore_tool_call_healing_default(enabled: bool) -> None:
    _HEALING_SETTINGS["enabled"] = enabled is True


def bind_tool_call_healing(config: Any | None) -> Token[bool | None]:
    """Bind one turn's healing policy without mutating concurrent turns."""

    _HEAL_TELEMETRY.set(0)
    return _REQUEST_HEALING_ENABLED.set(_enabled_from_config(config))


def reset_tool_call_healing(token: Token[bool | None]) -> None:
    _HEAL_TELEMETRY.set(0)
    _REQUEST_HEALING_ENABLED.reset(token)


def is_healing_enabled() -> bool:
    """Return whether the tool-call reliability net is currently enabled."""
    request_value = _REQUEST_HEALING_ENABLED.get()
    if request_value is not None:
        return request_value
    return bool(_HEALING_SETTINGS["enabled"])


# ---------------------------------------------------------------------------
# Heal telemetry accumulator
#
# The heal wiring seams (inband_parser, ollama_runtime) have no kernel access,
# so successful repairs are tallied here and drained by the routing layer's
# reliability event emitter, which routes them into the per-profile
# ``repair_used`` counter. Explicit bounded process-global state: capped as a
# leak backstop, drained every tool-bearing turn, owned by this module.
# ---------------------------------------------------------------------------

_TELEMETRY_COUNT_CAP = 10_000

_HEAL_TELEMETRY: ContextVar[int] = ContextVar(
    "sidecar_tool_call_heal_telemetry",
    default=0,
)


def record_repair(tags: tuple[str, ...]) -> None:
    """Tally one successful heal-assisted parse (no-op when the net is off).

    ``tags`` is the repair-tag tuple from the heal that succeeded; an empty
    tuple means no repair actually happened, so nothing is recorded.
    """
    if not tags or not is_healing_enabled():
        return
    current = _HEAL_TELEMETRY.get()
    if current < _TELEMETRY_COUNT_CAP:
        _HEAL_TELEMETRY.set(current + 1)


def drain_heal_telemetry() -> dict[str, int]:
    """Return the accumulated heal counts and reset them to zero."""
    repair_used = _HEAL_TELEMETRY.get()
    _HEAL_TELEMETRY.set(0)
    return {"repair_used": repair_used}


# ---------------------------------------------------------------------------
# Healing core
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class HealResult:
    """Outcome of a repair attempt.

    ``value`` is the parsed object (only ``dict`` payloads are useful for
    tool-calls, so a healed non-dict yields ``None``). ``repairs`` is the
    ordered tuple of tags for the passes that actually changed the string.
    """

    value: dict | None
    repairs: tuple[str, ...]


_SMART_QUOTES = {
    "“": '"',
    "”": '"',
    "‘": "'",
    "’": "'",
}

_FENCE_RE = re.compile(r"^\s*```[a-zA-Z_]*\s*\n?|\n?\s*```\s*$")
_TOOL_CALL_TAG_RE = re.compile(r"</?tool_call>", re.IGNORECASE)


def _try_parse_dict(text: str) -> dict | None:
    """Return the parsed object only when it is a ``dict``; else ``None``."""
    try:
        parsed = json.loads(text)
    except (ValueError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _scan_string_spans(text: str) -> list[tuple[int, int]]:
    """Return ``(start, end)`` spans of double-quoted strings (end exclusive).

    String-aware: honours backslash escapes so escaped quotes do not close a
    string. An unterminated final string runs to end-of-text.
    """
    spans: list[tuple[int, int]] = []
    i = 0
    length = len(text)
    while i < length:
        if text[i] != '"':
            i += 1
            continue
        start = i
        i += 1
        while i < length:
            ch = text[i]
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                i += 1
                break
            i += 1
        spans.append((start, i))
    return spans


def _in_any_span(index: int, spans: list[tuple[int, int]]) -> bool:
    """Return True when ``index`` falls inside one of the string spans."""
    for start, end in spans:
        if start <= index < end:
            return True
    return False


def _strip_debris(text: str) -> str:
    """Remove ``<tool_call>`` tags from arbitrary text."""
    return _TOOL_CALL_TAG_RE.sub("", text)


def _strip_fences(text: str) -> str:
    """Strip a single leading/trailing markdown fence pair from ``text``."""
    stripped = _FENCE_RE.sub("", text)
    return _FENCE_RE.sub("", stripped)


def _isolate_outermost_object(text: str) -> str | None:
    """Return the first balanced top-level ``{...}`` span, else ``None``."""
    objects = extract_balanced_json_objects(text)
    return objects[0] if objects else None


_ANY_FENCE_RE = re.compile(r"```")


def _strip_wrapping(raw: str) -> tuple[str, tuple[str, ...]]:
    """Strip fences/debris/prose; return cleaned text and applied tags.

    A backtick fence anywhere in the raw string tags ``stripped_fence``;
    ``<tool_call>`` markup tags ``stripped_debris``; isolating a balanced
    object out of surrounding prose (with no fence) also tags
    ``stripped_debris``.
    """
    tags: list[str] = []
    had_fence = bool(_ANY_FENCE_RE.search(raw))
    without_debris = _strip_debris(raw)
    if without_debris != raw:
        tags.append("stripped_debris")
    without_fence = _strip_fences(without_debris)
    if had_fence:
        tags.append("stripped_fence")
    isolated = _isolate_outermost_object(without_fence)
    if isolated is not None:
        if not had_fence and isolated != without_fence.strip():
            tags.append("stripped_debris")
        without_fence = isolated
    # Deduplicate while preserving order.
    seen: list[str] = []
    for tag in tags:
        if tag not in seen:
            seen.append(tag)
    return without_fence, tuple(seen)


def _replace_smart_quotes(text: str) -> str:
    """Map curly quotes to their ASCII equivalents."""
    for smart, ascii_ch in _SMART_QUOTES.items():
        text = text.replace(smart, ascii_ch)
    return text


def _replace_python_literals(text: str) -> str:
    """Rewrite ``True``/``False``/``None`` outside strings to JSON literals."""
    spans = _scan_string_spans(text)
    mapping = {"True": "true", "False": "false", "None": "null"}
    result = text
    # Walk matches right-to-left so indices stay valid as we splice.
    matches = list(re.finditer(r"\b(True|False|None)\b", text))
    for match in reversed(matches):
        if _in_any_span(match.start(), spans):
            continue
        replacement = mapping[match.group(1)]
        result = result[: match.start()] + replacement + result[match.end() :]
    return result


def _convert_single_quotes(text: str) -> str:
    """Convert single-quoted JSON tokens to double-quoted, string-aware.

    Only single quotes that sit outside existing double-quoted spans are
    treated as string delimiters. Handles escaped inner content by swapping to
    double quotes at the boundaries.
    """
    dq_spans = _scan_string_spans(text)
    out: list[str] = []
    i = 0
    length = len(text)
    while i < length:
        ch = text[i]
        if ch == "'" and not _in_any_span(i, dq_spans):
            out.append('"')
            i += 1
            while i < length:
                inner = text[i]
                if inner == "\\":
                    if i + 1 < length and text[i + 1] == "'":
                        out.append("'")
                        i += 2
                        continue
                    out.append(text[i : i + 2])
                    i += 2
                    continue
                if inner == "'":
                    out.append('"')
                    i += 1
                    break
                if inner == '"':
                    out.append('\\"')
                    i += 1
                    continue
                out.append(inner)
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _remove_trailing_commas(text: str) -> str:
    """Drop commas that directly precede ``}``/``]`` outside strings."""
    spans = _scan_string_spans(text)
    result_chars: list[str] = []
    length = len(text)
    for i, ch in enumerate(text):
        if ch == "," and not _in_any_span(i, spans):
            j = i + 1
            while j < length and text[j] in " \t\r\n":
                j += 1
            if j < length and text[j] in "}]":
                continue
        result_chars.append(ch)
    return "".join(result_chars)


def _has_complete_member(text: str) -> bool:
    """True when a comma sits outside any string span in ``text``.

    A top-level or nested comma means at least one ``key: value`` member was
    completed before the truncation point, so closing a dangling string only
    finishes an already-real member rather than inventing a first value.

    NOTE: this guard is per-payload, not per-argument-object — a truncated
    envelope like ``{"name": "read_file", "arguments": {"path": "ma`` WILL
    heal here (the top-level comma counts). On the in-band path that payload
    is safe only because the extraction gate (anchored regexes /
    balanced-object scan) never hands an unterminated fragment to the healer;
    if the extraction layer ever changes, this guard alone does not make
    ``repair_json_payload`` conservative for first-value truncation inside a
    nested arguments object.
    """
    spans = _scan_string_spans(text)
    for i, ch in enumerate(text):
        if ch == "," and not _in_any_span(i, spans):
            return True
    return False


def _scan_open_structure(text: str) -> tuple[bool, list[str]]:
    """Return ``(in_string, stack)`` at end-of-text for a string-aware scan."""
    stack: list[str] = []
    in_string = False
    escaped = False
    for ch in text:
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch in "{[":
            stack.append(ch)
        elif ch == "}" and stack and stack[-1] == "{":
            stack.pop()
        elif ch == "]" and stack and stack[-1] == "[":
            stack.pop()
    return in_string, stack


def _close_open_structures(text: str) -> tuple[str, tuple[str, ...]]:
    """Close an unterminated final string and balance open braces/brackets.

    Returns the repaired text and the tags for what was actually closed. Never
    invents content; only appends the closers implied by the open structure.
    """
    in_string, stack = _scan_open_structure(text)
    tags: list[str] = []
    repaired = text
    if in_string:
        if not _has_complete_member(text):
            # Truncated inside the very first value: closing here would only
            # keep a partial token — that is guessing content, so refuse.
            return text, ()
        repaired += '"'
        tags.append("closed_string")
    if stack:
        closers = "".join("}" if opener == "{" else "]" for opener in reversed(stack))
        repaired += closers
        tags.append("closed_brace")
    return repaired, tuple(tags)


def _repair_passes(text: str) -> tuple[dict | None, tuple[str, ...]]:
    """Apply ordered cheap passes, parsing after each; stop at first success."""
    applied: list[str] = []
    passes: list[tuple[str, Any]] = [
        ("ascii_quotes", _replace_smart_quotes),
        ("python_literals", _replace_python_literals),
        ("single_quotes", _convert_single_quotes),
        ("trailing_comma", _remove_trailing_commas),
    ]
    for tag, transform in passes:
        transformed = transform(text)
        if transformed != text:
            applied.append(tag)
            text = transformed
            parsed = _try_parse_dict(text)
            if parsed is not None:
                return parsed, tuple(applied)
    closed, close_tags = _close_open_structures(text)
    if close_tags:
        applied.extend(close_tags)
        text = closed
        parsed = _try_parse_dict(text)
        if parsed is not None:
            return parsed, tuple(applied)
    return None, tuple(applied)


def repair_json_payload(raw: str) -> HealResult:
    """Heal a near-miss tool-call payload into a ``dict`` or report failure.

    Tries a clean parse first, then conservative ordered passes, tagging each
    pass that changes the string. Never invents keys or values.
    """
    direct = _try_parse_dict(raw)
    if direct is not None:
        return HealResult(direct, ())
    # A clean parse that yields a non-dict is not useful; short-circuit only if
    # the raw string parses at all.
    try:
        json.loads(raw)
        return HealResult(None, ())
    except (ValueError, json.JSONDecodeError):
        pass

    cleaned, wrap_tags = _strip_wrapping(raw)
    parsed = _try_parse_dict(cleaned)
    if parsed is not None:
        return HealResult(parsed, wrap_tags)

    value, pass_tags = _repair_passes(cleaned)
    return HealResult(value, wrap_tags + pass_tags)


def extract_balanced_json_objects(text: str) -> list[str]:
    """Return each top-level balanced ``{...}`` substring in ``text``.

    String-aware: braces inside JSON strings (including escaped quotes) never
    open or close an object. Unterminated final objects are NOT returned.
    """
    objects: list[str] = []
    depth = 0
    start = -1
    in_string = False
    escaped = False
    for i, ch in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}" and depth > 0:
            depth -= 1
            if depth == 0 and start >= 0:
                objects.append(text[start : i + 1])
                start = -1
    return objects


def coerce_arguments(value: object) -> tuple[dict, tuple[str, ...]] | None:
    """Coerce a tool-call ``arguments`` value into a ``(dict, tags)`` pair.

    - ``dict`` passes through with empty tags.
    - ``str`` is parsed as JSON; a healed dict carries the healing tags.
    - anything else returns ``None``.
    """
    if isinstance(value, dict):
        return value, ()
    if isinstance(value, str):
        parsed = _try_parse_dict(value)
        if parsed is not None:
            return parsed, ("parsed_string_arguments",)
        healed = repair_json_payload(value)
        if healed.value is not None:
            return healed.value, ("parsed_string_arguments",) + healed.repairs
        return None
    return None
