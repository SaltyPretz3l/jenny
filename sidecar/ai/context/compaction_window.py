"""Shared compaction primitives and (later) the mid-turn summarisation window."""

from dataclasses import dataclass
from typing import Any

from sidecar.ai.context.token_budget import (
    TokenBudget,
    TokenizerBackend,
    estimate_messages_tokens,
)

_TOOL_PLACEHOLDER = "[tool output omitted for context space]"
_SUMMARY_INPUT_SAFETY_TOKENS = 512
MID_TURN_PRESERVE_MESSAGES = 6
MID_TURN_TASK_PIN_MAX_TOKENS = 2000
MID_TURN_TAIL_MAX_RATIO = 0.25
MID_TURN_NUDGE_PREFIX = "[Context compacted mid-task]"
MID_TURN_NUDGE = (
    f"{MID_TURN_NUDGE_PREFIX} Continue from the Next Step in the summary above; "
    "do not redo completed steps or ask the user to repeat the request."
)
# Pinned in place of an oversized task prompt; Electron persists the same anchor.
MID_TURN_TASK_STUB = "[Original request summarized above]"


def _row_role(row: dict[str, Any]) -> str:
    return str(row.get("role") or "").strip().lower()


def is_mid_turn_nudge_content(content: Any) -> bool:
    return str(content or "").strip() == MID_TURN_NUDGE


def is_mid_turn_nudge_row(row: dict[str, Any]) -> bool:
    """Only the system row compaction itself appended counts as a nudge.

    A tool/user/assistant row that merely quotes the nudge text is history;
    dropping it would orphan its tool call.
    """
    return _row_role(row) == "system" and is_mid_turn_nudge_content(row.get("content"))


def _find_task_index(rows: list[dict[str, Any]], task_content: str | None) -> int | None:
    """Locate the turn's own prompt.

    The loop appends ``user`` rows mid-turn (tool-call retry correctives,
    tool-use and recovery nudges), so "last user row" is not the task. Prefer
    the newest user row whose content equals the turn's prompt (or the task
    stub pinned by an earlier pass); fall back to the last user row when no
    prompt is known.
    """
    user_indexes = [
        index for index in range(len(rows) - 1, -1, -1) if _row_role(rows[index]) == "user"
    ]
    if not user_indexes:
        return None
    wanted = str(task_content).strip() if task_content is not None else ""
    for index in user_indexes:
        content = rows[index].get("content")
        if not isinstance(content, str):
            continue
        text = content.strip()
        if text == MID_TURN_TASK_STUB or (wanted and text == wanted):
            return index
    return user_indexes[0]


@dataclass(frozen=True)
class SummaryInputAdmission:
    messages: list[dict[str, Any]]
    truncated: bool
    stripped_messages: int
    dropped_messages: int


@dataclass(frozen=True)
class MidTurnWindow:
    applicable: bool
    task_message: dict[str, Any] | None
    summary_source: list[dict[str, Any]]
    tail: list[dict[str, Any]]
    covered_through_tool_call_id: str | None


def _empty_mid_turn_window() -> MidTurnWindow:
    return MidTurnWindow(
        applicable=False,
        task_message=None,
        summary_source=[],
        tail=[],
        covered_through_tool_call_id=None,
    )


def split_mid_turn_window(
    conversation: list[dict[str, Any]],
    budget: TokenBudget,
    backend: TokenizerBackend,
    *,
    num_tools: int,
    task_content: str | None = None,
) -> MidTurnWindow:
    rows = [row for row in conversation if not is_mid_turn_nudge_row(row)]
    task_index = _find_task_index(rows, task_content)
    if task_index is None:
        return _empty_mid_turn_window()

    pair_starts = [
        index
        for index in range(task_index + 1, len(rows))
        if _row_role(rows[index]) != "tool"
    ]
    if not pair_starts:
        return _empty_mid_turn_window()

    preserve_boundary = max(
        task_index + 1,
        len(rows) - MID_TURN_PRESERVE_MESSAGES,
    )
    eligible_starts = [index for index in pair_starts if index <= preserve_boundary]
    tail_start = eligible_starts[-1] if eligible_starts else pair_starts[0]
    pair_start_position = pair_starts.index(tail_start)
    cap = int(budget.effective_context(num_tools) * MID_TURN_TAIL_MAX_RATIO)
    while (
        estimate_messages_tokens(rows[tail_start:], backend) > cap
        and pair_start_position < len(pair_starts) - 1
    ):
        pair_start_position += 1
        tail_start = pair_starts[pair_start_position]

    summary_source = rows[:tail_start]
    if len(summary_source) < 2:
        return _empty_mid_turn_window()
    tail = rows[tail_start:]
    covered_through_tool_call_id: str | None = None
    for index, row in enumerate(summary_source):
        if index <= task_index or _row_role(row) != "tool":
            continue
        tool_call_id = str(row.get("tool_call_id") or "").strip()
        if tool_call_id:
            covered_through_tool_call_id = tool_call_id

    return MidTurnWindow(
        applicable=True,
        task_message=rows[task_index],
        summary_source=summary_source,
        tail=tail,
        covered_through_tool_call_id=covered_through_tool_call_id,
    )


def _copy_tool_call_for_compaction(call: Any) -> Any:
    if not isinstance(call, dict):
        return call
    copied_call = dict(call)
    function = copied_call.get("function")
    if isinstance(function, dict):
        copied_call["function"] = dict(function)
    return copied_call


def _copy_message_for_compaction(message: dict[str, Any]) -> dict[str, Any]:
    copied = dict(message)
    tool_calls = copied.get("tool_calls")
    if isinstance(tool_calls, list):
        copied["tool_calls"] = [_copy_tool_call_for_compaction(call) for call in tool_calls]
    return copied


def _tool_call_name(call: dict[str, Any]) -> str:
    name = call.get("name")
    if isinstance(name, str) and name.strip():
        return name.strip()
    function = call.get("function")
    if isinstance(function, dict):
        function_name = function.get("name")
        if isinstance(function_name, str) and function_name.strip():
            return function_name.strip()
    return "tool"


def _strip_matching_tool_call_arguments(
    messages: list[dict[str, Any]],
    tool_call_id: str,
    *,
    call_index: dict[str, list[tuple[int, int]]],
    stop_index: int | None = None,
) -> set[int]:
    if not tool_call_id:
        return set()
    limit = len(messages) if stop_index is None else max(0, min(stop_index, len(messages)))
    changed_indices: set[int] = set()
    for message_index, call_position in call_index.get(tool_call_id, ()):
        if message_index >= limit:
            continue
        message = messages[message_index]
        if str(message.get("role", "")).lower() != "assistant":
            continue
        tool_calls = message.get("tool_calls")
        if not isinstance(tool_calls, list) or call_position >= len(tool_calls):
            continue
        call = tool_calls[call_position]
        if not isinstance(call, dict):
            continue
        call_id = str(
            call.get("id") or call.get("call_id") or call.get("tool_call_id") or ""
        )
        if call_id != tool_call_id:
            continue
        call["arguments"] = {"compacted": True}
        function = call.get("function")
        if isinstance(function, dict):
            function["arguments"] = {"compacted": True}
        changed_indices.add(message_index)
    return changed_indices


def _index_tool_calls(
    messages: list[dict[str, Any]],
    *,
    stop_index: int,
) -> dict[str, list[tuple[int, int]]]:
    call_index: dict[str, list[tuple[int, int]]] = {}
    for message_index in range(max(0, min(stop_index, len(messages)))):
        message = messages[message_index]
        if str(message.get("role", "")).lower() != "assistant":
            continue
        tool_calls = message.get("tool_calls")
        if not isinstance(tool_calls, list):
            continue
        for call_position, call in enumerate(tool_calls):
            if not isinstance(call, dict):
                continue
            call_id = str(
                call.get("id") or call.get("call_id") or call.get("tool_call_id") or ""
            )
            if call_id:
                call_index.setdefault(call_id, []).append((message_index, call_position))
    return call_index


def _estimate_message_tokens(
    message: dict[str, Any],
    backend: TokenizerBackend,
) -> int:
    return estimate_messages_tokens((message,), backend)


def summary_input_limit(budget: TokenBudget, *, prompt_tokens: int) -> int:
    """Return the token limit for conversation rows sent to the summariser."""
    floor = max(1, budget.context_window // 4)
    available = (
        budget.context_window
        - budget.reserved_for_summary
        - prompt_tokens
        - _SUMMARY_INPUT_SAFETY_TOKENS
    )
    return max(floor, available)


def admit_summary_source(
    messages: list[dict[str, Any]],
    budget: TokenBudget,
    backend: TokenizerBackend,
    *,
    prompt_tokens: int,
) -> SummaryInputAdmission:
    """Admit summariser input by stripping tools, then dropping oldest rows."""
    limit = summary_input_limit(budget, prompt_tokens=prompt_tokens)
    message_token_counts = [
        _estimate_message_tokens(message, backend) for message in messages
    ]
    tokens_remaining = sum(message_token_counts)
    if tokens_remaining <= limit:
        return SummaryInputAdmission(
            messages=messages,
            truncated=False,
            stripped_messages=0,
            dropped_messages=0,
        )

    rows = [_copy_message_for_compaction(message) for message in messages]
    call_index = _index_tool_calls(rows, stop_index=len(rows))
    stripped = 0
    for index, message in enumerate(rows):
        if str(message.get("role", "")).lower() != "tool":
            continue
        old_content = str(message.get("content", ""))
        if not old_content or old_content == _TOOL_PLACEHOLDER:
            continue

        message["content"] = _TOOL_PLACEHOLDER
        changed_indices = {index}
        changed_indices.update(
            _strip_matching_tool_call_arguments(
                rows,
                str(message.get("tool_call_id") or ""),
                call_index=call_index,
                stop_index=len(rows),
            )
        )
        stripped += 1
        for changed_index in sorted(changed_indices):
            previous_count = message_token_counts[changed_index]
            updated_count = _estimate_message_tokens(rows[changed_index], backend)
            message_token_counts[changed_index] = updated_count
            tokens_remaining += updated_count - previous_count
        if tokens_remaining <= limit:
            return SummaryInputAdmission(
                messages=rows,
                truncated=True,
                stripped_messages=stripped,
                dropped_messages=0,
            )

    dropped = 0
    marker: dict[str, Any] | None = None
    while len(rows) - dropped > 1:
        tokens_remaining -= message_token_counts[dropped]
        dropped += 1
        marker = {
            "role": "system",
            "content": (
                f"[{dropped} earlier messages omitted from this summary input]"
            ),
        }
        if tokens_remaining + _estimate_message_tokens(marker, backend) <= limit:
            break

    admitted_messages = rows[dropped:]
    if marker is not None:
        admitted_messages = [marker, *admitted_messages]
    return SummaryInputAdmission(
        messages=admitted_messages,
        truncated=True,
        stripped_messages=stripped,
        dropped_messages=dropped,
    )
