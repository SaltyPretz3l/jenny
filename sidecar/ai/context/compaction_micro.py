"""Microcompaction and the row 60 compaction policy.

Microcompaction stubs old tool output in place, without an LLM call. It is the
fallback after a failed full summary and, with ``compaction_micro_first``, the
first step: the summary then runs only when stubbing cannot reach ``MICRO_TARGET``.

``compaction_policy(feature_flags)`` is ``None`` when all three row 60 flags are
OFF, so ``compact_context(policy=None)`` stays byte-identical to the summary-first
ladder. The touched-files list is derived from the messages being compacted
(successful mutating tool calls plus the list a prior summary row carried), never
from the model's summary.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from sidecar.ai.context.compaction_window import (
    _TOOL_PLACEHOLDER,
    _copy_message_for_compaction,
    _estimate_message_tokens,
    _index_tool_calls,
    _strip_matching_tool_call_arguments,
    _tool_call_name,
)
from sidecar.ai.context.token_budget import CharEstimationBackend, TokenBudget, TokenizerBackend
from sidecar.ai.feature_flags import (
    FEATURE_COMPACTION_MICRO_FIRST,
    FEATURE_COMPACTION_RECALL_TOOL,
    FEATURE_COMPACTION_TOUCHED_FILES,
    is_default_on_flag_enabled,
)

MICRO_TARGET = 2 / 3  # fallback lands under the tool-loop trigger, not at it (HB-028)
MICRO_FIRST_CODE = "micro_first"
# Preserve the most recent N messages from stripping so the model has
# immediate context to work with.
_MICRO_PRESERVE_TAIL = 6
_LONG_ASSISTANT_CONTENT_CHARS = 100
_PLACEHOLDER_PREFIX = _TOOL_PLACEHOLDER[:-1]


@dataclass(frozen=True)
class MicrocompactionResult:
    messages: list[dict[str, Any]]
    messages_stripped: int
    tokens_freed: int


def tool_placeholder(tool_call_id: str, *, recall_hint: bool) -> str:
    """The stub for one tool result; with the hint it names the recall call."""
    if not recall_hint or not tool_call_id:
        return _TOOL_PLACEHOLDER
    return f'{_PLACEHOLDER_PREFIX}; recall_tool_output("{tool_call_id}")]'


def is_tool_placeholder(content: str) -> bool:
    return content == _TOOL_PLACEHOLDER or (
        content.startswith(_PLACEHOLDER_PREFIX) and content.endswith('")]')
    )


def micro_first_accepts(tokens_before: int, tokens_after: int, threshold: int) -> bool:
    """Stubbing alone is enough when it freed tokens and reached the usual target."""
    return tokens_after < tokens_before and tokens_after <= int(threshold * MICRO_TARGET)


def microcompact(  # noqa: PLR0913  # keyword-only policy knobs
    messages: list[dict[str, Any]],
    budget: TokenBudget,
    backend: TokenizerBackend | None = None,
    *,
    num_tools: int = 0,
    target_fraction: float = 1.0,
    recall_hint: bool = False,
    keep_argument_keys: frozenset[str] = frozenset(),
) -> MicrocompactionResult:
    """Strip old tool-result content without an LLM call.

    Walks messages oldest-first, replacing tool-result content with a
    placeholder until the estimated token count drops below
    ``target_fraction`` of the auto-compact threshold.  The most recent
    ``_MICRO_PRESERVE_TAIL`` messages are never touched.
    """
    if backend is None:
        backend = CharEstimationBackend()

    threshold = int(budget.auto_compact_threshold(num_tools) * target_fraction)
    message_token_counts = [
        _estimate_message_tokens(message, backend) for message in messages
    ]
    tokens_before = sum(message_token_counts)
    tokens_remaining = tokens_before
    if tokens_before <= threshold:
        return MicrocompactionResult(
            messages=list(messages),
            messages_stripped=0,
            tokens_freed=0,
        )

    result: list[dict[str, Any]] = [_copy_message_for_compaction(m) for m in messages]
    stripped = 0
    safe_end = max(0, len(result) - _MICRO_PRESERVE_TAIL)
    call_index = _index_tool_calls(result, stop_index=safe_end)

    for i in range(safe_end):
        msg = result[i]
        role = str(msg.get("role", "")).lower()
        changed_indices: set[int] = set()

        if role == "tool":
            old_content = str(msg.get("content", ""))
            stubbed = old_content == _TOOL_PLACEHOLDER or (
                recall_hint and is_tool_placeholder(old_content)
            )
            if old_content and not stubbed:
                tool_call_id = str(msg.get("tool_call_id") or "")
                msg["content"] = tool_placeholder(tool_call_id, recall_hint=recall_hint)
                changed_indices.add(i)
                changed_indices.update(
                    _strip_matching_tool_call_arguments(
                        result,
                        tool_call_id,
                        call_index=call_index,
                        stop_index=safe_end,
                        keep_keys=keep_argument_keys,
                    )
                )
                stripped += 1
        elif role == "assistant" and isinstance(msg.get("tool_calls"), list):
            old_content = str(msg.get("content", ""))
            if old_content and len(old_content) > _LONG_ASSISTANT_CONTENT_CHARS:
                call_names = [
                    _tool_call_name(c)
                    for c in msg.get("tool_calls", [])
                    if isinstance(c, dict)
                ]
                # Bracketed metadata, not first-person prose: a plain
                # "Calling tool(s): ..." sentence here reads as
                # assistant-authored narration and local models learn to
                # imitate it verbatim in real replies.
                msg["content"] = (
                    f"[compacted: invoked tools {', '.join(call_names) or 'tool'}]"
                )
                changed_indices.add(i)
                stripped += 1

        for changed_index in sorted(changed_indices):
            previous_count = message_token_counts[changed_index]
            updated_count = _estimate_message_tokens(
                result[changed_index],
                backend,
            )
            message_token_counts[changed_index] = updated_count
            tokens_remaining += updated_count - previous_count
        if tokens_remaining <= threshold:
            break

    tokens_after = tokens_remaining
    return MicrocompactionResult(
        messages=result,
        messages_stripped=stripped,
        tokens_freed=max(0, tokens_before - tokens_after),
    )


TOUCHED_FILES_HEADING = "## Files touched this session"
MAX_TOUCHED_FILES = 40
DEFAULT_MAX_MICRO_PASSES = 3
# Scalar path arguments a stubbed call keeps, so a micro pass does not erase which files it touched.
PATH_ARGUMENT_KEYS = frozenset({"path", "file_path", "source", "destination", "moves"})
_MUTATING_TOOLS = frozenset({"write_file", "edit_file", "delete_file", "move_file"})


@dataclass(frozen=True)
class CompactionPolicy:
    micro_first: bool = False
    recall_hint: bool = False
    touched_files: bool = False
    max_micro_passes: int = DEFAULT_MAX_MICRO_PASSES

    @property
    def keep_argument_keys(self) -> frozenset[str]:
        return PATH_ARGUMENT_KEYS if self.touched_files else frozenset()


def compaction_policy(feature_flags: Mapping[str, Any] | None) -> CompactionPolicy | None:
    policy = CompactionPolicy(
        micro_first=is_default_on_flag_enabled(feature_flags, FEATURE_COMPACTION_MICRO_FIRST),
        recall_hint=is_default_on_flag_enabled(feature_flags, FEATURE_COMPACTION_RECALL_TOOL),
        touched_files=is_default_on_flag_enabled(feature_flags, FEATURE_COMPACTION_TOUCHED_FILES),
    )
    if not (policy.micro_first or policy.recall_hint or policy.touched_files):
        return None
    return policy


def _call_arguments(call: dict[str, Any]) -> dict[str, Any]:
    function = call.get("function")
    raw = function.get("arguments") if isinstance(function, dict) else call.get("arguments")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return {}
    return raw if isinstance(raw, dict) else {}


def _call_paths(call: dict[str, Any]) -> list[str]:
    if _tool_call_name(call) not in _MUTATING_TOOLS:
        return []
    arguments = _call_arguments(call)
    paths = [arguments.get(key) for key in ("path", "file_path", "source", "destination")]
    for move in arguments.get("moves") or ():
        if isinstance(move, dict):
            paths.extend((move.get("source"), move.get("destination")))
    return [path.strip() for path in paths if isinstance(path, str) and path.strip()]


def _carried_paths(content: str) -> list[str]:
    _, found, block = content.rpartition(f"\n{TOUCHED_FILES_HEADING}\n")
    if not found:
        return []
    paths = (line[2:].strip() for line in block.splitlines() if line.startswith("- "))
    return [path for path in paths if path]


def collect_touched_files(messages: list[dict[str, Any]]) -> list[str]:
    """Paths of successful write/edit/move/delete calls, oldest first, latest MAX_TOUCHED_FILES."""
    results = [row for row in messages if str(row.get("role", "")).lower() == "tool"]
    failed = {str(row.get("tool_call_id") or "") for row in results if row.get("is_error") is True}
    answered = {str(row.get("tool_call_id") or "") for row in results}
    ordered: list[str] = []
    for row in messages:
        role = str(row.get("role", "")).lower()
        if role == "system":
            ordered.extend(_carried_paths(str(row.get("content") or "")))
            continue
        if role != "assistant" or not isinstance(row.get("tool_calls"), list):
            continue
        for call in row["tool_calls"]:
            if not isinstance(call, dict):
                continue
            call_id = str(call.get("id") or call.get("call_id") or call.get("tool_call_id") or "")
            if call_id in answered and call_id not in failed:
                ordered.extend(_call_paths(call))
    latest = list(dict.fromkeys(reversed(ordered)))[:MAX_TOUCHED_FILES]
    return list(reversed(latest))


def touched_files_block(paths: list[str]) -> str:
    """The derived block appended to a summary row; empty when nothing was touched."""
    if not paths:
        return ""
    lines = "\n".join(f"- {path}" for path in paths)
    return f"\n\n{TOUCHED_FILES_HEADING}\n{lines}"
