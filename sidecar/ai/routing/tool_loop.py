"""Extracted tool-loop orchestrator.

Owns the iteration loop that was previously inline in
``AgentKernel.build_chat_decision()``.  This module is an orchestrator
only -- scheduling, stop policies, and message preparation live in
helpers (``loop_events``, ``loop_stop``, ``loop_runtime``).
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import replace
from typing import Any, Callable

# NOTE: many symbols below are load-bearing *hub attributes* -- the carved-out
# sibling modules (tool_loop_run/tool_loop_calls/tool_loop_finalize) reach them
# via ``import sidecar.ai.routing.tool_loop as _tl_hub`` + ``_tl_hub.NAME`` to
# stay within the per-module import-fanout budget. Those have zero call sites in
# this file and carry a per-import noqa (F401) so ruff keeps them; do not remove.
from sidecar.ai.config import resolve_effective_max_tokens  # noqa: F401
from sidecar.ai.context.builder import looks_like_current_info_request
from sidecar.ai.context.messages import (
    build_generation_messages,  # noqa: F401
    normalize_history_for_loop,  # noqa: F401
    normalize_messages_for_model,  # noqa: F401
)
from sidecar.ai.context.token_budget import (
    BudgetTracker,
    estimate_messages_tokens,  # noqa: F401
)
from sidecar.ai.error_codes import (
    CMP_LOOP_ENGINE_STALLED,  # noqa: F401
    CMP_LOOP_INVALID_TOOL_CALL,
    CMP_LOOP_TOOL_INTERRUPTED,  # noqa: F401
)
from sidecar.ai.feature_flags import (
    FEATURE_PHASE_EVENTS,  # noqa: F401
    is_feature_flag_enabled,  # noqa: F401
    is_resource_discipline_enabled,  # noqa: F401
)
from sidecar.ai.routing import (  # noqa: F401
    loop_event_emit,
    tool_loop_compaction,
    tool_loop_recovery,
)
from sidecar.ai.routing.auto_checkpoint import maybe_create_auto_checkpoint  # noqa: F401
from sidecar.ai.routing.loop_events import (
    IterationStartEvent,  # noqa: F401
    TokenDeltaEvent,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.loop_stop import (
    CYCLE_HISTORY_DEPTH,  # noqa: F401
    LoopState,  # noqa: F401
    StopController,  # noqa: F401
    StopDecision,  # noqa: F401
    StopReason,
    _tool_call_signature,  # noqa: F401
)
from sidecar.ai.routing.route_policy_runtime import (
    apply_route_policy_pre_dispatch,  # noqa: F401
)
from sidecar.ai.routing.tool_budget_filter import count_full_tool_schemas  # noqa: F401
from sidecar.ai.routing.tool_call_canonicalization import (
    canonicalize_tool_call_arguments,  # noqa: F401
    canonicalize_tool_calls,  # noqa: F401
    repair_web_search_query_arguments,  # noqa: F401
    validate_provider_tool_call_limits,  # noqa: F401
)
from sidecar.ai.routing.tool_loop_run import _ToolLoopRun
from sidecar.ai.routing.tool_observation import (
    KIND_MODEL_TOOL_REQUESTED,  # noqa: F401
    KIND_TURN_COMPLETED,  # noqa: F401
    KIND_TURN_FAILED,  # noqa: F401
    KIND_USER_APPROVAL_REQUESTED,  # noqa: F401
)
from sidecar.ai.tools.assembly import current_info_remediation
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import GenerationUsage, ToolCallRequest
from sidecar.ai.tools.policy import tool_policy_call_key
from sidecar.ai.tools.sanitization import sanitize_assistant_output
from sidecar.ai.utils.coercion import coerce_positive_finite_float
from sidecar.protocol import (
    CHAT_THINKING_KIND_REASONING,  # noqa: F401
    CHAT_THINKING_KIND_STATUS,
)
from sidecar.runtime.approval_plan import (
    build_approval_plan as _build_approval_plan,
)
from sidecar.runtime.approval_plan import (
    build_message_history_hash,  # noqa: F401
)
from sidecar.runtime.chat_helpers import tokenize_with_whitespace
from sidecar.runtime.chat_models import TerminalChatStateError  # noqa: F401
from sidecar.runtime.diagnostics import log_event  # noqa: F401
from sidecar.runtime.local_engine.request_context import current_diagnostics_store

logger = logging.getLogger(__name__)
_SYNTHETIC_TOOL_IDS = frozenset({"tool_search"})
_UNKNOWN_TOOL_LOG_PREVIEW_LIMIT = 20
_TOOL_BURST_SUMMARY_THRESHOLD = 4
_TOOL_BURST_CALL_ID_PREVIEW_LIMIT = 8


def build_approval_plan(**kwargs: Any) -> Any:
    from sidecar.ai.routing.mutation_change_set_lifecycle import (  # noqa: PLC0415
        current_run_change_set_id,
    )

    return _build_approval_plan(change_set_id=current_run_change_set_id(), **kwargs)


def _is_unknown_tool_call(
    kernel: Any,
    call: ToolCallRequest,
    *,
    tool_resolution_context: Any | None,
    tool_contract: Any | None,
    request_disabled_tools: frozenset[str],
) -> str | None:
    try:
        kernel._assert_valid_tool_call(call)
    except ToolExecutionFailure as exc:
        if exc.code == CMP_LOOP_INVALID_TOOL_CALL:
            return exc.message
        raise

    if call.tool_id in _SYNTHETIC_TOOL_IDS:
        return None
    if call.tool_id in request_disabled_tools:
        return None
    if kernel._is_direct_deferred_tool_call(call, tool_resolution_context):
        return None
    entry = tool_contract.entry(call.tool_id) if tool_contract is not None else None
    if entry is not None:
        return None
    descriptor = kernel._mcp_client.tool_descriptor(call.tool_id)
    if descriptor is not None:
        return None
    if call.tool_id == "run_command" and not kernel._config.tools_shell_enabled:
        return None
    return f"model requested unknown tool '{call.tool_id}'"


def _partition_unknown_tool_calls(
    kernel: Any,
    tool_calls: tuple[ToolCallRequest, ...],
    *,
    tool_resolution_context: Any | None,
    tool_contract: Any | None,
    request_disabled_tools: frozenset[str],
) -> tuple[tuple[ToolCallRequest, ...], tuple[tuple[ToolCallRequest, str], ...]]:
    valid_calls: list[ToolCallRequest] = []
    unknown_calls: list[tuple[ToolCallRequest, str]] = []
    for call in tool_calls:
        message = _is_unknown_tool_call(
            kernel,
            call,
            tool_resolution_context=tool_resolution_context,
            tool_contract=tool_contract,
            request_disabled_tools=request_disabled_tools,
        )
        if message:
            unknown_calls.append((call, message))
        else:
            valid_calls.append(call)
    return tuple(valid_calls), tuple(unknown_calls)


def _available_tool_names(tool_contract: Any | None) -> tuple[str, ...]:
    if tool_contract is None:
        return ()
    names: set[str] = set()
    for entry in getattr(tool_contract, "entries", ()) or ():
        descriptor = getattr(entry, "descriptor", None)
        name = str(getattr(descriptor, "name", "") or "").strip()
        if name and getattr(entry, "available", False):
            names.add(name)
    return tuple(sorted(names))


def _invalid_tool_output(message: str, tool_contract: Any | None = None) -> str:
    # Name the valid tools inline: small local models hallucinate near-miss
    # tool names (write_to_file for write_file) and will not re-derive the
    # right one from the system prompt's tool block — without the list here
    # they conclude the capability is missing and tell the user so.
    base = (
        f"Error: {message}. Please check the available tools and try again "
        "with a valid tool name."
    )
    names = _available_tool_names(tool_contract)
    if not names:
        return base
    return f"{base} Available tools: {', '.join(names)}."


def _visible_tool_input(call: ToolCallRequest) -> dict[str, Any]:
    return (
        {str(k): v for k, v in call.arguments.items()}
        if isinstance(call.arguments, dict)
        else {}
    )


def _tool_id_log_preview(
    calls: tuple[ToolCallRequest, ...] | tuple[tuple[ToolCallRequest, str], ...],
) -> tuple[list[str], int]:
    preview: list[str] = []
    for item in calls[:_UNKNOWN_TOOL_LOG_PREVIEW_LIMIT]:
        call = item[0] if isinstance(item, tuple) else item
        preview.append(str(call.tool_id))
    omitted = max(0, len(calls) - _UNKNOWN_TOOL_LOG_PREVIEW_LIMIT)
    return preview, omitted


def _call_id_preview(calls: list[ToolCallRequest]) -> tuple[list[str], int]:
    preview = [
        str(call.call_id or "").strip()
        for call in calls[:_TOOL_BURST_CALL_ID_PREVIEW_LIMIT]
        if str(call.call_id or "").strip()
    ]
    omitted = max(0, len(calls) - _TOOL_BURST_CALL_ID_PREVIEW_LIMIT)
    return preview, omitted


def _quota_burst_key(blocked_call: Any) -> tuple[str, str]:
    metadata = dict(getattr(blocked_call, "metadata", {}) or {})
    quota_scope = str(metadata.get("quota_scope") or blocked_call.reason or "").strip()
    return (str(blocked_call.call.tool_id or "").strip(), quota_scope)


def _quota_blocked_groups(blocked_calls: tuple[Any, ...]) -> list[list[Any]]:
    groups: list[list[Any]] = []
    for blocked in blocked_calls:
        if not groups or _quota_burst_key(groups[-1][-1]) != _quota_burst_key(blocked):
            groups.append([blocked])
            continue
        groups[-1].append(blocked)
    return groups


def _policy_denied_matched_rule_ids(denied_calls: tuple[Any, ...]) -> list[str]:
    matched_rule_ids: set[str] = set()
    for denied in denied_calls:
        policy_metadata = dict(denied.metadata.get("policy_decision") or {})
        matched_rule_id = str(policy_metadata.get("matched_rule_id") or "").strip()
        if matched_rule_id:
            matched_rule_ids.add(matched_rule_id)
    return sorted(matched_rule_ids)


def _bind_missing_approval_call_id(
    tool_calls: tuple[ToolCallRequest, ...],
    approval_call_id: str | None,
) -> tuple[ToolCallRequest, ...]:
    normalized_approval_id = str(approval_call_id or "").strip()
    if not normalized_approval_id:
        return tool_calls

    bound = any(
        str(call.call_id or "").strip() == normalized_approval_id for call in tool_calls
    )
    if bound:
        return tool_calls

    rebound_calls: list[ToolCallRequest] = []
    for call in tool_calls:
        if not bound and not str(call.call_id or "").strip():
            if tool_policy_call_key(call) == normalized_approval_id:
                rebound_calls.append(replace(call, call_id=normalized_approval_id))
                bound = True
                continue
        rebound_calls.append(call)
    return tuple(rebound_calls)


# ---------------------------------------------------------------------------
# Result container
# ---------------------------------------------------------------------------


class ToolLoopResult:
    """Outcome of ``run_tool_loop()`` -- a thin carrier, not a dataclass,
    so the caller (``AgentKernel``) can still build ``ChatDecision``
    with its helper.
    """

    __slots__ = (
        "thinking_text",
        "thinking_kind",
        "persist_thinking",
        "response_text",
        "approval_request",
        "outcomes",
        "usage_totals",
        "streamed_event_types",
        "approval_plan",
        "completion_source",
        "resumable_stop",
        "terminal_error_code",
        "terminal_subcode",
        "terminal_error_retryable",
    )

    def __init__(
        self,
        *,
        thinking_text: str | None,
        thinking_kind: str,
        persist_thinking: bool,
        response_text: str,
        approval_request: Any | None,
        approval_plan: Any | None,
        outcomes: list[Any],
        usage_totals: GenerationUsage | None,
        streamed_event_types: set[str],
        completion_source: str = "model",
        resumable_stop: str | None = None,
        terminal_error_code: str | None = None,
        terminal_subcode: str | None = None,
        terminal_error_retryable: bool = False,
    ) -> None:
        self.thinking_text = thinking_text
        self.thinking_kind = thinking_kind
        self.persist_thinking = persist_thinking
        self.response_text = response_text
        self.approval_request = approval_request
        self.approval_plan = approval_plan
        self.outcomes = outcomes
        self.usage_totals = usage_totals
        self.streamed_event_types = streamed_event_types
        self.completion_source = str(completion_source or "model")
        self.resumable_stop = str(resumable_stop or "").strip() or None
        self.terminal_error_code = str(terminal_error_code or "").strip() or None
        self.terminal_subcode = str(terminal_subcode or "").strip() or None
        self.terminal_error_retryable = bool(terminal_error_retryable)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

MAX_RESPONSE_CHARS = 16_000
TOOL_NUDGE_FALLBACK_RESPONSE = (
    "I wasn't able to complete that request because the model kept "
    "describing tool use instead of actually calling the tool. "
    "Please try again."
)
_GENERIC_GREETING_RE = re.compile(
    r"^\s*(hey|hi|hello|hiya|howdy)\b.{0,160}\b("
    r"i(?:['\u2019]m| am)\s+jenny|nice to meet you|how(?:['\u2019]s| is) your day|"
    r"how are you|good to see you"
    r")",
    re.IGNORECASE | re.DOTALL,
)
_POST_TOOL_READY_RESET_RE = re.compile(
    r"^\s*(?:i(?:['\u2019]m| am)\s+)?ready\s+to\s+help\b"
    r".{0,160}\bwhat(?:['\u2019]s| is)\s+on\s+your\s+mind\??\s*$",
    re.IGNORECASE | re.DOTALL,
)
_EMPTY_CHAT_MENU_RE = re.compile(
    r"\bhow can i help you today\?"
    r".{0,600}\bif you(?:['\u2019]re| are) not sure where to start\b"
    r".{0,600}\bjust let me know what(?:['\u2019]s| is) on your mind\b",
    re.IGNORECASE | re.DOTALL,
)
_POST_TOOL_CONTINUATION_NUDGE = (
    "Continue the user's current request using the tool results you just received. "
    "Do not greet the user or restart the conversation. Produce the requested deliverable."
)
_TOOL_FAILURE_CONTEXT_NUDGE = (
    "Tool failure context: one or more tool calls failed. Treat the failed tool result "
    "messages as authoritative context. Do not claim that no context or no tool results "
    "were provided; explain the failure plainly and avoid fabricating successful tool output."
)
_NO_CONTEXT_AFTER_TOOL_RE = re.compile(
    r"\b("
    r"no\s+(?:previous\s+)?context|"
    r"(?:do\s+not|don't|cannot|can't)\s+have\s+(?:any\s+)?(?:previous\s+)?context|"
    r"no\s+tool\s+results?"
    r")\b",
    re.IGNORECASE,
)


def _merge_generation_usage(
    current: GenerationUsage | None,
    next_usage: GenerationUsage | None,
) -> GenerationUsage | None:
    if next_usage is None:
        return current
    if current is None:
        return next_usage
    # last_request_input_tokens is OVERWRITE-not-add: the merged record keeps
    # the latest iteration's request size (falling back to that iteration's
    # input_tokens) so the context meter reads "current request", not the
    # cross-iteration sum that input_tokens/total_tokens accumulate.
    next_last_request = max(int(next_usage.last_request_input_tokens), 0) or max(
        int(next_usage.input_tokens), 0
    )
    return GenerationUsage(
        input_tokens=max(int(current.input_tokens), 0) + max(int(next_usage.input_tokens), 0),
        output_tokens=max(int(current.output_tokens), 0) + max(int(next_usage.output_tokens), 0),
        total_tokens=max(int(current.total_tokens), 0) + max(int(next_usage.total_tokens), 0),
        provider=str(next_usage.provider or current.provider),
        model=str(next_usage.model or current.model),
        provider_cost_usd=_merge_provider_cost(
            current.provider_cost_usd,
            next_usage.provider_cost_usd,
        ),
        raw_usage=dict(next_usage.raw_usage or current.raw_usage),
        last_request_input_tokens=(
            next_last_request or max(int(current.last_request_input_tokens), 0)
        ),
        generation_tokens=(
            max(int(current.generation_tokens), 0)
            + max(int(next_usage.generation_tokens), 0)
        ),
        generation_duration_ms=(
            coerce_positive_finite_float(current.generation_duration_ms)
            + coerce_positive_finite_float(next_usage.generation_duration_ms)
        ),
        prompt_eval_duration_ms=(
            coerce_positive_finite_float(current.prompt_eval_duration_ms)
            + coerce_positive_finite_float(next_usage.prompt_eval_duration_ms)
        ),
        load_duration_ms=(
            coerce_positive_finite_float(current.load_duration_ms)
            + coerce_positive_finite_float(next_usage.load_duration_ms)
        ),
        time_to_first_token_ms=(
            coerce_positive_finite_float(current.time_to_first_token_ms)
            or coerce_positive_finite_float(next_usage.time_to_first_token_ms)
        ),
    )


def _merge_provider_cost(current: object, next_cost: object) -> float | None:
    if isinstance(current, bool) or isinstance(next_cost, bool):
        return None
    if not isinstance(current, (int, float, str)) or not isinstance(
        next_cost, (int, float, str)
    ):
        return None
    try:
        current_value = float(current)
        next_value = float(next_cost)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(current_value) or not math.isfinite(next_value):
        return None
    if current_value < 0.0 or next_value < 0.0:
        return None
    return current_value + next_value


def _looks_like_generic_greeting_only(response_text: str) -> bool:
    text = str(response_text or "").strip()
    if not text:
        return False
    if len(text) > 240:
        return False
    return (
        _GENERIC_GREETING_RE.search(text) is not None
        or _POST_TOOL_READY_RESET_RE.search(text) is not None
    )


def _looks_like_post_tool_empty_chat_menu(response_text: str) -> bool:
    text = str(response_text or "").strip()
    if not text:
        return False
    return _EMPTY_CHAT_MENU_RE.search(text) is not None


def _post_tool_invalid_response_reason(
    *,
    response_text: str,
    harness_inventory_invalid: bool,
) -> str:
    if _looks_like_generic_greeting_only(response_text):
        return "generic_greeting"
    if _looks_like_post_tool_empty_chat_menu(response_text):
        return "empty_chat_menu"
    if harness_inventory_invalid:
        return "harness_inventory"
    return ""


def _post_tool_invalid_log_data(
    *,
    iteration: int,
    response_text: str,
    invalid_reason: str,
    successful_outcome_count: int,
    harness_summary_available: bool,
    outcome_count: int | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = {
        "iteration": iteration,
        "response_length": len(response_text),
        "invalid_reason": invalid_reason,
        "successful_outcome_count": successful_outcome_count,
        "harness_summary_available": harness_summary_available,
    }
    if outcome_count is not None:
        data["outcome_count"] = outcome_count
    return data


def _web_search_unavailability_reason(tool_statuses: Any) -> str | None:
    for status in tool_statuses or ():
        if str(getattr(status, "name", "")).strip() != "web_search":
            continue
        if getattr(status, "available", None) is True:
            return None
        reason = str(getattr(status, "reason", "") or "runtime/backend unavailable").strip()
        return reason or "runtime/backend unavailable"
    return None


def _current_info_unavailability_response(
    *,
    latest_user_content: str,
    tool_statuses: Any,
) -> str | None:
    if not looks_like_current_info_request(latest_user_content):
        return None
    reason = _web_search_unavailability_reason(tool_statuses)
    if not reason:
        return None
    response = (
        "This request likely needs up-to-date external information, but "
        f"web_search is unavailable for this request: {reason}. "
        "I can't perform a live web lookup in this request."
    )
    remedy = current_info_remediation(reason)
    if remedy:
        response += f" {remedy}"
    return response


def _current_info_unavailability_context(
    *,
    latest_user_content: str,
    tool_statuses: Any,
) -> str | None:
    response = _current_info_unavailability_response(
        latest_user_content=latest_user_content,
        tool_statuses=tool_statuses,
    )
    if not response:
        return None
    return (
        "Tool availability context: "
        f"{response} If the user requested a live lookup, explain this limitation "
        "instead of implying that no tool context was provided."
    )


def _summarize_tool_outcomes(
    outcomes: list[Any],
    *,
    include_outcome: Callable[[Any], bool],
    build_label: Callable[[Any], str],
    empty_detail: str,
    omitted_label: str,
) -> str:
    selected = [outcome for outcome in outcomes if include_outcome(outcome)]
    if not selected:
        return ""
    lines = []
    for outcome in selected[:3]:
        output = sanitize_assistant_output(str(getattr(outcome, "output", "") or "").strip())
        if len(output) > 500:
            output = f"{output[:497].rstrip()}..."
        lines.append(f"- {build_label(outcome)}: {output or empty_detail}")
    extra = len(selected) - len(lines)
    if extra > 0:
        lines.append(f"- {extra} additional {omitted_label} omitted.")
    return "\n".join(lines)


def _summarize_failed_tool_outcomes(outcomes: list[Any]) -> str:
    def build_failed_label(outcome: Any) -> str:
        tool_name = str(getattr(outcome, "tool_name", "") or "tool").strip()
        error_code = str(getattr(outcome, "error_code", "") or "").strip()
        return f"{tool_name} [{error_code}]" if error_code else tool_name

    return _summarize_tool_outcomes(
        outcomes,
        include_outcome=lambda outcome: not getattr(outcome, "success", False),
        build_label=build_failed_label,
        empty_detail="failed without a model-visible detail",
        omitted_label="tool failure(s)",
    )


def _quota_block_guidance(reason: str, cap: int) -> str:
    """Model-facing guidance for a resource-discipline quota block, keyed by scope.

    The web budget gets explicit reassurance — it is per-turn, resets on the next reply,
    and does NOT mean the network is unavailable — because the model otherwise misreads
    "exhausted for this request" as a session-wide network outage and tells the user the
    network is down or that a quota must be reset manually.
    """
    if reason == "web_per_turn":
        return (
            f"this turn's web-tool budget ({cap} calls) is used up. This is a per-turn "
            "limit that resets on your next reply — the network is still available. Do "
            "not tell the user the network is down or that a quota must be reset. Answer "
            "now with the results already gathered, or ask the user to continue if you "
            "need more web lookups."
        )
    if reason == "code_intelligence_per_turn":
        return (
            f"this turn's code-intelligence tool budget ({cap} calls) is used up. This is a "
            "per-turn limit that resets on your next reply. Continue with the "
            "information already gathered."
        )
    if reason == "session_tool_budget":
        return (
            f"this session's tool budget ({cap} calls) is used up. Wrap up using what "
            "you already have."
        )
    if reason == "tool_cooldown":
        return (
            "it is in a brief cooldown after a prior block. Try a different approach or "
            "wait before retrying."
        )
    return f"resource discipline quota '{reason}' is exhausted for this request."


def _failed_tool_context_response(outcomes: list[Any], response_text: str) -> str | None:
    if not outcomes or not _NO_CONTEXT_AFTER_TOOL_RE.search(str(response_text or "")):
        return None
    summary = _summarize_failed_tool_outcomes(outcomes)
    if not summary:
        return None
    return (
        "I did receive tool context, but the requested tool call failed or was unavailable:\n"
        f"{summary}\n\n"
        "I can't treat that as a successful live result."
    )


def _summarize_successful_tool_outcomes(outcomes: list[Any]) -> str:
    return _summarize_tool_outcomes(
        outcomes,
        include_outcome=lambda outcome: getattr(outcome, "success", False),
        build_label=lambda outcome: str(getattr(outcome, "tool_name", "") or "tool").strip(),
        empty_detail="completed successfully",
        omitted_label="successful tool result(s)",
    )


def _successful_tool_context_response(outcomes: list[Any]) -> str | None:
    summary = _summarize_successful_tool_outcomes(outcomes)
    if not summary:
        return None
    return (
        "I ran the requested tool call, but the model restarted the conversation "
        "instead of using the result. Tool result summary:\n"
        f"{summary}"
    )


def _empty_post_tool_context_response(outcomes: list[Any]) -> str | None:
    failed_summary = _summarize_failed_tool_outcomes(outcomes)
    successful_summary = _summarize_successful_tool_outcomes(outcomes)
    if failed_summary and successful_summary:
        return (
            "I ran the requested tool calls, but the model did not produce a visible "
            "final response. Some tool calls succeeded and others failed.\n"
            f"Successful tool results:\n{successful_summary}\n\n"
            f"Failed tool results:\n{failed_summary}"
        )
    if failed_summary:
        return (
            "I did receive tool context, but the requested tool call failed or was "
            "unavailable:\n"
            f"{failed_summary}\n\n"
            "I can't treat that as a successful live result."
        )
    if successful_summary:
        return (
            "I ran the requested tool call, but the model did not produce a visible "
            "final response. Tool result summary:\n"
            f"{successful_summary}"
        )
    return None


def _emit_deterministic_response_tokens(
    *,
    runtime: LoopRuntime,
    streamed_event_types: set[str],
    response_text: str,
) -> None:
    if not runtime.streaming or "chat.token" in streamed_event_types:
        return
    for index, delta in enumerate(tokenize_with_whitespace(response_text), start=1):
        if delta:
            runtime.emit(TokenDeltaEvent(delta=delta, token_index=index))
    streamed_event_types.add("chat.token")


def _should_issue_tool_nudge(
    *,
    kernel: Any,
    mode_policy: Any,
    outcomes: list[Any],
    response_looks_like_fake_tool_use: bool,
) -> bool:
    return (
        response_looks_like_fake_tool_use
        and str(kernel._config.engine_type or "").strip().lower() == "ollama"
        and str(getattr(mode_policy, "mode", "") or "").strip().lower() == "assist"
        and not outcomes
    )


# ---------------------------------------------------------------------------
# Stop-abort flush helpers
# ---------------------------------------------------------------------------

# Generic: drained buffers can come from any ``StopController`` abort (semantic
# stuck-loop, wall-clock, budget, cycle), so the wording avoids claiming the
# model was repeating itself when it might have been a budget or wall-clock
# cap instead. The exact reason is still on the wire as the StopEvent's
# ``code`` and ``subcode``.
GUARDRAIL_FOOTER = "\n\n_(Stopped early — output above is partial.)_"

CANCEL_REASON_LOOP_ABORTED = "loop_aborted"


def _drain_unflushed_buffer(runtime: LoopRuntime) -> str:
    """Emit buffered preamble deltas as TokenDeltaEvents and return joined text.

    ``stream_generate_with_tools`` flushes visible text before returning, so
    this stash is normally empty; it still carries text when a generation
    exits without flushing (e.g. the malformed-tool-arguments terminal). When
    ``StopController`` aborts the loop, draining it as ``chat.token`` events
    keeps that text from being discarded.
    """
    parts = [delta for delta in runtime.last_iteration_unflushed if delta]
    runtime.last_iteration_unflushed = []
    if not parts:
        return ""
    for token_index, delta in enumerate(parts, start=1):
        runtime.emit(TokenDeltaEvent(delta=delta, token_index=token_index))
    return "".join(parts)


def flush_unflushed_terminal_output(runtime: LoopRuntime, kernel: Any) -> str:
    """Publish any final buffered model text before a terminal failure settles."""

    drained_text = _drain_unflushed_buffer(runtime)
    if drained_text:
        _mark_buffer_flushed(kernel, runtime)
    return drained_text


def _emit_pending_tool_cancellations(
    runtime: LoopRuntime,
    *,
    tool_calls: tuple[ToolCallRequest, ...],
    code: str,
    cancel_reason: str,
) -> list[Any]:
    """Emit ``tool.result`` (success=False) for each in-flight tool call.

    Emits a paired ``tool.executing`` / ``tool.result`` cancellation for each
    tool call that the stop policy prevented from dispatching, keeping the
    backend's pending-tool map from stranding rows in ``running`` state.
    """
    from sidecar.ai.routing.router import ToolExecutionOutcome

    cancellations: list[Any] = []
    for index, call in enumerate(tool_calls, start=1):
        outcome = ToolExecutionOutcome(
            tool_name=call.tool_id,
            output=f"Tool execution cancelled: {cancel_reason}.",
            success=False,
            tool_input=dict(call.arguments),
            error_code=code,
            # The call never dispatched, so "none" is a fact, not a guess; the
            # stop code itself classifies as internal_error, which would
            # misdescribe a per-call cancellation.
            metadata={
                "cancel_reason": cancel_reason,
                "effects": "none",
                "failure_class": "cancelled",
            },
            call_id=str(call.call_id or ""),
        )
        cancellations.append(outcome)
        call_id = loop_event_emit.emit_tool_executing(
            runtime,
            call,
            runtime.request_id,
            index,
        )
        loop_event_emit.emit_tool_result(runtime, outcome, call_id)
    return cancellations


def _build_stopped_response_text(
    stop_reason: StopReason,
    drained_text: str,
    generated_response_text: str = "",
) -> tuple[str, str]:
    """Build a stopped response without replacing model text with the guardrail."""

    generated = sanitize_assistant_output(
        str(generated_response_text or ""),
        max_chars=MAX_RESPONSE_CHARS,
    ).rstrip()
    visible_model_text = generated or drained_text.rstrip()
    if visible_model_text:
        return f"{visible_model_text}{GUARDRAIL_FOOTER}", "model"
    return stop_reason.message, "deterministic_tool_fallback"


def _mark_buffer_flushed(kernel: Any, runtime: LoopRuntime) -> None:
    """Record on the diagnostics store that buffered output reached the user."""
    store = current_diagnostics_store(getattr(kernel, "_engine", None))
    if store is None or not hasattr(store, "mark_buffered_visible_output_flushed"):
        return
    store.mark_buffered_visible_output_flushed(request_id=runtime.request_id)


def _build_stopped_tool_loop_result(
    *,
    runtime: LoopRuntime,
    kernel: Any,
    stop_reason: StopReason,
    streamed_event_types: set[str],
    outcomes: list[Any],
    usage_totals: GenerationUsage | None,
    pending_tool_calls: tuple[ToolCallRequest, ...] = (),
    generated_response_text: str = "",
) -> ToolLoopResult:
    """Drain buffered preamble, cancel pending tools, build the abort result.

    Shared by both ``StopController.evaluate`` call sites in ``run_tool_loop``.
    The pre-generation site has no in-flight tool calls; the post-generation
    site passes the iteration's ``result.tool_calls`` so they transition out
    of ``running`` instead of stranding the backend's ``pendingToolCalls`` map.
    """
    drained_text = _drain_unflushed_buffer(runtime)
    if drained_text:
        _mark_buffer_flushed(kernel, runtime)
        streamed_event_types.add("chat.token")
    if pending_tool_calls:
        cancellations = _emit_pending_tool_cancellations(
            runtime,
            tool_calls=pending_tool_calls,
            code=stop_reason.code,
            cancel_reason=CANCEL_REASON_LOOP_ABORTED,
        )
        outcomes.extend(cancellations)
        if runtime.streaming and cancellations:
            streamed_event_types.add("tool.executing")
            streamed_event_types.add("tool.result")
    response_text, completion_source = _build_stopped_response_text(
        stop_reason,
        drained_text,
        generated_response_text,
    )
    return ToolLoopResult(
        thinking_text=stop_reason.message,
        thinking_kind=CHAT_THINKING_KIND_STATUS,
        persist_thinking=False,
        response_text=response_text,
        approval_request=None,
        approval_plan=None,
        outcomes=outcomes,
        usage_totals=usage_totals,
        streamed_event_types=streamed_event_types,
        completion_source=completion_source,
    )


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def run_tool_loop(  # noqa: C901, PLR0912, PLR0915
    *,
    runtime: LoopRuntime,
    kernel: Any,
    request_context: Any | None,
    working_messages: list[dict[str, object]],
    tool_contract: Any,
    tool_payload: list[dict[str, Any]],
    tool_resolution_context: Any | None,
    tool_preferences: dict[str, tuple[str, ...]] | None,
    mode_policy: Any,
    plan_mode: bool,
    read_only: bool,
    approvals_pre_granted: bool,
    request_id: str,
    session_id: str | None,
    latest_user_content: str,
    reasoning_effort: str | None,
    prompt_cache_enabled: bool,
    cache_source_key: str,
    system_prompt: Any,
    cache_break_detector: Any | None,
    budget_tracker: BudgetTracker | None,
    read_snapshot_cache: dict[str, Any],
    tool_statuses: Any,
    initial_thinking_text: str | None,
    initial_outcomes: tuple[Any, ...] = (),
    initial_usage_totals: GenerationUsage | None = None,
    initial_streamed_event_types: frozenset[str] | set[str] = frozenset(),
    request_messages_hash: str = "",
    initial_change_set_id: str | None = None,
) -> ToolLoopResult:
    """Run the agent tool loop, emitting typed events via *runtime*.

    This is a pure extraction of the loop body that was previously inline
    in ``AgentKernel.build_chat_decision()`` (router.py lines 745-1073).
    The ``kernel`` parameter is the ``AgentKernel`` instance, used to call
    its existing helper methods (``_generate_step``, ``_execute_tool``,
    etc.) without duplicating them.
    """
    run = _ToolLoopRun(
        runtime=runtime,
        kernel=kernel,
        request_context=request_context,
        working_messages=working_messages,
        tool_contract=tool_contract,
        tool_payload=tool_payload,
        tool_resolution_context=tool_resolution_context,
        tool_preferences=tool_preferences,
        mode_policy=mode_policy,
        plan_mode=plan_mode,
        read_only=read_only,
        approvals_pre_granted=approvals_pre_granted,
        request_id=request_id,
        session_id=session_id,
        latest_user_content=latest_user_content,
        reasoning_effort=reasoning_effort,
        prompt_cache_enabled=prompt_cache_enabled,
        cache_source_key=cache_source_key,
        system_prompt=system_prompt,
        cache_break_detector=cache_break_detector,
        budget_tracker=budget_tracker,
        read_snapshot_cache=read_snapshot_cache,
        tool_statuses=tool_statuses,
        initial_thinking_text=initial_thinking_text,
        initial_outcomes=initial_outcomes,
        initial_usage_totals=initial_usage_totals,
        initial_streamed_event_types=initial_streamed_event_types,
        request_messages_hash=request_messages_hash,
        initial_change_set_id=initial_change_set_id,
    )
    try:
        return run.execute()
    except Exception as error:
        # Cancellation and provider failures escape execute() without _finish;
        # settle the journal so the set is never stranded in_progress.
        from sidecar.ai.routing.mutation_change_set_lifecycle import (  # noqa: PLC0415
            finish_run_change_set,
        )

        try:
            finish_run_change_set(
                run,
                approval_paused=False,
                reason=f"exception:{type(error).__name__}",
            )
        except Exception as settle_error:  # noqa: BLE001 - preserve the original exception.
            logger.warning(
                "workspace_change_set_exception_settlement_failed",
                extra={"reason": type(settle_error).__name__},
            )
        raise
