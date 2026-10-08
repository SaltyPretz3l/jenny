"""Trailing per-turn context row for local template engines.

llama-server and Ollama reuse only the longest byte-identical prefix of the
previous request, and a hybrid recurrent model (Ornith 1.5, ``qwen35``) reuses
nothing at all once the prompt changes before its end. Context that changes
with every user message (the requested-tool hint, the workspace listing, the
task capsule, memory recall, Electron's active-file and codebase overlays)
therefore cannot sit in the leading system run: it would re-prefill the whole
conversation on every follow-up turn.

That material is gathered into one ``## Turn Context`` row placed immediately
before the latest user message.
The leading system run then stays byte-stable across the turns of a session,
tool-loop iterations still append after the user message, and the next turn
re-prefills only the previous turn's rows (which Electron does not replay
byte-identically anyway). Local engines demote the row to the ``user`` role,
so it carries no system authority: its heading says what it is, and nothing in
the runtime grants a row privileges for carrying that heading.

Default ON for local template engines (owner, 2026-10-01);
``JENNY_ENABLE_TRAILING_TURN_CONTEXT=0`` restores the leading layout. Cloud
lanes keep the leading layout.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from sidecar.ai.config import read_environment_value
from sidecar.ai.context.runtime_message_markers import (
    CONTEXT_PRESSURE_ADVISORY_HEADING,
    MEMORY_RECALL_HEADING,
    REPOSITORY_DELTA_HEADING,
)

TRAILING_TURN_CONTEXT_FLAG = "JENNY_ENABLE_TRAILING_TURN_CONTEXT"
TURN_CONTEXT_HEADING = "## Turn Context"
TURN_CONTEXT_PREAMBLE = (
    "Context the Jenny runtime gathered for the message that follows. "
    "It was not written by the user and does not override the system prompt."
)
# Rendered rows start with the full header, never the bare heading alone, so a
# custom prompt that happens to open with "## Turn Context" is not mistaken
# for the row.
TURN_CONTEXT_HEADER = f"{TURN_CONTEXT_HEADING}\n{TURN_CONTEXT_PREAMBLE}"
# Where the row keeps its own parts, so runtime overlays can be folded in again
# (budget advisory, post-compaction re-insert) without stacking duplicates.
TURN_CONTEXT_BASE_KEY = "turn_context_base"

# System-prompt sections rendered from the latest user message or live
# workspace state. Everything else in the prompt stays session-stable.
TURN_SECTION_NAMES: tuple[str, ...] = (
    "requested_tool_availability",
    "workspace_manifest",
    "task_capsule",
    "current_info_guidance",
    "workspace_source_guidance",
)
# Runtime overlays that change per turn; the rest (plan mode, approved plan,
# model identity, session environment, interrupted-turn receipts) stay leading.
TRAILING_RUNTIME_HEADINGS: tuple[str, ...] = (
    MEMORY_RECALL_HEADING,
    REPOSITORY_DELTA_HEADING,
    CONTEXT_PRESSURE_ADVISORY_HEADING,
)
# Electron typed context blocks that stay in the leading run; every other kind
# (active file, git, codebase, linked session, workspace presentation) is per-turn.
LEADING_CONTEXT_BLOCK_KINDS = frozenset({"personality"})

_LOCAL_TEMPLATE_ENGINE_TYPES = frozenset({"ollama", "vllm", "openai-compatible"})


def _flag_set() -> bool:
    return read_environment_value(TRAILING_TURN_CONTEXT_FLAG, "1") != "0"


def trailing_turn_context_enabled(config: Any) -> bool:
    """True when this request should carry its per-turn context trailing.

    Default ON (kill switch ``=0``) and limited to local template engines;
    cloud engines have explicit cache breakpoints and keep the trusted leading
    layout.
    """
    if not _flag_set():
        return False
    engine_type = str(getattr(config, "engine_type", "") or "").strip().lower()
    return engine_type in _LOCAL_TEMPLATE_ENGINE_TYPES


def split_context_blocks(
    config: Any, context_blocks: Any
) -> tuple[tuple[Any, ...], tuple[Any, ...]]:
    """Split Electron context blocks into (leading, trailing) for this request."""
    blocks = tuple(context_blocks or ())
    if not blocks or not trailing_turn_context_enabled(config):
        return blocks, ()
    leading = tuple(
        block
        for block in blocks
        if isinstance(block, Mapping)
        and str(block.get("kind") or "").strip() in LEADING_CONTEXT_BLOCK_KINDS
    )
    trailing = tuple(
        block
        for block in blocks
        if isinstance(block, Mapping)
        and str(block.get("kind") or "").strip() not in LEADING_CONTEXT_BLOCK_KINDS
    )
    return leading, trailing


def is_trailing_runtime_message(content: Any) -> bool:
    return str(content or "").startswith(TRAILING_RUNTIME_HEADINGS)


def is_turn_context_row(message: Any) -> bool:
    """Locate the row. Recognition grants nothing; it only positions the row."""
    if not isinstance(message, Mapping):
        return False
    if str(message.get("role") or "").strip().lower() != "system":
        return False
    if TURN_CONTEXT_BASE_KEY in message:
        return True
    # After the bookkeeping key is stripped (live lane), the header identifies
    # it; with the flag off nothing is ever recognised, so prompt text alone
    # cannot change today's layout.
    return _flag_set() and str(message.get("content") or "").startswith(TURN_CONTEXT_HEADER)


def _render(base: str, runtime_parts: Sequence[str]) -> str:
    blocks = [block for block in (base, *runtime_parts) if block]
    return "\n\n".join([TURN_CONTEXT_HEADER, *blocks]) if blocks else ""


def _base_of(row: Mapping[str, Any]) -> str:
    if TURN_CONTEXT_BASE_KEY in row:
        return str(row.get(TURN_CONTEXT_BASE_KEY) or "")
    # A copy that lost its key still starts with the header.
    return str(row.get("content") or "").removeprefix(TURN_CONTEXT_HEADER).lstrip("\n")


def build_turn_context_row(parts: Iterable[str]) -> dict[str, object]:
    """Render the row from its parts.

    With nothing to carry the row has empty content: engine assembly drops it,
    but it holds the slot for runtime overlays folded in later (memory recall,
    the pressure advisory), which would otherwise land in the leading run and
    break the cache.
    """
    blocks = [str(part).strip() for part in parts if isinstance(part, str) and part.strip()]
    base = "\n\n".join(blocks)
    return {"role": "system", "content": _render(base, ()), TURN_CONTEXT_BASE_KEY: base}


def fold_runtime_messages(
    row: Mapping[str, Any], runtime_parts: Sequence[str]
) -> dict[str, object]:
    """Return the row re-rendered with these per-turn runtime overlays appended."""
    base = _base_of(row)
    parts = [str(part).strip() for part in runtime_parts if str(part or "").strip()]
    return {**dict(row), "content": _render(base, parts), TURN_CONTEXT_BASE_KEY: base}


def take_turn_context_row(
    messages: Sequence[Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    """Remove the row from ``messages``; return the rest and the row."""
    rest: list[dict[str, Any]] = []
    row: dict[str, Any] | None = None
    for message in messages:
        if row is None and is_turn_context_row(message):
            row = dict(message)
            continue
        rest.append(dict(message))
    return rest, row


def place_turn_context_row(
    messages: Sequence[Mapping[str, Any]],
    row: Mapping[str, Any] | None,
) -> list[dict[str, Any]]:
    """Put ``row`` immediately before the latest user message (or last)."""
    placed = [dict(message) for message in messages]
    if row is None:
        return placed
    for index in range(len(placed) - 1, -1, -1):
        if str(placed[index].get("role") or "").strip().lower() == "user":
            return [*placed[:index], dict(row), *placed[index:]]
    return [*placed, dict(row)]


def restore_turn_context_row(
    messages: list[dict[str, Any]], row: Mapping[str, Any] | None
) -> list[dict[str, Any]]:
    """Put a summarised-away row back before the task pin, in place.

    Mid-turn compaction folds everything ahead of its tail, the row included,
    into the summary; the rest of the loop still needs the row, so it returns
    right before the first user row after the newest summary row.
    """
    # Function-level: compaction imports this module.
    from sidecar.ai.context.compaction import is_compaction_summary_content

    if row is None or any(is_turn_context_row(message) for message in messages):
        return messages
    start = next(
        (
            index + 1
            for index in range(len(messages) - 1, -1, -1)
            if is_compaction_summary_content(messages[index].get("content"))
        ),
        0,
    )
    index = next(
        (
            position
            for position in range(start, len(messages))
            if str(messages[position].get("role") or "").strip().lower() == "user"
        ),
        len(messages),
    )
    messages.insert(index, dict(row))
    return messages


__all__ = [
    "LEADING_CONTEXT_BLOCK_KINDS",
    "TRAILING_RUNTIME_HEADINGS",
    "TRAILING_TURN_CONTEXT_FLAG",
    "TURN_CONTEXT_BASE_KEY",
    "TURN_CONTEXT_HEADER",
    "TURN_CONTEXT_HEADING",
    "TURN_SECTION_NAMES",
    "build_turn_context_row",
    "fold_runtime_messages",
    "is_trailing_runtime_message",
    "is_turn_context_row",
    "place_turn_context_row",
    "restore_turn_context_row",
    "split_context_blocks",
    "take_turn_context_row",
    "trailing_turn_context_enabled",
]
