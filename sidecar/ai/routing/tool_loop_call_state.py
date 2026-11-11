"""Cycle-state and blocked-call helpers of the tool-call phase (P7).

Split from ``tool_loop_calls.py``: ``_ToolCallPhasesMixin`` inherits this mixin,
so ``_ToolLoopRun`` resolves every helper exactly as before. Host attributes come
from that class; hub names use a function-local import to keep this module's
import fan-out bounded.
"""

from __future__ import annotations

import logging
from dataclasses import replace
from typing import Any

from sidecar.ai.error_codes import CMP_LOOP_INVALID_TOOL_CALL, CMP_TOOL_CAP_EXCEEDED
from sidecar.ai.routing import context_usage_events, tool_loop_cycle_recovery

logger = logging.getLogger("sidecar.ai.routing.tool_loop")


class _ToolCallStateMixin:
    """P7 cycle-state, blocked-call and unknown-call helpers, plus the host-state declarations."""

    # -- Host-state declarations (zero runtime effect) --------------------
    # The concrete host owns these attributes. Annotations and TYPE_CHECKING
    # stubs let mypy check this split module without runtime shadowing.
    runtime: Any
    kernel: Any
    request_context: Any | None
    is_sub_agent_request: bool
    working_messages: list[dict[str, object]]
    tool_contract: Any
    tool_payload: list[dict[str, Any]]
    tool_resolution_context: Any | None
    tool_preferences: dict[str, tuple[str, ...]] | None
    mode_policy: Any
    plan_mode: bool
    read_only: bool
    approvals_pre_granted: bool
    request_id: str
    session_id: str | None
    latest_user_content: str
    prompt_cache_enabled: bool
    cache_source_key: str
    system_prompt: Any
    budget_tracker: Any | None
    feature_flags: dict[str, Any]
    read_snapshot_cache: dict[str, Any]
    tool_statuses: Any
    request_messages_hash: str
    outcomes: list[Any]
    usage_totals: Any | None
    request_disabled_tools: frozenset[str]
    streamed_event_types: set[str]
    last_tool_calls: tuple[Any, ...]
    previous_tool_calls: tuple[Any, ...]
    previous_error_output: str | None
    tool_call_history: tuple[tuple[str, ...], ...]
    error_output_history: tuple[str, ...]
    outcome_index: int
    completed_generations: int
    tool_nudge_attempted: bool
    checkpoint_created: bool
    reflexive_retries_used: dict[str, int]
    pending_retry_response_format: Any | None
    post_tool_continuation_attempted: bool
    sub_agent_report_finalization_requested: bool
    sub_agent_budget_finalization_requested: bool
    cycle_hint_attempted: bool
    current_info_context_injected: bool
    failure_context_outcome_count: int
    failure_context_nudged: bool
    max_iterations: Any
    iteration_base: int
    iteration_total: int
    quota_registry: Any
    current_tool_signatures: tuple[str, ...] | None
    meter_estimate_tokens: int
    missing_status_counter: Any

    # -- Cycle-state and blocked-call helpers -----------------------------
    def _append_failed_tool_context_if_needed(self) -> None:
        import sidecar.ai.routing.tool_loop as _tl_hub

        new_outcomes = self.outcomes[self.failure_context_outcome_count:]
        self.failure_context_outcome_count = len(self.outcomes)
        failed = any(not getattr(o, "success", False) for o in new_outcomes)
        if self.failure_context_nudged or not failed:  # one row per turn
            return
        self.failure_context_nudged = True
        # Non-leading system row: template-based local engine builders demote it to
        # user (local_engine/messages.py); system-first GGUF templates reject it otherwise.
        self.working_messages.append(
            {"role": "system", "content": _tl_hub._TOOL_FAILURE_CONTEXT_NUDGE}
        )

    def _record_blocked_tool_calls(
        self,
        blocked_calls: tuple[Any, ...],
        result: Any,
    ) -> tuple[Any, ...]:
        import sidecar.ai.routing.tool_loop as _tl_hub

        if not blocked_calls:
            return ()
        from sidecar.ai.routing.router import ToolExecutionOutcome

        emitted_calls: list[Any] = []
        for group in _tl_hub._quota_blocked_groups(blocked_calls):
            summarize_group = len(group) > _tl_hub._TOOL_BURST_SUMMARY_THRESHOLD
            blocked = group[0]
            call = blocked.call
            self.outcome_index += 1
            metadata = dict(blocked.metadata)
            metadata["quota_blocked"] = True
            cap_value = blocked.metadata.get("cap")
            blocked_cap = cap_value if isinstance(cap_value, int) else 0
            guidance = _tl_hub._quota_block_guidance(blocked.reason, blocked_cap)
            if summarize_group:
                group_calls = [entry.call for entry in group]
                preview_call_ids, omitted_call_ids = _tl_hub._call_id_preview(group_calls)
                metadata["summarized_blocked_count"] = len(group)
                metadata["summarized_call_ids"] = preview_call_ids
                metadata["summarized_call_ids_omitted"] = omitted_call_ids
                output = (
                    f"Tool '{call.tool_id}' was not run for {len(group)} requested "
                    f"call(s): {guidance} The repeated blocked calls were summarized to "
                    "keep the turn bounded."
                )
                _tl_hub.log_event(
                    logger,
                    logging.WARNING,
                    component="ai.router",
                    event="ai.router.tool_quota_burst_summarized",
                    message="Summarized repeated quota-blocked tool calls.",
                    status="degraded",
                    data={
                        "tool": call.tool_id,
                        "quota_scope": str(metadata.get("quota_scope") or blocked.reason),
                        "summarized_count": len(group),
                        "call_ids_omitted": omitted_call_ids,
                    },
                    request_id=self.request_id,
                    session_id=self.session_id,
                )
            else:
                output = f"Tool '{call.tool_id}' was not run: {guidance}"
            tool_result = ToolExecutionOutcome(
                tool_name=call.tool_id,
                output=output,
                success=False,
                tool_input=_tl_hub._visible_tool_input(call),
                error_code=CMP_TOOL_CAP_EXCEEDED,
                metadata=metadata,
                call_id=call.call_id,
            )
            self.outcomes.append(tool_result)
            call_id = _tl_hub.loop_event_emit.emit_tool_executing(
                self.runtime,
                call,
                self.request_id,
                self.outcome_index,
            )
            _tl_hub.loop_event_emit.emit_tool_result(self.runtime, tool_result, call_id)
            if self.runtime.streaming:
                self.streamed_event_types.add("tool.executing")
                self.streamed_event_types.add("tool.result")
            self.working_messages.append(
                self.kernel._assistant_tool_call_message(result, call)
            )
            self.working_messages.append(self.kernel._tool_result_message(call, tool_result))
            emitted_calls.append(call)
        return tuple(emitted_calls)

    def _refund_failed_web_outcomes(
        self,
        start_index: int,
        *,
        tool_contract: Any | None,
    ) -> None:
        """Release the per-turn web budget for web/browser calls that failed.

        ``filter_calls`` consumes a web slot up-front, before the tool runs. Any
        web/browser outcome appended since ``start_index`` that did not succeed produced
        no usable web work, so its slot is released and only successful web calls count
        toward ``web_per_turn``. No-op when resource discipline is disabled.
        """
        if self.quota_registry is None:
            return
        for outcome in self.outcomes[start_index:]:
            if not getattr(outcome, "success", False):
                self.quota_registry.refund_web_call_for_outcome(
                    outcome,
                    tool_contract=tool_contract,
                )

    def _advance_cycle_history(
        self,
        history: tuple[tuple[str, ...], ...],
        errors: tuple[str, ...],
        new_last_tool_calls: tuple[Any, ...],
        new_error_output: str | None,
        new_outcomes: list[Any] | tuple[Any, ...] = (),
    ) -> tuple[tuple[tuple[str, ...], ...], tuple[str, ...]]:
        import sidecar.ai.routing.tool_loop as _tl_hub

        result_aware = _tl_hub.is_default_on_flag_enabled(
            getattr(self, "feature_flags", {}), _tl_hub.FEATURE_LOOP_RESULT_AWARE_SIGNATURE,
        )
        return _tl_hub.advance_cycle_history(
            self, history, errors, new_last_tool_calls, new_error_output, new_outcomes,
            result_aware=result_aware,
        )

    def _apply_cycle_hint(
        self,
        stop_reason: Any,
        iteration: int,
        *,
        reset_visible_text: bool,
    ) -> None:
        import sidecar.ai.routing.tool_loop as _tl_hub

        self.cycle_hint_attempted = True
        self.cycle_recovery_phase = "discover"
        self.cycle_recovery_baseline_undeferred = frozenset(
            getattr(self.tool_resolution_context, "un_deferred_names", set())
        )
        _tl_hub.heuristic_fires.append_cycle_hint(self, stop_reason)
        _tl_hub.log_event(
            logger,
            logging.WARNING,
            component="ai.router",
            event="ai.router.cycle_hint_issued",
            message=(
                "Cycle detected; injecting a recovery hint and limiting the "
                "next iteration to tool discovery."
            ),
            status="retry",
            data={"iteration": iteration, "code": stop_reason.code},
            request_id=self.request_id,
        )
        if reset_visible_text:
            _tl_hub.loop_event_emit.emit_stream_reset_for_retry(
                self.runtime,
                self.streamed_event_types,
                reason="model_winddown",
            )
        else:
            _tl_hub.loop_event_emit.reset_streamed_text_bookkeeping(
                self.streamed_event_types
            )
        _tl_hub.tool_loop_recovery.emit_degradation_status(
            self,
            text="Pausing tool use except for one bounded discovery recovery.",
            event="ai.router.cycle_hint_status",
            data={"iteration": iteration, "code": stop_reason.code},
        )
        self.tool_payload = []
        self.last_tool_calls = ()
        self.previous_tool_calls = ()
        self.previous_error_output = None
        self.tool_call_history = ()
        self.current_tool_signatures = None
        self.error_output_history = ()

    def _cycle_recovery_generation_payload(self) -> list[dict[str, Any]]:
        return tool_loop_cycle_recovery.discovery_generation_payload(
            self.cycle_recovery_phase,
            self.tool_payload,
            self.tool_contract,
        )

    def _next_cycle_recovery_payload(
        self,
        tool_contract: Any,
        outcomes: list[Any],
    ) -> list[dict[str, Any]]:
        if not self.cycle_hint_attempted:
            return list(tool_contract.prompt_schemas)
        self.cycle_recovery_phase, payload = (
            tool_loop_cycle_recovery.next_recovery_payload(
                phase=self.cycle_recovery_phase,
                resolution_context=self.tool_resolution_context,
                baseline_undeferred=self.cycle_recovery_baseline_undeferred,
                tool_contract=tool_contract,
                outcomes=outcomes,
            )
        )
        return payload

    def _retire_repeated_missing_status_tools(self) -> frozenset[str]:
        resolution_context = self.tool_resolution_context
        if resolution_context is None:
            return frozenset()
        retired = self.missing_status_counter.retired(self.outcomes)
        if not retired:
            return frozenset()
        resolution_context.un_deferred_names.difference_update(retired)
        resolution_context.budget_filtered_names |= retired
        resolution_context.retired_names |= retired
        import sidecar.ai.routing.tool_loop as _tl_hub

        _tl_hub.log_event(
            logger,
            logging.WARNING,
            component="ai.router",
            event="ai.router.repeated_missing_status_tool_retired",
            message="A repeatedly missing status tool was removed from this turn.",
            status="degraded",
            data={"tool_names": sorted(retired)},
            request_id=self.request_id,
            session_id=self.session_id,
        )
        return retired

    def _emit_iteration_context_usage(
        self,
        *,
        iteration: int,
        result: Any,
        current_context_tokens: int,
    ) -> None:
        """Publish this iteration's context reading to the composer ring.

        Ephemeral meter hint only (see ``context_usage_events``): guarded on a
        live budget tracker, deduplicated per request, and never journaled. The
        provider-truth half is the most recent request's prompt size —
        ``last_request_input_tokens`` when the engine reports it, otherwise the
        merged ``input_tokens`` total.
        """
        usage = getattr(result, "usage", None)
        provider_tokens = (
            getattr(usage, "last_request_input_tokens", 0) or getattr(usage, "input_tokens", 0) or 0
        )
        # The plain message estimate (context.preview's units), never the measured rescale.
        estimate = self.meter_estimate_tokens or current_context_tokens
        context_usage_events.emit_context_usage(
            self.runtime,
            phase=context_usage_events.PHASE_ITERATION,
            iteration=iteration,
            budget_tracker=self.budget_tracker,
            feature_flags=self.feature_flags,
            config=self.kernel._config,
            engine=self.kernel._engine,
            context_tokens_estimate=estimate,
            last_request_input_tokens=provider_tokens,
        )

    def _record_unknown_tool_calls(
        self,
        result: Any,
        valid_tool_calls: Any,
        unknown_tool_calls: Any,
        *,
        iteration: int,
        last_error_output: str | None,
    ) -> tuple[Any, bool]:
        """Record unknown model tool calls as failed outcomes, keeping the valid ones.

        Returns ``(result, all_invalid)``: the result narrowed to the valid calls, or
        ``all_invalid`` when none is left and the all-blocked tail already ran.
        """
        import sidecar.ai.routing.tool_loop as _tl_hub
        from sidecar.ai.routing import iteration_limits as _iteration_limits
        from sidecar.ai.routing.router import ToolExecutionOutcome

        runtime = self.runtime
        kernel = self.kernel
        request_id = self.request_id
        session_id = self.session_id
        max_tool_results = max(
            1, _iteration_limits.effective_max_tools_per_turn(kernel._config)
        )
        invalid_recovery_cap = max(0, max_tool_results - len(valid_tool_calls))
        unknown_tool_calls_to_emit = unknown_tool_calls[:invalid_recovery_cap]
        skipped_unknown_tool_calls = unknown_tool_calls[invalid_recovery_cap:]
        unknown_tool_preview, unknown_tool_omitted = _tl_hub._tool_id_log_preview(
            unknown_tool_calls
        )
        valid_tool_preview, valid_tool_omitted = _tl_hub._tool_id_log_preview(
            valid_tool_calls
        )
        _tl_hub.log_event(
            logger,
            logging.WARNING,
            component="ai.router",
            event="ai.router.unknown_tool_recovery",
            message="Recovered unknown model tool calls without poisoning valid calls.",
            status="recovered",
            data={
                "tool_calls": unknown_tool_preview,
                "tool_calls_omitted": unknown_tool_omitted,
                "valid_tool_calls": valid_tool_preview,
                "valid_tool_calls_omitted": valid_tool_omitted,
                "iteration": iteration,
                "request_id": request_id,
                "valid_tool_call_count": len(valid_tool_calls),
                "invalid_recovery_cap": invalid_recovery_cap,
                "emitted_invalid_count": len(unknown_tool_calls_to_emit),
                "skipped_invalid_count": len(skipped_unknown_tool_calls),
            },
            request_id=request_id,
            session_id=session_id,
        )
        if skipped_unknown_tool_calls:
            skipped_tool_preview, skipped_tool_omitted = _tl_hub._tool_id_log_preview(
                skipped_unknown_tool_calls
            )
            _tl_hub.log_event(
                logger,
                logging.WARNING,
                component="ai.router",
                event="ai.router.unknown_tool_cap_exceeded",
                message="Capped invalid model tool-call recovery events.",
                status="truncated",
                data={
                    "requested": len(unknown_tool_calls),
                    "cap": invalid_recovery_cap,
                    "valid_tool_call_count": len(valid_tool_calls),
                    "skipped_count": len(skipped_unknown_tool_calls),
                    "skipped_tools": skipped_tool_preview,
                    "skipped_tools_omitted": skipped_tool_omitted,
                },
                request_id=request_id,
                session_id=session_id,
            )
            _tl_hub.tool_loop_recovery.emit_degradation_status(
                self,
                text=(
                    f"Skipped {len(skipped_unknown_tool_calls)} unrecognized "
                    "tool call(s) that exceeded this turn's recovery budget."
                ),
                event="ai.router.unknown_tool_cap_status",
                data={
                    "skipped_count": len(skipped_unknown_tool_calls),
                    "cap": invalid_recovery_cap,
                },
            )
        for call, message in unknown_tool_calls_to_emit:
            self.outcome_index += 1
            tool_result = ToolExecutionOutcome(
                tool_name=call.tool_id,
                output=_tl_hub._invalid_tool_output(message, self.tool_contract),
                success=False,
                tool_input=_tl_hub._visible_tool_input(call),
                error_code=CMP_LOOP_INVALID_TOOL_CALL,
                metadata={"invalid_tool_call": True},
                call_id=call.call_id,
            )
            self.outcomes.append(tool_result)
            call_id = _tl_hub.loop_event_emit.emit_tool_executing(
                runtime, call, request_id, self.outcome_index
            )
            _tl_hub.loop_event_emit.emit_tool_result(runtime, tool_result, call_id)
            if runtime.streaming:
                self.streamed_event_types.add("tool.executing")
                self.streamed_event_types.add("tool.result")
            self.working_messages.append(kernel._assistant_tool_call_message(result, call))
            self.working_messages.append(kernel._tool_result_message(call, tool_result))
        if not valid_tool_calls:
            _tl_hub.tool_loop_recovery.finish_all_blocked_iteration(
                self,
                tuple(call for call, _message in unknown_tool_calls_to_emit),
                last_error_output,
            )
            return result, True
        return replace(result, tool_calls=valid_tool_calls), False
