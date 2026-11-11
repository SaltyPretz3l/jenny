"""Tools-stripped wind-down endings for the tool loop.

Split from ``tool_loop_recovery.py``, which re-exports the public names. Every
turn that must stop calling tools -- an empty post-tool completion, a spent
tool cap, diminishing returns, a context-budget stop, the iteration limit --
ends here with a visible answer: one tools-stripped generation when it can
help, else a deterministic summary of the outcomes, plus the stop footer.
Helpers operate on the ``_ToolLoopRun`` instance (``loop``).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable

from sidecar.ai.routing.budget_stop_details import (
    _NO_PROGRESS_WINDOW,
    budget_stop_details,
    fallback_sentence,
)
from sidecar.ai.routing.wind_down_evidence import wind_down_evidence_note

logger = logging.getLogger("sidecar.ai.routing.tool_loop")



def _is_tool_call_markup(text: str, loop: Any) -> bool:
    """Thin delegate: is the visible text nothing but a call to the turn's tools?"""
    import sidecar.ai.routing.tool_loop as _tl_hub

    names = _tl_hub.text_tool_calls.recognized_tool_names(loop.tool_contract)
    return _tl_hub.text_tool_calls.is_tool_call_only(str(text or ""), names)


def _tool_cap_spent(loop: Any) -> bool:
    # HB-031: a resumed leg is a new run without the flag; a spent runtime budget counts.
    if getattr(loop, "tool_cap_tools_stripped", False):
        return True
    return int(loop.runtime.tool_call_limit or 0) > 0 and loop.runtime.remaining_tool_calls == 0


_UNRUN_TEXT_CALL = (
    "My {names} call was written as text after tool use ended for this turn, "
    "so it did not run."
)


def _drop_text_tool_calls(loop: Any, text: str, *, reason: str) -> str:
    """Strip known-tool calls written as text on a tools-less leg; they never run."""
    import sidecar.ai.routing.tool_loop as _tl_hub

    names = _tl_hub.text_tool_calls.recognized_tool_names(loop.tool_contract)
    prose, calls = _tl_hub.text_tool_calls.strip_text_tool_calls(text, names)
    if not calls:
        return text
    tools = list(dict.fromkeys(call.name for call in calls))
    complete = all(call.complete for call in calls)
    _tl_hub.log_event(
        logger,
        logging.INFO,
        component="ai.router",
        event="ai.router.text_tool_call_dropped",
        message="Dropped a tool call the model wrote as text on a tools-less leg.",
        status="degraded",
        data={"tools": tools, "complete": complete, "reason": reason, "shape": calls[0].shape},
        request_id=loop.request_id,
        session_id=loop.session_id,
    )
    if prose:  # The markup already streamed: replace it in the live row, with the reason.
        names_text = ", ".join(f"`{tool}`" for tool in tools)
        prose = f"{prose}\n\n{_UNRUN_TEXT_CALL.format(names=names_text)}"
        _restream_response(loop, prose)
    return prose


def _restream_response(loop: Any, response_text: str) -> None:
    """The live row still shows earlier text: reset it so it matches the persisted answer."""
    import sidecar.ai.routing.tool_loop as _tl_hub

    _tl_hub.loop_event_emit.emit_stream_reset_for_retry(
        loop.runtime, loop.streamed_event_types, reason="deterministic_replacement"
    )
    _tl_hub._emit_deterministic_response_tokens(
        runtime=loop.runtime, streamed_event_types=loop.streamed_event_types,
        response_text=response_text,
    )


_MAX_ITERATIONS_WIND_DOWN = (
    "System note, not a message from the user: you have reached the tool-iteration "
    "limit for this turn. Do not call any more tools. Summarize for the user what "
    "you completed, what failed, and what remains to be done. Do not mention this note."
)

_MAX_ITERATIONS_FALLBACK_RESPONSE = (
    "I reached the tool-iteration limit for this turn before finishing. "
    "The tool results so far are shown above; tell me to continue and I will "
    "pick up where I left off."
)

# Wind-down nudges are system notes appended after the conversation. Thinking
# models narrate whatever they take for the user's latest ask, so each note
# says who it is from and what to do, never what "the user wants" (owner gate
# 2026-09-20: the visible reasoning read "The user wants me to stop calling
# tools" when no user message said that).
_EMPTY_FINAL_WIND_DOWN = (
    "System note, not a message from the user: the tool phase of this turn is "
    "over. Do not call any more tools. Reply to the user now, in your own voice, "
    "with the answer or the progress so far based on the tool results above, "
    "including any failure and what remains to be done. Do not mention this note."
)

_BUDGET_EXHAUSTED_WIND_DOWN = (
    "System note, not a message from the user: this turn's tool budget is spent. "
    "Do not call any more tools. Reply to the user now with what you completed "
    "and what is blocking further progress. Do not mention this note."
)

# TR-011: the no-progress stop is not a budget; calling it one made the model
# tell the user its tool budget was exhausted after three failed reads.
_NO_PROGRESS_WIND_DOWN = (
    "System note, not a message from the user: the harness ended this turn's tool "
    f"phase because your last {_NO_PROGRESS_WINDOW} rounds of tool calls made no "
    "progress (for example, they failed or returned nothing new). This is a "
    "no-progress safeguard, not a tool budget, quota or limit: nothing ran out. "
    "Do not call any more tools. Reply to the user now with what you completed, "
    "which calls failed and why, and what you would try next. The user can reply "
    "'resume' to continue; a line saying so is appended to your reply. Do not "
    "mention this note."
)


def _max_iterations_fallback_response(outcomes: list[Any]) -> str:
    """Summarize every terminal outcome class when final synthesis is blank."""
    import sidecar.ai.routing.tool_loop as _tl_hub

    return (
        _tl_hub._empty_post_tool_context_response(outcomes)
        or _MAX_ITERATIONS_FALLBACK_RESPONSE
    )


@dataclass(frozen=True)
class WindDownSpec:
    system_message: str
    event: str
    message: str
    fallback_response: Callable[[], str]
    log_data: dict[str, Any] | None = None
    # Overrides the loop's effort for this one generation. Used by the
    # thinking-budget wind-down, where leaving thinking on would spend the same
    # output budget that just ran out and produce another empty turn.
    reasoning_effort: str | None = None


def wind_down_response(
    loop: Any,
    spec: WindDownSpec,
) -> tuple[str, str]:
    """Run one tools-stripped generation and return a non-empty response."""
    import sidecar.ai.routing.tool_loop as _tl_hub

    _tl_hub.loop_event_emit.emit_stream_reset_for_retry(
        loop.runtime, loop.streamed_event_types, reason="model_winddown"
    )
    diagnostic_data = {"outcome_count": len(loop.outcomes)}
    diagnostic_data.update(spec.log_data or {})
    _tl_hub.log_event(
        logger,
        logging.WARNING,
        component="ai.router",
        event=spec.event,
        message=spec.message,
        status="degraded",
        data=diagnostic_data,
        request_id=loop.request_id,
    )
    response_text = ""
    try:
        system_message = spec.system_message
        evidence = wind_down_evidence_note(loop.outcomes)
        if evidence is not None:
            system_message = f"{system_message}\n\n{evidence}"
        loop.working_messages.append({"role": "system", "content": system_message})
        result, streamed_generation_types = loop.kernel._generate_step(
            latest_user_content=loop.latest_user_content,
            working_messages=_tl_hub.build_generation_messages(loop.working_messages),
            reasoning_effort=spec.reasoning_effort or loop.reasoning_effort,
            prompt_cache_enabled=loop.prompt_cache_enabled,
            source_key=loop.cache_source_key,
            system_prompt=loop.system_prompt,
            tool_schemas=[],
            cache_break_detector=loop.cache_break_detector,
            runtime=loop.runtime,
            response_format=None,
        )
        loop.streamed_event_types.update(streamed_generation_types)
        loop.usage_totals = _tl_hub._merge_generation_usage(loop.usage_totals, result.usage)
        loop.runtime.report_generation_usage(loop.usage_totals, result.usage)
        response_text = _tl_hub.finalize_visible_reply(
            result.content, request_id=loop.request_id, session_id=loop.session_id
        ).strip()
        response_text = _drop_text_tool_calls(loop, response_text, reason="tools_stripped")
    except _tl_hub.TerminalChatStateError:
        raise
    except Exception:  # noqa: BLE001 - deterministic fallback below.
        response_text = ""
    completion_source = "model_winddown"
    if not response_text:
        response_text = spec.fallback_response()
        completion_source = "deterministic_tool_fallback"
        _restream_response(loop, response_text)
    return response_text, completion_source


def empty_final_wind_down(loop: Any) -> Any:
    """Replace an empty post-tool completion with a visible wind-down."""
    import sidecar.ai.routing.tool_loop as _tl_hub

    response_text, completion_source = wind_down_response(
        loop,
        WindDownSpec(
            # HB-022: thinking is what this tools-stripped "reply now" leg must not spend; the
            # engine maps "none" to enable_thinking=False (openai_compatible._build_payload).
            reasoning_effort="none",
            system_message=_EMPTY_FINAL_WIND_DOWN,
            event="ai.router.empty_final_winddown",
            message="Post-tool completion was empty; winding down with a summary.",
            fallback_response=lambda: (
                _tl_hub._empty_post_tool_context_response(loop.outcomes)
                or "I completed tool work but could not produce a visible final response."
            ),
        ),
    )
    loop.runtime.audit(
        _tl_hub.KIND_TURN_COMPLETED,
        summary=f"turn_completed empty_final_winddown outcomes={len(loop.outcomes)}",
    )
    return loop._finish(
        _tl_hub.ToolLoopResult(
            thinking_text="Summarizing completed tool work.",
            thinking_kind=_tl_hub.CHAT_THINKING_KIND_STATUS,
            persist_thinking=False,
            response_text=response_text,
            approval_request=None,
            approval_plan=None,
            outcomes=loop.outcomes,
            usage_totals=loop.usage_totals,
            streamed_event_types=loop.streamed_event_types,
            completion_source=completion_source,
        ),
        reason="empty_final_winddown",
    )


def _output_capped(result: Any) -> bool:
    return str(result.finish_reason).strip().lower() == "length"


def budget_exhausted_wind_down(loop: Any, result: Any, *, reason: str) -> Any:
    """Finish a tool-budget stop with visible progress and continuation guidance."""
    import sidecar.ai.routing.tool_loop as _tl_hub

    raw_content = str(result.content or "")
    response_text = _tl_hub.finalize_visible_reply(
        raw_content, request_id=loop.request_id, session_id=loop.session_id
    ).strip()
    output_capped = reason == "context_budget" and _output_capped(result)
    stop_sentence = fallback_sentence(reason, output_capped=output_capped)
    completion_source = "model"
    clean_answer = False
    if reason == "context_budget":
        # The context is already over the error threshold: another generation
        # would only fail, so go straight to the deterministic summary, led by
        # why the turn stopped (a parent reading the report saw a model failure).
        response_text = (
            _tl_hub._empty_post_tool_context_response(
                loop.outcomes, lead=f"{stop_sentence} Here is what I gathered so far."
            )
            or stop_sentence
        )
        completion_source = "deterministic_tool_fallback"
        _restream_response(loop, response_text)
    elif reason != "tool_cap" or not response_text or _is_tool_call_markup(raw_content, loop):
        response_text, completion_source = wind_down_response(
            loop,
            WindDownSpec(
                # HB-022: thinking is what this tools-stripped "reply now" leg must not spend; the
                # engine maps "none" to enable_thinking=False (openai_compatible._build_payload).
                reasoning_effort="none",
                system_message=(
                    _NO_PROGRESS_WIND_DOWN
                    if reason == "diminishing_returns"
                    else _BUDGET_EXHAUSTED_WIND_DOWN
                ),
                event="ai.router.budget_exhausted_winddown",
                message="Tool-loop budget was exhausted; winding down with a summary.",
                fallback_response=lambda: (
                    _tl_hub._empty_post_tool_context_response(loop.outcomes)
                    or stop_sentence
                ),
                log_data={"reason": reason},
            ),
        )
    else:
        # HB-031: prose then a call written as text keeps the prose; no regeneration.
        kept = _drop_text_tool_calls(loop, response_text, reason="tool_cap")
        # F25: no text call dropped means the model did not try to go on.
        clean_answer = kept == response_text
        response_text = kept
    footer, event, log_data = budget_stop_details(
        loop, reason, output_capped=output_capped, clean_answer=clean_answer
    )
    if footer not in response_text:
        response_text = f"{response_text.rstrip()}\n\n{footer}"
    _tl_hub.tool_loop_recovery.emit_degradation_status(
        loop, text=footer, event=event, data=log_data, log_level=logging.INFO
    )
    return loop._finish(
        _tl_hub.ToolLoopResult(
            thinking_text="Budget exhausted or diminishing returns detected.",
            thinking_kind=_tl_hub.CHAT_THINKING_KIND_STATUS,
            persist_thinking=False,
            response_text=response_text,
            approval_request=None,
            approval_plan=None,
            outcomes=loop.outcomes,
            usage_totals=loop.usage_totals,
            streamed_event_types=loop.streamed_event_types,
            completion_source=completion_source,
            resumable_stop=reason,
        ),
        reason="budget_exhausted",
    )


def maybe_wind_down_tool_cap_final(loop: Any, result: Any) -> Any | None:
    """Finish the first post-cap clean-stop response with an answer and footer.

    Anything that is not a clean stop (truncated/errored streams, a
    thinking-budget checkpoint, a failed in-band parse) is left to the base
    finalization ladder, which owns the retry and terminal-error contracts.
    """
    if not _tool_cap_spent(loop):
        return None
    # A thinking-budget checkpoint always carries finish_reason "thinking_budget"
    # or "length" (thinking_checkpoint.is_thinking_budget_checkpoint), so the
    # clean-stop gate below excludes it without importing that module.
    finish_reason = str(getattr(result, "finish_reason", "") or "").strip().lower()
    if finish_reason not in {"", "stop"}:
        return None
    if getattr(result, "inband_tool_call_parse_failed", False):
        return None
    return budget_exhausted_wind_down(loop, result, reason="tool_cap")


def max_iterations_summary(loop: Any) -> Any:
    """Wind the turn down with a summary when the iteration budget is spent.

    Replaces the old ``CMP_LOOP_MAX_ITERATIONS`` raise, which ended an
    exhausted-but-productive turn with an error card and threw away everything
    the model had done. One final generation runs with tools stripped so the
    model can state its own progress; if that fails or comes back empty, a
    deterministic outcome summary is emitted instead. Cancellation still
    propagates.
    """
    import sidecar.ai.routing.tool_loop as _tl_hub

    loop._settle_unfinished_tool_results("max_iterations")
    response_text, completion_source = wind_down_response(
        loop,
        WindDownSpec(
            # HB-022: thinking is what this tools-stripped "reply now" leg must not spend; the
            # engine maps "none" to enable_thinking=False (openai_compatible._build_payload).
            reasoning_effort="none",
            system_message=_MAX_ITERATIONS_WIND_DOWN,
            event="ai.router.max_iterations_summary",
            message=(
                "Agent loop reached maximum iteration depth; winding down with a summary."
            ),
            fallback_response=lambda: _max_iterations_fallback_response(loop.outcomes),
            log_data={"max_iterations": loop.max_iterations},
        ),
    )
    loop.runtime.audit(
        _tl_hub.KIND_TURN_COMPLETED,
        summary=(
            f"turn_completed max_iterations_summary outcomes={len(loop.outcomes)}"
        ),
    )
    return loop._finish(
        _tl_hub.ToolLoopResult(
            thinking_text="Iteration budget reached; summarizing progress.",
            thinking_kind=_tl_hub.CHAT_THINKING_KIND_STATUS,
            persist_thinking=False,
            response_text=response_text,
            approval_request=None,
            approval_plan=None,
            outcomes=loop.outcomes,
            usage_totals=loop.usage_totals,
            streamed_event_types=loop.streamed_event_types,
            completion_source=completion_source,
            resumable_stop="max_iterations",
        ),
        reason="max_iterations_summary",
    )
