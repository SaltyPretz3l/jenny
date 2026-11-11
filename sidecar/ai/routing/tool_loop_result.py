"""How ``run_tool_loop`` ends: its result carrier and the stop-abort flush.

``StopController`` aborts and terminal failures end the loop with buffered model
text or in-flight tool calls; the flush helpers publish the text and settle the
calls so the backend never strands a ``running`` row. The hub (``tool_loop``)
re-exports these names for its siblings and for chat_router/chat_resume.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sidecar.ai.routing import loop_event_emit
from sidecar.ai.routing.loop_events import TokenDeltaEvent
from sidecar.ai.routing.visible_reply import finalize_visible_reply
from sidecar.protocol import CHAT_THINKING_KIND_STATUS
from sidecar.runtime.chat_helpers import tokenize_with_whitespace
from sidecar.runtime.local_engine.request_context import current_diagnostics_store

if TYPE_CHECKING:
    # Through the hub, which already imports them: keeps this leaf in its fan-out budget.
    from sidecar.ai.routing.tool_loop import (
        GenerationUsage,
        LoopRuntime,
        StopReason,
        ToolCallRequest,
    )


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
        "turn_boundary",
        "terminal_error_code",
        "terminal_subcode",
        "terminal_error_retryable",
    )

    def __init__(  # noqa: PLR0913 - keyword-only result fields
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
        turn_boundary: Any | None = None,
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
        self.turn_boundary = turn_boundary
        self.terminal_error_code = str(terminal_error_code or "").strip() or None
        self.terminal_subcode = str(terminal_subcode or "").strip() or None
        self.terminal_error_retryable = bool(terminal_error_retryable)


# Generic: drained buffers can come from any ``StopController`` abort (semantic
# stuck-loop, wall-clock, budget, cycle), so the wording avoids claiming the
# model was repeating itself when it might have been a budget or wall-clock
# cap instead. The exact reason is still on the wire as the StopEvent's
# ``code`` and ``subcode``.
GUARDRAIL_FOOTER = "\n\n_(Stopped early — output above is partial.)_"

CANCEL_REASON_LOOP_ABORTED = "loop_aborted"


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

    generated = finalize_visible_reply(generated_response_text).rstrip()
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


def _build_stopped_tool_loop_result(  # noqa: PLR0913 - keyword-only
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
