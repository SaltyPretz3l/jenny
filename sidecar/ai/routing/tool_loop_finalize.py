"""Final-response phase (P8) for the tool loop.

Carved from ``run_tool_loop``'s no-tool-call branch. Mixed into
``_ToolLoopRun``; state and bound helpers are provided by that class. Hub
module names are reached through a function-local
``import sidecar.ai.routing.tool_loop as _tl_hub``.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from sidecar.ai.error_codes import CMP_STREAM_INCOMPLETE
from sidecar.ai.routing.thinking_checkpoint import (
    CHECKPOINT_CARRY_CHARS,
    build_checkpoint_messages,
    build_reasoning_summary_messages,
    checkpoint_carry_similarity,
    checkpoint_no_progress,
    checkpoint_phase_summary,
    is_thinking_budget_checkpoint,
    resolve_checkpoint_limit,
    thinking_budget_continuation_enabled,
)
from sidecar.runtime.turn_state import TERMINAL_SUBCODE_THINKING_BUDGET

logger = logging.getLogger("sidecar.ai.routing.tool_loop")


class _FinalResponseMixin:
    """P8: process the final response text when the model emits no tool call."""

    # -- Host-state declarations (zero runtime effect) --------------------
    # Mixed into ``_ToolLoopRun`` (tool_loop_run.py), which owns the real
    # attributes/methods below. mypy checks this class independently and cannot
    # see the hub, so these bare annotations and the ``TYPE_CHECKING`` stub tell
    # it the host provides these at runtime. Bare ``name: Type`` lines only
    # populate ``__annotations__`` -- they create no attribute and never shadow
    # the hub's values. Types are sourced verbatim from ``_ToolLoopRun.__init__``.
    runtime: Any
    kernel: Any
    request_id: str
    session_id: str | None
    latest_user_content: str
    mode_policy: Any
    tool_payload: list[dict[str, Any]]
    tool_statuses: Any
    working_messages: list[dict[str, object]]
    outcomes: list[Any]
    usage_totals: Any | None
    streamed_event_types: set[str]
    thinking_text: str | None
    max_iterations: Any
    iteration_total: int
    tool_nudge_attempted: bool
    thinking_budget_checkpoints: int
    last_checkpoint_carry: str | None
    prompt_cache_enabled: bool
    reflexive_retry_attempted: bool
    pending_retry_response_format: Any | None
    post_tool_continuation_attempted: bool
    sub_agent_report_finalization_requested: bool
    sub_agent_budget_finalization_requested: bool
    cycle_hint_attempted: bool
    request_context: Any | None
    gate_attempts: int
    gate_iterations_granted: int

    if TYPE_CHECKING:
        # Hub-owned methods (defined on ``_ToolLoopRun`` in tool_loop_run.py).
        # Never executed -- ``TYPE_CHECKING`` is False at runtime.
        def _finish(self, loop_result: Any, *, reason: str) -> Any: ...
        def grant_gate_iteration(self) -> bool: ...

    def _sub_agent_report_disposition(
        self,
        result: Any,
        iteration: int,
        *,
        already_finalizing: bool,
    ) -> str:
        """Classify a child response and request its one constrained retry."""

        import sidecar.ai.routing.tool_loop as _tl_hub
        from sidecar.ai.routing.iteration_limits import (
            is_sub_agent_request_context,
        )
        from sidecar.ai.routing.subagent_finalization import valid_response

        if not is_sub_agent_request_context(self.request_context):
            return "not_applicable"
        response_text = _tl_hub.sanitize_assistant_output(
            str(result.content or ""),
            max_chars=_tl_hub.MAX_RESPONSE_CHARS,
        )
        if valid_response(self.request_context, response_text):
            return "valid"
        if already_finalizing or iteration >= self.iteration_total:
            return "invalid_final"

        self.sub_agent_report_finalization_requested = True
        _tl_hub.loop_event_emit.emit_stream_reset_for_retry(
            self.runtime,
            self.streamed_event_types,
            reason="deterministic_replacement",
        )
        _tl_hub.log_event(
            logger,
            logging.WARNING,
            component="ai.router",
            event="ai.router.subagent_report_finalization_requested",
            message=(
                "Sub-agent returned an invalid completion; retrying once without tools "
                "under its configured completion contract."
            ),
            status="retry",
            data={
                "iteration": iteration,
                "max_iterations": self.iteration_total,
                "response_length": len(response_text),
                "outcome_count": len(self.outcomes),
            },
            request_id=self.request_id,
            session_id=self.session_id,
        )
        return "retry"

    def _finish_invalid_sub_agent_report(self, result: Any) -> Any:
        """End a child after its constrained report attempt remains invalid."""

        import sidecar.ai.routing.tool_loop as _tl_hub

        response_text = _tl_hub.sanitize_assistant_output(
            str(result.content or ""),
            max_chars=_tl_hub.MAX_RESPONSE_CHARS,
        )
        _tl_hub.log_event(
            logger,
            logging.WARNING,
            component="ai.router",
            event="ai.router.subagent_report_finalization_invalid",
            message="Sub-agent constrained finalization still returned an invalid report.",
            status="failed",
            data={
                "response_length": len(response_text),
                "outcome_count": len(self.outcomes),
            },
            request_id=self.request_id,
            session_id=self.session_id,
        )
        return self._finish(
            _tl_hub.ToolLoopResult(
                thinking_text="Sub-agent report finalization failed validation.",
                thinking_kind=_tl_hub.CHAT_THINKING_KIND_STATUS,
                persist_thinking=False,
                response_text=response_text,
                approval_request=None,
                approval_plan=None,
                outcomes=self.outcomes,
                usage_totals=self.usage_totals,
                streamed_event_types=self.streamed_event_types,
                completion_source="model",
            ),
            reason=(
                "budget_exhausted"
                if self.sub_agent_budget_finalization_requested
                else "subagent_invalid_report"
            ),
        )

    def _finish_valid_sub_agent_report(self, result: Any) -> Any:
        """Terminalize a validated child report without parent-response recovery."""

        import sidecar.ai.routing.tool_loop as _tl_hub

        response_text = _tl_hub.sanitize_assistant_output(
            str(result.content or ""),
            max_chars=_tl_hub.MAX_RESPONSE_CHARS,
        )
        reasoning_text = str(result.thinking_text or "").strip()
        self.runtime.audit(
            _tl_hub.KIND_TURN_COMPLETED,
            summary=(
                f"subagent_report_completed chars={len(response_text)} "
                f"outcomes={len(self.outcomes)}"
            ),
        )
        return self._finish(
            _tl_hub.ToolLoopResult(
                thinking_text=reasoning_text or self.thinking_text,
                thinking_kind=(
                    _tl_hub.CHAT_THINKING_KIND_REASONING
                    if reasoning_text
                    else _tl_hub.CHAT_THINKING_KIND_STATUS
                ),
                persist_thinking=bool(reasoning_text),
                response_text=response_text,
                approval_request=None,
                approval_plan=None,
                outcomes=self.outcomes,
                usage_totals=self.usage_totals,
                streamed_event_types=self.streamed_event_types,
                completion_source="model",
            ),
            reason=(
                "budget_exhausted"
                if self.sub_agent_budget_finalization_requested
                else (
                    "final_response_with_reasoning"
                    if reasoning_text
                    else "final_response"
                )
            ),
        )

    def _run_verification_gate(self, _iteration: int) -> Any:
        """Run the turn-finalization verification gate, if it applies.

        Returns the ``GateDecision`` describing what the caller should do. This
        never raises and never finishes the turn: the gate is information attached
        to a completed turn, never a reason to withhold one.
        """
        from sidecar.ai.routing import verification_gate as _gate

        config = getattr(self.kernel, "_config", None)
        if not _gate.should_run_gate(
            feature_flags=getattr(config, "feature_flags", None),
            tools_verify_enabled=getattr(config, "tools_verify_enabled", False),
            attempts=self.gate_attempts,
            outcomes=self.outcomes,
        ):
            return _gate.NO_GATE_ACTION
        self.gate_attempts += 1
        # Ask for the carve-out BEFORE running, so "can I retry?" is answered by
        # real capacity rather than a guess the loop might not honour.
        retry_allowed = self.grant_gate_iteration()
        decision = _gate.run_gate(self, retry_allowed=retry_allowed)
        if retry_allowed and not decision.retry:
            # The grant went unused (the gate passed, was skipped, or the mode is
            # report-only). Hand it back so a later gate attempt in this same run
            # can still claim it, and so the model never inherits the slack.
            self.gate_iterations_granted -= 1
            self.max_iterations -= 1
            self.iteration_total -= 1
        import sidecar.ai.routing.tool_loop as _tl_hub

        _tl_hub.log_event(
            logger,
            logging.INFO if decision.status == "passed" else logging.WARNING,
            component="ai.router",
            event="ai.router.verification_gate",
            message=f"Verification gate {decision.status or 'did not run'}.",
            status=decision.status or "skipped",
            data={
                "iteration": _iteration,
                "attempt": self.gate_attempts,
                "retry": decision.retry,
                "reason": decision.reason,
            },
            request_id=self.request_id,
            session_id=self.session_id,
        )
        return decision

    def _handle_final_response(  # noqa: C901, PLR0911, PLR0912, PLR0915
        self,
        result: Any,
        _iteration: int,
    ) -> Any | None:
        import sidecar.ai.routing.tool_loop as _tl_hub

        runtime = self.runtime
        kernel = self.kernel
        request_id = self.request_id
        session_id = self.session_id

        # -- No tool calls: process final response text -------------------
        raw_content = str(result.content or "")
        response_text = _tl_hub.sanitize_assistant_output(
            raw_content,
            max_chars=_tl_hub.MAX_RESPONSE_CHARS,
        )
        if result.inband_tool_call_parse_failed:
            from sidecar.ai.routing import tool_call_retry as _reflexive

            _did_retry, self.pending_retry_response_format = _reflexive.run_reflexive_retry(
                kernel=kernel,
                inband_tool_call_parse_failed=True,
                surviving_calls=(), validation_errors=(),
                tool_payload=self.tool_payload, working_messages=self.working_messages,
                already_retried=self.reflexive_retry_attempted, request_id=request_id,
                session_id=session_id)
            if _did_retry:
                self.reflexive_retry_attempted = True
                _tl_hub.loop_event_emit.emit_stream_reset_for_retry(
                    runtime, self.streamed_event_types, reason="reflexive_retry")
                return None
        limit = 0
        if thinking_budget_continuation_enabled() and is_thinking_budget_checkpoint(result):
            limit = resolve_checkpoint_limit(self.kernel._engine, self.kernel._config)
        if self.thinking_budget_checkpoints < limit and _iteration < self.iteration_total:
            text = str(result.thinking_text or "")
            carry = text[-CHECKPOINT_CARRY_CHARS:]
            previous_carry = getattr(self, "last_checkpoint_carry", None)
            if checkpoint_no_progress(previous_carry, carry):
                similarity = checkpoint_carry_similarity(previous_carry, carry)
                _tl_hub.log_event(
                    logger,
                    logging.WARNING,
                    component="ai.router",
                    event="ai.router.thinking_budget_checkpoint_stalled",
                    message="Stopped thinking-budget continuation after no progress.",
                    status="stalled",
                    data={
                        "cycle": self.thinking_budget_checkpoints + 1,
                        "similarity": similarity,
                    },
                    request_id=request_id,
                    session_id=session_id,
                )
            else:
                self.last_checkpoint_carry = carry
                summarize: Callable[[str], str] | None = None
                builder = getattr(self.kernel, "_build_compaction_generate_fn", None)
                if callable(builder):

                    def summarize(elided: str) -> str:
                        generate_fn = builder(
                            request_id=self.request_id,
                            max_tokens=1024,
                            prompt_cache_enabled=getattr(
                                self, "prompt_cache_enabled", False
                            ),
                            runtime=self.runtime,
                        )
                        return generate_fn(build_reasoning_summary_messages(elided))

                self.thinking_budget_checkpoints += 1
                self.working_messages.extend(
                    build_checkpoint_messages(text, summarize=summarize)
                )
                runtime.next_reasoning_phase_summary = checkpoint_phase_summary(
                    self.thinking_budget_checkpoints
                )
                _tl_hub.log_event(
                    logger,
                    logging.INFO,
                    component="ai.router",
                    event="ai.router.thinking_budget_checkpoint",
                    message="Continued the tool loop after a thinking-budget checkpoint.",
                    status="recovered",
                    data={
                        "cycle": self.thinking_budget_checkpoints,
                        "limit": limit,
                        "iteration": _iteration,
                        "finish_reason": str(getattr(result, "finish_reason", "") or ""),
                    },
                    request_id=request_id,
                    session_id=session_id,
                )
                return None
        finish_reason = str(getattr(result, "finish_reason", "") or "").strip().lower()
        if finish_reason in {"incomplete", "error", "thinking_budget"} or (
            finish_reason == "length" and not response_text.strip()
        ):
            error_message = {
                "incomplete": (
                    "The response was cut off before it finished — the model ran out of "
                    "output tokens or the stream ended early. Partial output may appear "
                    "above; retry to try again."
                ),
                "error": (
                    "The model provider reported a stream error before the response "
                    "finished. Retry to try again."
                ),
                "thinking_budget": (
                    "The model spent its entire thinking budget without reaching a final "
                    "answer, so the turn was stopped. Retry, or lower the reasoning effort."
                ),
                "length": (
                    "The model used its entire output budget before producing an answer. "
                    "Retry, or lower the reasoning effort."
                ),
            }[finish_reason]
            status_text = {
                "incomplete": "The model response ended before completion.",
                "error": "The model provider reported a stream error.",
                "thinking_budget": "The model exhausted its thinking budget.",
                "length": "The model exhausted its output budget.",
            }[finish_reason]
            reasoning_text = str(result.thinking_text or "").strip()
            _tl_hub.log_event(
                logger,
                logging.WARNING,
                component="ai.router",
                event="ai.router.stream_terminal_not_clean",
                message="Model generation ended without a clean stream terminal.",
                status="failure",
                data={
                    "finish_reason": finish_reason,
                    "iteration": _iteration,
                    "response_length": len(response_text),
                },
                request_id=request_id,
            )
            self.runtime.audit(
                _tl_hub.KIND_TURN_FAILED,
                summary=(
                    f"stream_{finish_reason} iteration={_iteration} "
                    f"response_length={len(response_text)}"
                ),
            )
            return self._finish(
                _tl_hub.ToolLoopResult(
                    thinking_text=reasoning_text or status_text,
                    thinking_kind=(
                        _tl_hub.CHAT_THINKING_KIND_REASONING
                        if reasoning_text
                        else _tl_hub.CHAT_THINKING_KIND_STATUS
                    ),
                    persist_thinking=bool(reasoning_text),
                    response_text=error_message,
                    approval_request=None,
                    approval_plan=None,
                    outcomes=self.outcomes,
                    usage_totals=self.usage_totals,
                    streamed_event_types=self.streamed_event_types,
                    completion_source="model",
                    terminal_error_code=CMP_STREAM_INCOMPLETE,
                    terminal_subcode=(
                        TERMINAL_SUBCODE_THINKING_BUDGET
                        if finish_reason == "thinking_budget"
                        else None
                    ),
                    terminal_error_retryable=True,
                ),
                reason=f"stream_{finish_reason}",
            )
        if len(raw_content) > _tl_hub.MAX_RESPONSE_CHARS:
            _tl_hub.log_event(
                logger,
                logging.INFO,
                component="ai.router",
                event="ai.router.response_truncated",
                message="Final response text was truncated",
                status="truncated",
                data={
                    "original_length": len(raw_content),
                    "truncated_to": _tl_hub.MAX_RESPONSE_CHARS,
                },
            )
        response_looks_like_fake_tool_use = kernel._should_nudge_tool_use(
            response_text,
            raw_content,
            self.tool_payload,
            tool_statuses=self.tool_statuses,
        )
        explicitly_requested_tools = kernel._explicitly_requested_tool_payload(
            self.latest_user_content,
            self.tool_payload,
        )
        current_info_unavailable_response = _tl_hub._current_info_unavailability_response(
            latest_user_content=self.latest_user_content,
            tool_statuses=self.tool_statuses,
        )

        # -- Current-info unavailability fallback (web search disabled) ----
        if (
            not self.outcomes
            and current_info_unavailable_response is not None
            and response_looks_like_fake_tool_use
        ):
            _tl_hub.log_event(
                logger,
                logging.WARNING,
                component="ai.router",
                event="ai.router.current_info_unavailable_fallback",
                message=(
                    "Current-info request could not execute a live web lookup; "
                    "returning exact unavailability reason instead of pseudo-search text."
                ),
                status="degraded",
                data={"iteration": _iteration},
                request_id=request_id,
            )
            _tl_hub.loop_event_emit.emit_stream_reset_for_retry(
                runtime,
                self.streamed_event_types,
                reason="deterministic_replacement",
            )
            return self._finish(
                _tl_hub.ToolLoopResult(
                    thinking_text="Live web lookup unavailable for this request.",
                    thinking_kind=_tl_hub.CHAT_THINKING_KIND_STATUS,
                    persist_thinking=False,
                    response_text=current_info_unavailable_response,
                    approval_request=None,
                    approval_plan=None,
                    outcomes=self.outcomes,
                    usage_totals=self.usage_totals,
                    streamed_event_types=self.streamed_event_types,
                    completion_source="deterministic_tool_fallback",
                ),
                reason="current_info_unavailable",
            )

        if _tl_hub._should_issue_tool_nudge(
            kernel=kernel,
            mode_policy=self.mode_policy,
            outcomes=self.outcomes,
            response_looks_like_fake_tool_use=(
                response_looks_like_fake_tool_use or bool(explicitly_requested_tools)
            ),
        ):
            if not self.tool_nudge_attempted and _iteration < self.iteration_total:
                self.tool_nudge_attempted = True
                _tl_hub.loop_event_emit.emit_stream_reset_for_retry(
                    runtime,
                    self.streamed_event_types,
                    reason="nudge_retry",
                )
                _tl_hub.log_event(
                    logger,
                    logging.WARNING,
                    component="ai.router",
                    event="ai.router.tool_nudge_issued",
                    message=(
                        "Model did not emit a required structured tool call; "
                        "retrying once with an explicit tool nudge."
                    ),
                    status="retry",
                    data={
                        "iteration": _iteration,
                        "trigger": (
                            "explicit_tool_request"
                            if explicitly_requested_tools
                            else "fake_tool_use"
                        ),
                        "requested_tools": [
                            str((tool.get("function") or tool).get("name") or "")
                            for tool in explicitly_requested_tools
                        ],
                    },
                    request_id=request_id,
                )
                # Point a fake_tool_use nudge at the tools the model actually
                # narrated. Without this the nudge advertises the whole payload
                # and demonstrates tool_payload[0] -- alphabetically
                # ``apply_patch`` -- which a local 27B model copied back as a
                # real patch call carrying the placeholder arguments.
                from sidecar.ai.routing import engine_messages as _engine_messages

                narrated_tools = (
                    []
                    if explicitly_requested_tools
                    else _engine_messages.nudge_trigger_tool_names(
                        response_text,
                        self.tool_payload,
                        tool_statuses=self.tool_statuses,
                    )
                )
                narrated_payload = [
                    tool
                    for tool in self.tool_payload
                    if str((tool.get("function") or tool).get("name") or "").strip().lower()
                    in narrated_tools
                ]
                nudge_payload = explicitly_requested_tools or narrated_payload or self.tool_payload
                self.working_messages.append(
                    {
                        "role": "user",
                        "content": (
                            kernel._build_explicit_tool_use_nudge(nudge_payload)
                            if explicitly_requested_tools
                            else kernel._build_tool_use_nudge(
                                nudge_payload,
                                trigger_tool_names=narrated_tools,
                            )
                        ),
                    }
                )
                return None

            no_retry_capacity = not self.tool_nudge_attempted
            _tl_hub.log_event(
                logger,
                logging.WARNING,
                component="ai.router",
                event=(
                    "ai.router.tool_nudge_skipped_no_capacity"
                    if no_retry_capacity
                    else "ai.router.tool_nudge_fallback"
                ),
                message=(
                    "No tool-capable iteration remained for the required tool retry; "
                    "returning a safe fallback."
                    if no_retry_capacity
                    else (
                        "Model still did not emit the required structured tool call "
                        "after the explicit retry nudge; returning a safe fallback."
                    )
                ),
                status="degraded",
                data={"iteration": _iteration},
                request_id=request_id,
            )
            _tl_hub.loop_event_emit.emit_stream_reset_for_retry(
                runtime,
                self.streamed_event_types,
                reason=("deterministic_replacement" if no_retry_capacity else "nudge_retry"),
            )
            return self._finish(
                _tl_hub.ToolLoopResult(
                    thinking_text="Tool call retry failed; returning a safe fallback.",
                    thinking_kind=_tl_hub.CHAT_THINKING_KIND_STATUS,
                    persist_thinking=False,
                    response_text=_tl_hub.TOOL_NUDGE_FALLBACK_RESPONSE,
                    approval_request=None,
                    approval_plan=None,
                    outcomes=self.outcomes,
                    usage_totals=self.usage_totals,
                    streamed_event_types=self.streamed_event_types,
                    completion_source="deterministic_tool_fallback",
                ),
                reason=(
                    "tool_nudge_no_capacity" if no_retry_capacity else "tool_nudge_fallback"
                ),
            )

        successful_outcome_count = sum(
            1 for outcome in self.outcomes if getattr(outcome, "success", False)
        )
        post_tool_invalid_reason = _tl_hub._post_tool_invalid_response_reason(
            response_text=response_text,
            harness_inventory_invalid=False,
        )
        post_tool_response_invalid = (
            self.outcomes
            and successful_outcome_count > 0
            and bool(post_tool_invalid_reason)
        )
        # -- Unified post-tool recovery ------------------------------------
        # Three triggers share one continuation retry and one deterministic
        # fallback: an invalid restart after successful tools (greeting /
        # empty chat menu / bad harness inventory answer), no visible
        # assistant text after tools, and a response that denies the failed
        # tool-result context it was given. The retry budget
        # (``post_tool_continuation_attempted``) is shared across triggers
        # and requires a spare iteration; the fallback is deterministic text
        # built from this turn's tool outcomes.
        recovery_trigger = ""
        recovery_nudge = _tl_hub._POST_TOOL_CONTINUATION_NUDGE
        fallback_text: str = ""
        if post_tool_response_invalid:
            recovery_trigger = f"invalid_restart:{post_tool_invalid_reason}"
            fallback_text = _tl_hub._successful_tool_context_response(self.outcomes) or ""
        elif self.outcomes and not response_text:
            fallback_text = _tl_hub._empty_post_tool_context_response(self.outcomes) or ""
            if fallback_text:
                recovery_trigger = "empty_after_tools"
        elif response_text:
            fallback_text = (
                _tl_hub._failed_tool_context_response(self.outcomes, response_text) or ""
            )
            if fallback_text:
                recovery_trigger = "ignored_failure_context"
                recovery_nudge = _tl_hub._TOOL_FAILURE_CONTEXT_NUDGE

        if recovery_trigger:
            recovery_log_data = _tl_hub._post_tool_invalid_log_data(
                iteration=_iteration,
                response_text=response_text,
                invalid_reason=post_tool_invalid_reason,
                successful_outcome_count=successful_outcome_count,
                harness_summary_available=False,
                outcome_count=len(self.outcomes),
            )
            recovery_log_data["trigger"] = recovery_trigger
            if (
                not self.post_tool_continuation_attempted
                and _iteration < self.iteration_total
            ):
                self.post_tool_continuation_attempted = True
                _tl_hub.loop_event_emit.emit_stream_reset_for_retry(
                    runtime,
                    self.streamed_event_types,
                    reason="post_tool_restart",
                )
                _tl_hub.log_event(
                    logger,
                    logging.WARNING,
                    component="ai.router",
                    event="ai.router.post_tool_recovery_retry",
                    message=(
                        "Post-tool response needs recovery "
                        f"({recovery_trigger}); retrying once with "
                        "continuation guidance."
                    ),
                    status="retry",
                    data=recovery_log_data,
                    request_id=request_id,
                )
                self.working_messages.append(
                    {"role": "user", "content": recovery_nudge}
                )
                return None
            if fallback_text:
                _tl_hub.loop_event_emit.emit_stream_reset_for_retry(
                    runtime,
                    self.streamed_event_types,
                    reason="deterministic_replacement",
                )
                _tl_hub._emit_deterministic_response_tokens(
                    runtime=runtime,
                    streamed_event_types=self.streamed_event_types,
                    response_text=fallback_text,
                )
                _tl_hub.log_event(
                    logger,
                    logging.WARNING,
                    component="ai.router",
                    event="ai.router.post_tool_recovery_fallback",
                    message=(
                        "Post-tool response still needs recovery after the "
                        f"continuation retry ({recovery_trigger}); returning "
                        "a deterministic tool-context summary."
                    ),
                    status="degraded",
                    data=recovery_log_data,
                    request_id=request_id,
                )
                return self._finish(
                    _tl_hub.ToolLoopResult(
                        thinking_text="Using deterministic tool result context.",
                        thinking_kind=_tl_hub.CHAT_THINKING_KIND_STATUS,
                        persist_thinking=False,
                        response_text=fallback_text,
                        approval_request=None,
                        approval_plan=None,
                        outcomes=self.outcomes,
                        usage_totals=self.usage_totals,
                        streamed_event_types=self.streamed_event_types,
                        completion_source="deterministic_tool_fallback",
                    ),
                    reason=f"post_tool_recovery_fallback:{recovery_trigger}",
                )

        # -- Verification gate (P8b) ---------------------------------------
        # The last thing before the turn settles: the model is about to claim it
        # finished, so this is the moment to check. A retry loops back with the
        # failing verdict on a carve-out iteration; anything else appends one
        # honest sentence and lets the turn complete exactly as it would have.
        gate_decision = self._run_verification_gate(_iteration)
        if gate_decision.retry:
            _tl_hub.loop_event_emit.emit_stream_reset_for_retry(
                runtime,
                self.streamed_event_types,
                reason="verification_gate_retry",
            )
            self.working_messages.append(
                {"role": "user", "content": gate_decision.feedback}
            )
            return None
        if gate_decision.note and response_text:
            response_text = f"{response_text}{gate_decision.note}"
            # The model's answer has already streamed, and chat_decision_render
            # only emits tokens when "chat.token" is absent -- so without a reset
            # the note would land in the persisted turn but never on screen. The
            # reset discards the streamed preview and the full text, note
            # included, is re-emitted; same contract the post-tool deterministic
            # replacement uses.
            _tl_hub.loop_event_emit.emit_stream_reset_for_retry(
                runtime,
                self.streamed_event_types,
                reason="deterministic_replacement",
            )

        if response_text:
            completion_source = (
                "model_winddown" if self.cycle_hint_attempted else "model"
            )
            kernel._log_missing_current_info_tool_use(
                request_id=request_id,
                latest_user_content=self.latest_user_content,
                tool_statuses=self.tool_statuses,
                tool_results=self.outcomes,
            )
            runtime.audit(
                _tl_hub.KIND_TURN_COMPLETED,
                summary=(
                    f"turn_completed chars={len(response_text)} "
                    f"outcomes={len(self.outcomes)}"
                ),
            )
            if str(result.thinking_text or "").strip():
                return self._finish(
                    _tl_hub.ToolLoopResult(
                        thinking_text=str(result.thinking_text).strip(),
                        thinking_kind=_tl_hub.CHAT_THINKING_KIND_REASONING,
                        persist_thinking=True,
                        response_text=response_text,
                        approval_request=None,
                        approval_plan=None,
                        outcomes=self.outcomes,
                        usage_totals=self.usage_totals,
                        streamed_event_types=self.streamed_event_types,
                        completion_source=completion_source,
                    ),
                    reason=(
                        "budget_exhausted"
                        if self.sub_agent_budget_finalization_requested
                        else "final_response_with_reasoning"
                    ),
                )
            return self._finish(
                _tl_hub.ToolLoopResult(
                    thinking_text=self.thinking_text,
                    thinking_kind=_tl_hub.CHAT_THINKING_KIND_STATUS,
                    persist_thinking=False,
                    response_text=response_text,
                    approval_request=None,
                    approval_plan=None,
                    outcomes=self.outcomes,
                    usage_totals=self.usage_totals,
                    streamed_event_types=self.streamed_event_types,
                    completion_source=completion_source,
                ),
                reason=(
                    "budget_exhausted"
                    if self.sub_agent_budget_finalization_requested
                    else "final_response"
                ),
            )

        return None
