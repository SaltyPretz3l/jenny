"""Semantic message sanitization and compaction for model context assembly."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from sidecar.ai.config_models import uses_minimal_system_prompt
from sidecar.ai.context.compaction import is_compaction_summary_content
from sidecar.ai.context.message_utils import (
    admit_tool_envelope,
    ensure_tool_result_pairing,
)
from sidecar.ai.personality import build_personality_system_message

# Request history has already passed the wire-level per-message admission gate.
# These are an aggregate emergency ceiling for the model-facing copy, not a
# routine "last N rows" policy.  Complete user turns remain indivisible even
# when one unusually large turn exceeds the soft row ceiling.
MAX_SEMANTIC_MESSAGES = 1_024
MAX_SEMANTIC_BYTES = 2 * 1024 * 1024
_BASE64_BLOB_RE = re.compile(r"data:image/[^;]+;base64,[A-Za-z0-9+/=]*|[A-Za-z0-9+/=]{800,}")
_THINK_TAG_RE = re.compile(
    r"<think>.*?</think>|<think>.*$|</?think>",
    re.IGNORECASE | re.DOTALL,
)
EMPTY_ASSISTANT_CONTENT_PLACEHOLDER = "(no content)"
MAX_TOOL_ARGUMENTS_JSON_CHARS = 100_000


@dataclass(frozen=True)
class SemanticAdmissionResult:
    messages: list[dict[str, object]]
    input_complete: bool
    dropped_messages: int
    dropped_bytes: int


def _sanitize_content(content: Any) -> str:
    if isinstance(content, list):
        fragments = [
            _sanitize_content(item.get("text", "")) for item in content if isinstance(item, dict)
        ]
        return "\n".join(fragment for fragment in fragments if fragment)

    text = str(content or "")
    if not text:
        return ""
    # Substitute only the matched span: replacing the whole content would wipe
    # legitimate surrounding text (e.g. a compaction summary quoting one long
    # verbatim token) along with the blob.
    return _BASE64_BLOB_RE.sub("[omitted encoded attachment payload]", text).strip()


def _sanitize_tool_call(candidate: Any) -> dict[str, object] | None:
    if not isinstance(candidate, dict):
        return None
    function = candidate.get("function")
    nested_function = function if isinstance(function, dict) else {}
    call_name = (
        candidate.get("name")
        or candidate.get("tool_id")
        or nested_function.get("name")
    )
    if not isinstance(call_name, str) or not call_name.strip():
        return None

    arguments = candidate.get("arguments")
    if arguments is None:
        arguments = nested_function.get("arguments")
    if isinstance(arguments, str):
        if len(arguments) > MAX_TOOL_ARGUMENTS_JSON_CHARS:
            arguments = {}
        else:
            try:
                parsed_arguments = json.loads(arguments)
            except (json.JSONDecodeError, TypeError, ValueError):
                parsed_arguments = {}
            arguments = parsed_arguments if isinstance(parsed_arguments, dict) else {}
    elif not isinstance(arguments, dict):
        arguments = {}

    return {
        "name": call_name.strip(),
        "arguments": arguments,
        "call_id": str(candidate.get("call_id") or candidate.get("id") or "").strip(),
    }


def _is_compaction_summary_system_message(role: str, content: Any) -> bool:
    # Gate on the raw text, not _sanitize_content output: sanitization may
    # rewrite the content (blob substitution) and must not decide admission.
    return role == "system" and is_compaction_summary_content(content)


def sanitize_semantic_message(message: Any) -> dict[str, object] | None:
    if not isinstance(message, dict):
        return None
    role = message.get("role")
    if not isinstance(role, str) or not role.strip():
        return None
    normalized_role = role.strip().lower()
    # Request history is untrusted input: only semantic dialogue/tool roles are
    # allowed. The single system-role exception is Electron's persisted
    # manual-compaction snapshot (JCA-003): its summary rides the request
    # history as the sidecar's own COMPACTED_SUMMARY_HEADING system message and
    # must survive to the model, or every post-compaction send silently loses
    # the summarized context. A conversation cannot mint a system row (store
    # roles are user/assistant/tool) and session import strips system rows
    # before persisting (session-export-import.js), so a heading-forged row
    # requires direct write access to the session store.
    if normalized_role not in {"user", "assistant", "tool"} and not (
        _is_compaction_summary_system_message(normalized_role, message.get("content"))
    ):
        return None

    sanitized: dict[str, object] = {"role": normalized_role}
    content = _sanitize_content(message.get("content"))
    if content:
        sanitized["content"] = content

    tool_calls = message.get("tool_calls")
    if isinstance(tool_calls, list):
        sanitized_calls = [
            sanitized_call
            for candidate in tool_calls
            if (sanitized_call := _sanitize_tool_call(candidate)) is not None
        ]
        if sanitized_calls:
            sanitized["tool_calls"] = sanitized_calls

    if normalized_role == "tool":
        tool_call_id = message.get("tool_call_id")
        if isinstance(tool_call_id, str) and tool_call_id.strip():
            sanitized["tool_call_id"] = tool_call_id.strip()
        name = message.get("name")
        if isinstance(name, str) and name.strip():
            sanitized["name"] = name.strip()
        if message.get("is_error") is True:
            sanitized["is_error"] = True
        error_code = message.get("error_code")
        if isinstance(error_code, str) and error_code.strip():
            sanitized["error_code"] = error_code.strip()
        envelope = admit_tool_envelope(message.get("tool_envelope"))
        if envelope is not None:
            sanitized["tool_envelope"] = envelope

    return sanitized


def has_personality_context_block(context_blocks: Any) -> bool:
    """True when this turn carries a personality block on the typed channel.

    The exactly-one-``## Personality``-message invariant is enforced by the
    CALLER passing this structural answer to
    ``build_dynamic_system_messages(personality_rendered=...)`` — never by
    scanning assembled message text, which would couple prompt assembly to the
    rendered heading string.
    """
    if not context_blocks:
        return False
    return any(
        isinstance(block, dict) and str(block.get("kind") or "").strip() == "personality"
        for block in context_blocks
    )


def resolve_personality_rendered(config: Any, context_blocks: Any) -> bool:
    """Will this turn render its ``## Personality`` row from the typed block?

    THE single expression behind the exactly-one-message invariant. Every
    caller -- the routed lane, the live-stream lane, and the approval-plan
    freeze that records the answer for resume -- must ask this function rather
    than re-deriving it, because the two halves are easy to get subtly wrong
    apart: the minimal profile suppresses the block even when one was sent, so
    ``has_personality_context_block`` ALONE is not the same question.
    """
    if uses_minimal_system_prompt(config):
        return False
    return has_personality_context_block(context_blocks)


def build_context_block_system_messages(
    context_blocks: Any,
    *,
    include_personality: bool = True,
    agent_name: Any = None,
) -> list[dict[str, object]]:
    """Render the typed trusted-context channel as ``system`` rows.

    Counterpart to ``sanitize_semantic_message``: that gate refuses every
    system row riding the UNTRUSTED request history, so Electron's per-turn
    overlays (active file, git, personality, codebase, linked
    session) arrive on ``chat.send params.context_blocks`` instead, already
    kind-checked and byte-bounded by ``normalize_context_blocks``. Rows are
    emitted in the caller's order so callers can place them in the trusted
    leading system run BEFORE any compaction summary. Personality is the one
    user-authored block: it is sanitized and rendered under the single
    ``## Personality`` heading with the name/precedence line the sidecar owns.

    At most ONE personality row is emitted, and it is emitted even when the
    Electron-compiled body sanitizes to nothing, because the name line is
    unconditional. ``has_personality_context_block`` answers the same question
    structurally so the runtime overlay builder can stay silent.
    """
    if not context_blocks:
        return []
    rendered: list[dict[str, object]] = []
    personality_rendered = False
    for block in context_blocks:
        if not isinstance(block, dict):
            continue
        kind = str(block.get("kind") or "").strip()
        content = str(block.get("content") or "").strip()
        if kind == "personality":
            if not include_personality or personality_rendered:
                continue
            personality_rendered = True
            content = build_personality_system_message(agent_name, content)
        if content:
            rendered.append({"role": "system", "content": content})
    return rendered


def semantic_message_rounds(
    messages: list[dict[str, object]],
) -> list[list[dict[str, object]]]:
    """Group model-facing history into complete user turns.

    Tool calls and all sibling results are repaired before this function is
    called, so a user-turn boundary is also a safe protocol boundary.  Leading
    assistant-only persisted history is retained as its own round.
    """
    rounds: list[list[dict[str, object]]] = []
    current: list[dict[str, object]] = []
    for message in messages:
        if message.get("role") == "user" and current:
            rounds.append(current)
            current = []
        current.append(message)
    if current:
        rounds.append(current)
    return rounds


def _sanitize_and_repair(messages: Any) -> list[dict[str, object]]:
    return _sanitize_and_repair_with_rejection_count(messages)[0]


def _sanitize_and_repair_with_rejection_count(
    messages: Any,
) -> tuple[list[dict[str, object]], int]:
    if not isinstance(messages, list):
        return [], 0
    sanitized_messages: list[dict[str, object]] = []
    rejected = 0
    for message in messages:
        sanitized = sanitize_semantic_message(message)
        if sanitized is not None:
            sanitized_messages.append(sanitized)
        else:
            rejected += 1
    return ensure_tool_result_pairing(sanitized_messages), rejected


def _message_bytes(message: dict[str, object]) -> int:
    # The value is only an admission estimate. repr handles malformed persisted
    # non-JSON values without allowing one bad row to bypass the aggregate cap.
    return len(repr(message).encode("utf-8", errors="replace"))


def _split_pinned_summary(
    messages: list[dict[str, object]],
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    """Peel the leading compaction-summary system row(s) off sanitized history.

    The admitted snapshot summary sits at the front of history and would group
    as the OLDEST round, so newest-first retention would evict it first once
    the aggregate ceilings are hit — silently re-losing the compacted context
    on that send and every send after. Pin it ahead of the round walk; it
    still counts against the ceilings.
    """
    boundary = 0
    for message in messages:
        if not _is_compaction_summary_system_message(
            str(message.get("role") or ""), message.get("content")
        ):
            break
        boundary += 1
    return list(messages[:boundary]), list(messages[boundary:])


def _retain_newest_complete_rounds(
    messages: list[dict[str, object]],
    *,
    max_messages: int,
    max_bytes: int = MAX_SEMANTIC_BYTES,
) -> list[dict[str, object]]:
    pinned, remainder = _split_pinned_summary(messages)
    rounds = semantic_message_rounds(remainder)
    kept: list[list[dict[str, object]]] = []
    kept_messages = len(pinned)
    kept_bytes = sum(_message_bytes(message) for message in pinned)
    for round_messages in reversed(rounds):
        round_count = len(round_messages)
        round_bytes = sum(_message_bytes(message) for message in round_messages)
        exceeds = (
            kept_messages + round_count > max_messages
            or kept_bytes + round_bytes > max_bytes
        )
        if exceeds and kept:
            break
        kept.append(round_messages)
        kept_messages += round_count
        kept_bytes += round_bytes
    return pinned + [
        message for round_messages in reversed(kept) for message in round_messages
    ]


def compact_semantic_messages(
    messages: Any,
    *,
    max_messages: int = MAX_SEMANTIC_MESSAGES,
) -> list[dict[str, object]]:
    limit = max(1, min(int(max_messages), MAX_SEMANTIC_MESSAGES))
    return _retain_newest_complete_rounds(
        _sanitize_and_repair(messages),
        max_messages=limit,
    )


def compact_semantic_messages_with_report(
    messages: Any,
    *,
    max_messages: int = MAX_SEMANTIC_MESSAGES,
) -> SemanticAdmissionResult:
    """Apply the aggregate emergency ceiling and report any real narrowing."""
    sanitized, rejected = _sanitize_and_repair_with_rejection_count(messages)
    limit = max(1, min(int(max_messages), MAX_SEMANTIC_MESSAGES))
    retained = _retain_newest_complete_rounds(sanitized, max_messages=limit)
    dropped_messages = rejected + max(0, len(sanitized) - len(retained))
    retained_bytes = sum(_message_bytes(message) for message in retained)
    sanitized_bytes = sum(_message_bytes(message) for message in sanitized)
    return SemanticAdmissionResult(
        messages=retained,
        input_complete=dropped_messages == 0,
        dropped_messages=dropped_messages,
        dropped_bytes=max(0, sanitized_bytes - retained_bytes),
    )


def compact_semantic_messages_with_budget(
    messages: Any,
    *,
    budget: Any | None = None,
    backend: Any | None = None,
    max_messages: int = MAX_SEMANTIC_MESSAGES,
) -> list[dict[str, object]]:
    """Token-aware semantic message compaction.

    When *budget* is provided, truncates by estimated token count
    (newest-first retention) rather than flat message count.  Falls
    back to the original count-based truncation when *budget* is
    ``None``.
    """
    sanitized_messages = _sanitize_and_repair(messages)

    if budget is None:
        limit = max(1, min(int(max_messages), MAX_SEMANTIC_MESSAGES))
        return _retain_newest_complete_rounds(
            sanitized_messages,
            max_messages=limit,
        )

    # Token-aware truncation: keep newest messages that fit.
    from sidecar.ai.context.token_budget import (
        CharEstimationBackend,
        estimate_messages_tokens,
    )

    if backend is None:
        try:
            from sidecar.ai.context.tokenizers import create_tokenizer_backend

            backend = create_tokenizer_backend()
        except Exception:  # noqa: BLE001
            backend = CharEstimationBackend()
    pinned, remainder = _split_pinned_summary(sanitized_messages)
    effective = budget.effective_context(0)
    if effective <= 0:
        rounds = semantic_message_rounds(remainder)
        return pinned + (list(rounds[-1]) if rounds else [])

    # Walk backwards by complete user turn, never by transport row.
    rounds = semantic_message_rounds(remainder)
    kept: list[list[dict[str, object]]] = []
    running_tokens = estimate_messages_tokens(pinned, backend) if pinned else 0
    running_messages = len(pinned)
    running_bytes = sum(_message_bytes(message) for message in pinned)
    limit = max(1, min(int(max_messages), MAX_SEMANTIC_MESSAGES))
    for round_messages in reversed(rounds):
        round_tokens = estimate_messages_tokens(round_messages, backend)
        round_bytes = sum(_message_bytes(message) for message in round_messages)
        exceeds = (
            running_tokens + round_tokens > effective
            or running_messages + len(round_messages) > limit
            or running_bytes + round_bytes > MAX_SEMANTIC_BYTES
        )
        if exceeds and kept:
            break
        kept.append(round_messages)
        running_tokens += round_tokens
        running_messages += len(round_messages)
        running_bytes += round_bytes
    return pinned + [
        message for round_messages in reversed(kept) for message in round_messages
    ]


def strip_thinking_blocks(text: Any) -> str:
    """Remove model-thinking tags from text, including trailing unterminated blocks."""
    value = str(text or "")
    if not value:
        return ""
    return _THINK_TAG_RE.sub("", value)


def strip_thinking_from_all_messages(
    messages: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Strip thinking blocks from every assistant message (for non-thinking fallback models)."""
    result: list[dict[str, object]] = []
    for message in _copy_messages(messages):
        if not _is_assistant_message(message):
            result.append(message)
            continue
        updated = dict(message)
        updated["content"] = strip_thinking_blocks(_content_text(message))
        result.append(updated)
    return ensure_non_empty_assistant_content(filter_whitespace_only_assistant_messages(result))


def _copy_messages(messages: Any) -> list[dict[str, object]]:
    if not isinstance(messages, list):
        return []
    copied: list[dict[str, object]] = []
    for message in messages:
        if isinstance(message, dict):
            copied.append(dict(message))
    return copied


def _is_assistant_message(message: dict[str, object]) -> bool:
    role = str(message.get("role") or "").strip().lower()
    return role == "assistant"


def _has_tool_calls(message: dict[str, object]) -> bool:
    tool_calls = message.get("tool_calls")
    return isinstance(tool_calls, list) and len(tool_calls) > 0


def _content_text(message: dict[str, object]) -> str:
    return str(message.get("content") or "")


def filter_orphaned_thinking_only_messages(
    messages: Any,
) -> list[dict[str, object]]:
    """Drop assistant messages that contain only thinking blocks and no tool calls."""
    filtered: list[dict[str, object]] = []
    for message in _copy_messages(messages):
        if not _is_assistant_message(message):
            filtered.append(message)
            continue
        if _has_tool_calls(message):
            filtered.append(message)
            continue
        content = _content_text(message)
        if content.strip() and not strip_thinking_blocks(content).strip():
            continue
        filtered.append(message)
    return filtered


def filter_trailing_thinking_from_last_assistant(
    messages: Any,
) -> list[dict[str, object]]:
    """Strip thinking blocks from the trailing assistant message in context."""
    normalized = _copy_messages(messages)
    last_assistant_index = -1
    for index, message in enumerate(normalized):
        if _is_assistant_message(message):
            last_assistant_index = index
    if last_assistant_index < 0:
        return normalized
    target = dict(normalized[last_assistant_index])
    target["content"] = strip_thinking_blocks(_content_text(target))
    normalized[last_assistant_index] = target
    return normalized


def filter_whitespace_only_assistant_messages(
    messages: Any,
) -> list[dict[str, object]]:
    """Drop assistant rows that are empty/whitespace and do not carry tool calls."""
    filtered: list[dict[str, object]] = []
    for message in _copy_messages(messages):
        if not _is_assistant_message(message):
            filtered.append(message)
            continue
        if _has_tool_calls(message):
            filtered.append(message)
            continue
        if not _content_text(message).strip():
            continue
        filtered.append(message)
    return filtered


def ensure_non_empty_assistant_content(
    messages: Any,
) -> list[dict[str, object]]:
    """Ensure assistant messages always contain visible content for provider APIs."""
    normalized: list[dict[str, object]] = []
    for message in _copy_messages(messages):
        if not _is_assistant_message(message):
            normalized.append(message)
            continue
        if _content_text(message).strip():
            normalized.append(message)
            continue
        updated = dict(message)
        updated["content"] = EMPTY_ASSISTANT_CONTENT_PLACEHOLDER
        normalized.append(updated)
    return normalized


def normalize_history_for_loop(messages: Any) -> list[dict[str, object]]:
    """Structural history hygiene, applied ONCE at tool-loop entry.

    These three passes drop rows and rewrite content, and two of them are
    position-sensitive: ``filter_trailing_thinking_from_last_assistant`` acts on
    whichever assistant row is currently last. Re-running them per iteration
    against a growing message list therefore strips a *different* row each time,
    which mutates the model-facing prefix mid-turn and breaks prompt-cache
    reuse. Run them once, before the loop appends any tool-call/tool-result
    rows -- at that point the list is only the system run plus seeded semantic
    history, which is exactly what these passes are meant to shape. Loop-appended
    tool-call rows may carry model-authored visible commentary, but never carry
    thinking blocks, so nothing later in the turn needs re-filtering.

    Idempotent, so re-entry on approval resume is a no-op.
    """
    normalized = filter_orphaned_thinking_only_messages(messages)
    normalized = filter_trailing_thinking_from_last_assistant(normalized)
    return filter_whitespace_only_assistant_messages(normalized)


def build_generation_messages(messages: Any) -> list[dict[str, object]]:
    """Return a model-facing COPY of *messages*; never mutates loop state.

    The empty-assistant placeholder backfill is a provider-API presentation
    concern (some providers reject assistant rows with empty content), not a
    fact about the conversation. Writing it back into ``working_messages`` would
    latch fabricated "(no content)" text into live loop state, the approval-plan
    snapshot, and every replayed resume -- so it only ever lands on this copy.
    """
    return ensure_non_empty_assistant_content(messages)


def normalize_messages_for_model(messages: Any) -> list[dict[str, object]]:
    """Run GAP 8 message normalization passes before each model generation step.

    Full pipeline (history hygiene + model-facing backfill) for callers that
    hold a one-shot message list. The tool loop instead splits the two halves
    across its lifecycle -- see ``normalize_history_for_loop`` and
    ``build_generation_messages``.
    """
    return build_generation_messages(normalize_history_for_loop(messages))
