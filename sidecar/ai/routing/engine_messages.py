"""Engine-message helpers; helpers requiring router state receive the AgentKernel as kernel."""

from __future__ import annotations

import logging
import re
from collections.abc import Sequence
from typing import Any, cast

from sidecar.ai.context.builder import RuntimeToolStatus
from sidecar.ai.engines.base import EngineMessage, EngineToolCall
from sidecar.ai.routing.vision_turn import (
    VISION_ANCHOR_MESSAGE,
    VisionAnchorError,
    current_turn_anchor_index,
)
from sidecar.ai.tools.sanitization import has_control_tokens
from sidecar.ai.tools.schema_examples import format_tool_call_example
from sidecar.ai.tools.tool_families import (
    aliases_for_tool,
    find_tool_alias_index,
)
from sidecar.runtime.local_engine.messages import demote_non_leading_system_messages

logger = logging.getLogger(__name__)

_DESCRIPTIVE_TOOL_PHRASES = (
    "i would",
    "i'll",
    "i will",
    "i use",
    "let me",
    "i can use",
    "i need to",
    "i should",
    "i do not have",
    "i don't have",
    "i cannot",
    "i can't",
    "i am unable",
    "i'm unable",
    "we can use",
    "plan:",
    "use the",
    "call the",
    "calling",
    "using",
    "load the",
    "load ",
    "formulate",
)

_EXPLICIT_TOOL_REQUEST_VERBS = ("use", "call", "invoke", "run")
_NEGATED_REQUEST_PREFIX = re.compile(
    r"(?:\bnot\b|\bnever\b|\bwithout\b|\bdon't\b|\bdidn't\b|"
    r"\bshouldn't\b|\bcan't\b|\bcannot\b)[^.;!?\n]{0,96}$"
)
_DISCUSSION_REQUEST_PREFIX = re.compile(
    r"(?:\bhow\s+to|\bwhen\s+to|\bwhether\s+to|"
    r"\b(?:should|could|would|can|may)\s+i)\s*$"
)


def _tool_name(tool: dict[str, Any]) -> str:
    source = tool.get("function")
    payload = source if isinstance(source, dict) else tool
    return str(payload.get("name") or "").strip()


def _direct_request_position(content: str, spelling: str) -> int | None:
    pattern = re.compile(
        rf"\b(?:{'|'.join(_EXPLICIT_TOOL_REQUEST_VERBS)})\s+"
        rf"(?:the\s+)?[`'\"]*{re.escape(spelling)}[`'\"]*"
        rf"(?:\s+tool)?(?=$|[^a-z0-9_])"
    )
    for match in pattern.finditer(content):
        prefix = content[max(0, match.start() - 120) : match.start()]
        if _NEGATED_REQUEST_PREFIX.search(prefix):
            continue
        if _DISCUSSION_REQUEST_PREFIX.search(prefix):
            continue
        command_prefix = re.split(r"[.;!?\n]", prefix)[-1]
        if command_prefix.strip() and not re.search(
            r"(?:\bplease|\bcan\s+you|\bcould\s+you|\bwould\s+you|"
            r"\bwill\s+you|\byou\s+must|\bmust|\bthen|\band\s+then|"
            r"\bi\s+(?:want|need|require)\s+you\s+to)\s*$",
            command_prefix,
        ):
            continue
        return match.start()
    return None


def _conditional_request_position(content: str, spelling: str) -> int | None:
    pattern = re.compile(
        rf"(?:^|otherwise\s*,\s*|[.:;!?\n]\s*)if\s+"
        rf"[`'\"]*{re.escape(spelling)}[`'\"]*\s+is\s+available\s*,?\s*"
        rf"(?:then\s+)?(?:please\s+)?use\s+it\b"
    )
    match = pattern.search(content)
    if match is None:
        return None
    prefix = content[max(0, match.start() - 96) : match.start()]
    if _NEGATED_REQUEST_PREFIX.search(prefix):
        return None
    if content[match.start() : match.start() + 1] == ":":
        clause = re.split(r"[.;!?\n]", prefix)[-1].strip()
        directive = re.fullmatch(
            r"(?:evaluation\s+)?routing\s+rule|"
            r"(?:my\s+)?(?:request|requirement)|"
            r"(?:please\s+)?(?:follow|obey|use)\s+(?:this|the)\s+"
            r"(?:routing\s+)?(?:rule|instruction)",
            clause,
        )
        if directive is None:
            return None
    return match.start()


def explicitly_requested_tool_payload(
    latest_user_content: str,
    tool_payload: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Return available tools the user explicitly asked the model to call.

    This intentionally recognizes only a call verb followed by an exact
    available tool id (or its space-separated spelling). Nearby negation and
    discussion phrasing are excluded so questions about tools and negative
    controls do not turn into forced calls.
    """

    content = str(latest_user_content or "").lower()
    if not content.strip() or not tool_payload:
        return []

    matches: list[tuple[int, bool, dict[str, Any]]] = []
    for tool in tool_payload:
        name = _tool_name(tool)
        if not name:
            continue
        spellings = {name.lower(), name.lower().replace("_", " ")}
        for spelling in spellings:
            direct_position = _direct_request_position(content, spelling)
            if direct_position is not None:
                matches.append((direct_position, False, tool))
            conditional_position = _conditional_request_position(content, spelling)
            if conditional_position is not None:
                matches.append((conditional_position, True, tool))

    matches.sort(key=lambda item: item[0])
    if "otherwise" in content:
        first_conditional = next((item for item in matches if item[1]), None)
        if first_conditional is not None:
            return [first_conditional[2]]

    requested: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    for _, _, tool in matches:
        name = _tool_name(tool)
        if name and name not in seen_names:
            requested.append(tool)
            seen_names.add(name)
    return requested


# ---------------------------------------------------------------------------
# _should_nudge_tool_use
# ---------------------------------------------------------------------------

# Sentences for the prose-narration check.  The descriptive phrase and the tool
# mention must live in the same sentence, so the alias search is scoped to one
# of these spans rather than to a flat character window.
_SENTENCE_RE = re.compile(r"[^.;!?\n]+")

# Abbreviations whose internal dots are not sentence boundaries.  Splitting on
# a raw "." orphans whatever follows one into a span of its own, so a narrated
# tool loses the descriptive phrase that introduced it: "I would use e.g.
# glob_files here." would otherwise split into "...use e" / "g" / " glob_files
# here".  The dots are masked with a non-terminator character before
# splitting; the substitution is length-preserving, so offsets into the masked
# text still index the original.
_ABBREVIATION_DOT = "\x00"
_ABBREVIATION_RE = re.compile(r"\b(?:e\.g\.|i\.e\.|vs\.|etc\.|cf\.)")


def _mask_abbreviation_dots(text: str) -> str:
    """Replace the dots inside a known abbreviation with ``_ABBREVIATION_DOT``."""
    return _ABBREVIATION_RE.sub(
        lambda match: match.group(0).replace(".", _ABBREVIATION_DOT),
        text,
    )


# A spelling must have at least this many whitespace-separated words to be
# treated as prose narration (see _prose_tool_spellings).
_MIN_PROSE_WORDS = 2


def _is_multi_word(value: str) -> bool:
    return len(value.split()) >= _MIN_PROSE_WORDS


def _prose_tool_spellings(
    tool_name: str,
    *,
    display_name: str = "",
) -> set[str]:
    """Spellings of a tool that can plausibly signal prose *narration*.

    Only multi-word spellings are matchable, because a single English word is
    never by itself evidence that the model described a tool call: family
    aliases and single-word tool aliases ("home", "grep", "python",
    "manifest", "diagnostics", "calendar", "harness", ...) fire constantly on
    ordinary conversation.  The two exceptions are exact snake_case tool ids,
    which are code-ish tokens rather than English:

    * a multi-word id (``glob_files``) matches both as the id itself and as
      its underscore->space spelling ("glob files");
    * a single-word id (``home``) matches only when the text quotes it as a
      code token -- we require backticks (```home```), the simplest marker the
      model actually uses when it narrates a call.

    Family aliases (the ``TOOL_FAMILY_ALIASES`` table) are deliberately not
    used here; ``tool_families`` keeps them for user-intent routing.
    """

    normalized = str(tool_name or "").strip().lower()
    spellings: set[str] = set()
    if normalized:
        spaced = normalized.replace("_", " ")
        if _is_multi_word(spaced):
            spellings.add(normalized)
        else:
            spellings.add(f"`{normalized}`")
        # aliases_for_tool() yields the id, its spaced spelling and the
        # curated TOOL_ALIASES entries; keep only the multi-word ones.
        spellings.update(alias for alias in aliases_for_tool(normalized) if _is_multi_word(alias))
    display = str(display_name or "").strip().lower()
    if display:
        spellings.update(
            form for form in (display, display.replace("_", " ")) if _is_multi_word(form)
        )
    spellings.discard("")
    return spellings


def _alias_positions(sentence: str, alias: str) -> list[int]:
    positions: list[int] = []
    offset = 0
    while offset < len(sentence):
        found = find_tool_alias_index(sentence[offset:], alias)
        if found is None:
            break
        positions.append(offset + found)
        offset += found + 1
    return positions


def _prose_spellings_by_tool(
    tool_payload: list[dict[str, Any]],
    tool_statuses: tuple[RuntimeToolStatus, ...] | None,
) -> dict[str, set[str]]:
    """Map each tool id to the spellings that can signal prose narration.

    Keyed so the caller can recover *which* tool a sentence named; the union of
    the values is exactly the flat spelling set the boolean check used before.
    """
    spellings_by_tool: dict[str, set[str]] = {}
    for tool in tool_payload:
        name = (
            str((tool.get("function") or tool).get("name") or tool.get("name", "")).strip().lower()
        )
        spellings = _prose_tool_spellings(name)
        if name and spellings:
            spellings_by_tool.setdefault(name, set()).update(spellings)
    for status in tool_statuses or ():
        status_name = str(status.name or "").strip().lower()
        display = str(status.display_name or "").strip().lower()
        spellings = _prose_tool_spellings(status_name, display_name=display)
        key = status_name or display
        if key and spellings:
            spellings_by_tool.setdefault(key, set()).update(spellings)
    for spellings in spellings_by_tool.values():
        spellings.discard("")
    return {key: value for key, value in spellings_by_tool.items() if value}


def _prose_trigger_tool_names(
    lower_text: str,
    spellings_by_tool: dict[str, set[str]],
) -> list[str]:
    """Tool ids narrated after a descriptive phrase in the same sentence.

    Returned in text order (first mention wins), deduplicated.  An empty list
    means the prose-narration case did not fire.
    """
    if not spellings_by_tool:
        return []
    positions: dict[str, int] = {}
    masked_text = _mask_abbreviation_dots(lower_text)
    for sentence_match in _SENTENCE_RE.finditer(masked_text):
        sentence = sentence_match.group(0)
        phrase_positions = [
            sentence.find(phrase) for phrase in _DESCRIPTIVE_TOOL_PHRASES if phrase in sentence
        ]
        if not phrase_positions:
            continue
        earliest_phrase = min(phrase_positions)
        for tool_id, spellings in spellings_by_tool.items():
            hits = [
                index
                for spelling in spellings
                for index in _alias_positions(sentence, spelling)
                if index > earliest_phrase
            ]
            if hits:
                absolute = sentence_match.start() + min(hits)
                positions.setdefault(tool_id, absolute)
    return sorted(positions, key=lambda tool_id: (positions[tool_id], tool_id))


def should_nudge_tool_use(
    sanitized_text: str,
    raw_text: str,
    tool_payload: list[dict[str, Any]],
    *,
    tool_statuses: tuple[RuntimeToolStatus, ...] | None = None,
) -> bool:
    """Decide whether the model should be nudged to actually call tools.

    Returns ``True`` only when the raw output contains LLM control tokens
    (the model tried to invoke a tool-calling template but produced
    garbled text instead of structured ``tool_calls``), or the model
    described tool usage in prose without actually calling anything.

    Length-based heuristics are intentionally avoided so that legitimate
    short answers and long-but-truncated replies are never misclassified.
    """
    if not tool_payload and not tool_statuses:
        return False

    # Case 1: Raw output contains control tokens.  This is the
    # definitive signal that the model tried to use a tool-calling
    # template but the tokens leaked into content.
    if raw_text.strip() and has_control_tokens(raw_text):
        return True

    # Case 2: Response text mentions available or unavailable tool names in
    # prose, suggesting the model described what it *would* do rather than
    # actually calling the tool.
    lower_text = sanitized_text.strip().lower()
    if not lower_text:
        return False
    return bool(
        _prose_trigger_tool_names(
            lower_text,
            _prose_spellings_by_tool(tool_payload, tool_statuses),
        )
    )


def nudge_trigger_tool_names(
    sanitized_text: str,
    tool_payload: list[dict[str, Any]],
    *,
    tool_statuses: tuple[RuntimeToolStatus, ...] | None = None,
) -> list[str]:
    """Tool ids that made :func:`should_nudge_tool_use` fire, in text order.

    Sibling of the boolean check, sharing its internals: same spellings, same
    same-sentence rule.  Returns ``[]`` when the prose case did not fire --
    including for the control-token case, which names no tool at all.  Callers
    use it to point the nudge at the tool the model actually talked about
    instead of whatever sorts first in the payload.
    """
    lower_text = str(sanitized_text or "").strip().lower()
    if not lower_text:
        return []
    return _prose_trigger_tool_names(
        lower_text,
        _prose_spellings_by_tool(tool_payload, tool_statuses),
    )


# ---------------------------------------------------------------------------
# _build_tool_use_nudge
# ---------------------------------------------------------------------------


# Fallback read-only allowlist, consulted ONLY for payload entries that carry no
# ``side_effecting`` flag -- deferred name-only entries (tool_search.py) and
# legacy/direct callers.  Assembled prompt schemas
# (``assembly.schema_from_descriptor``) always carry the real flag, so this list
# never overrides the contract.  Deliberately short and inert: every entry reads
# state and mutates nothing, so demonstrating one can do no damage even if a
# model copies the example back verbatim.
_READ_ONLY_EXAMPLE_TOOLS = frozenset(
    {
        "glob_files",
        "grep_search",
        "jenny_status",
        "list_dir",
        "read_file",
        "workspace_manifest_read",
    }
)

# The nudge lists at most this many tool names, and picks its worked example
# from the same window.
_MAX_NUDGE_TOOL_NAMES = 8


def _nudge_tool_source(tool: dict[str, Any]) -> dict[str, Any]:
    function_payload = tool.get("function")
    return function_payload if isinstance(function_payload, dict) else tool


def _example_tool_is_read_only(tool: dict[str, Any]) -> bool:
    """Is this payload entry safe to demonstrate?

    Prefers the descriptor-derived ``side_effecting`` flag that the real prompt
    schema carries; falls back to the explicit allowlist above when the entry
    has no flag, and treats anything unknown as unsafe.
    """
    for candidate in (_nudge_tool_source(tool), tool):
        flag = candidate.get("side_effecting")
        if isinstance(flag, bool):
            return not flag
    name = str(_nudge_tool_source(tool).get("name") or tool.get("name", "")).strip().lower()
    return name in _READ_ONLY_EXAMPLE_TOOLS


def _select_example_tool(
    candidates: list[dict[str, Any]],
    trigger_tool_names: Sequence[str],
) -> dict[str, Any] | None:
    """Choose which tool the worked example demonstrates.

    Order: a tool the model actually narrated, then any read-only tool, then
    the first entry.  The middle step exists because the example used to be
    ``tool_payload[0]`` -- alphabetically ``apply_patch`` -- and a local 27B
    model copied it back as a real patch call with the placeholder arguments
    still in it, taking a pre-mutation git checkpoint on the way.
    """
    if not candidates:
        return None
    by_name: dict[str, dict[str, Any]] = {}
    for tool in candidates:
        name = str(_nudge_tool_source(tool).get("name") or tool.get("name", "")).strip().lower()
        if name:
            by_name.setdefault(name, tool)
    for requested in trigger_tool_names:
        match = by_name.get(str(requested or "").strip().lower())
        if match is not None:
            return match
    for name in sorted(by_name):
        if name in _READ_ONLY_EXAMPLE_TOOLS and _example_tool_is_read_only(by_name[name]):
            return by_name[name]
    for tool in candidates:
        if _example_tool_is_read_only(tool):
            return tool
    return candidates[0]


def build_tool_use_nudge(
    tool_payload: list[dict[str, Any]],
    *,
    explicit_request: bool = False,
    trigger_tool_names: Sequence[str] = (),
) -> str:
    """Build a nudge message that instructs the model to actually call tools.

    ``trigger_tool_names`` are the tool ids the model narrated (see
    :func:`nudge_trigger_tool_names`); the worked example is drawn from them
    when one of them is present in ``tool_payload``.  On the
    ``explicit_request`` path the example is always the first payload entry,
    which is the first tool the user actually named.
    """
    tool_names = []
    candidates: list[dict[str, Any]] = []
    for t in tool_payload[:_MAX_NUDGE_TOOL_NAMES]:
        name = str((t.get("function") or t).get("name") or t.get("name", ""))
        if name:
            tool_names.append(name)
            candidates.append(t)
    names_str = ", ".join(f"`{n}`" for n in tool_names)
    # The explicit payload is already narrowed to the tools the user named,
    # ordered by position in their text, so the example must demonstrate the
    # FIRST tool they asked for rather than whichever entry the read-only
    # preference happens to favour.
    example_tool = (
        candidates[0]
        if explicit_request and candidates
        else _select_example_tool(candidates, trigger_tool_names)
    )
    example_name = "TOOL_NAME"
    example_schema: dict[str, Any] | None = None
    if example_tool is not None:
        source = _nudge_tool_source(example_tool)
        example_name = str(source.get("name") or "TOOL_NAME")
        parameters = source.get("parameters")
        example_schema = parameters if isinstance(parameters, dict) else None
    example_payload = format_tool_call_example(example_name, example_schema)
    if explicit_request:
        return (
            "The original request explicitly required an available tool, but your "
            "previous response did not call it. You MUST call the requested tool "
            "directly; do not describe what you would do.\n\n"
            f"Available requested tools: {names_str}.\n\n"
            "To call the tool, output a tool call block:\n"
            "<tool_call>\n"
            f"{example_payload}\n"
            "</tool_call>\n\n"
            "Now answer the original request by calling the requested tool."
        )
    return (
        "Your previous response described using tools but did not actually "
        "call any. You MUST call tools directly \u2014 do not describe what you "
        "would do, just do it.\n\n"
        f"Available tools include: {names_str}.\n\n"
        "To call a tool, output a tool call block:\n"
        "<tool_call>\n"
        f"{example_payload}\n"
        "</tool_call>\n\n"
        "The example above shows the argument SHAPE only; send real values, "
        "never the placeholders.\n\n"
        "Now please answer the original request by calling the appropriate tool. "
        "If no tool is actually needed to answer, reply to the user directly "
        "without calling one."
    )


# ---------------------------------------------------------------------------
# _engine_messages
# ---------------------------------------------------------------------------


def engine_messages(
    messages: list[dict[str, object]],
    *,
    primary_system_text: str,
    vision_images: Sequence[Any] = (),
    vision_anchor_text: str | None = None,
) -> list[EngineMessage]:
    anchor_index = (
        current_turn_anchor_index(messages, anchor_text=vision_anchor_text)
        if vision_images
        else None
    )
    pre_demotion_messages = messages
    messages = demote_non_leading_system_messages(messages)
    if vision_images and len(messages) != len(pre_demotion_messages):
        raise VisionAnchorError(VISION_ANCHOR_MESSAGE)
    normalized: list[EngineMessage] = []
    skipped_primary_system = False
    attached_images = False
    for source_index, message in enumerate(messages):
        role = str(message.get("role", "")).strip().lower()
        if role not in {"system", "user", "assistant", "tool"}:
            continue
        raw_content = message.get("content")
        content = raw_content if isinstance(raw_content, str) else ""
        raw_tool_calls = message.get("tool_calls") if role == "assistant" else None
        has_tool_calls = isinstance(raw_tool_calls, list) and bool(raw_tool_calls)
        if not content.strip() and not has_tool_calls:
            continue
        if (
            role == "system"
            and not skipped_primary_system
            and content.strip() == primary_system_text.strip()
        ):
            skipped_primary_system = True
            continue
        entry: EngineMessage = {"role": role, "content": content}
        if role == "assistant" and has_tool_calls:
            entry["tool_calls"] = cast(list[EngineToolCall], raw_tool_calls)
        if role == "tool":
            tool_call_id = message.get("tool_call_id")
            if isinstance(tool_call_id, str):
                entry["tool_call_id"] = tool_call_id
            name = message.get("name")
            if isinstance(name, str):
                entry["name"] = name
        if vision_images and source_index == anchor_index:
            entry["images"] = list(vision_images)
            attached_images = True
        normalized.append(entry)
    if vision_images and not attached_images:
        raise VisionAnchorError(VISION_ANCHOR_MESSAGE)
    return normalized
