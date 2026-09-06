"""Tool-call phase (P7), mixed into ``_ToolLoopRun``.

Host attributes come from that class; hub names use a function-local import to
keep this module's import fan-out bounded.
"""

from __future__ import annotations

import logging
from dataclasses import replace
from typing import TYPE_CHECKING, Any

from sidecar.ai.error_codes import (
    CMP_LOOP_INVALID_TOOL_CALL,
    CMP_MODE_TOOL_BLOCKED,
    CMP_TOOL_CAP_EXCEEDED,
    CMP_TOOL_DISABLED,
)
from sidecar.ai.routing import (
    context_usage_events,
    plan_mode_transition,
    tool_loop_cycle_recovery,
)

logger = logging.getLogger("sidecar.ai.routing.tool_loop")


class _ToolCallPhasesMixin:
    """P7: the tool-call branch of the loop, plus its cycle-state helpers."""

    def _apply_plan_mode_transition(self, outcomes: list[Any]) -> bool:
        was_plan_mode = bool(getattr(self.request_context, "plan_mode", False))
        transitioned = plan_mode_transition.transition_after_exit_outcome(
            request_context=self.request_context,
            outcomes=outcomes,
            working_messages=self.working_messages,
        )
        if transitioned is self.request_context:
            return False
        self.request_context = transitioned
        self.plan_mode = transitioned.plan_mode
        self.read_only = transitioned.read_only
        self.approvals_pre_granted = False
        return was_plan_mode and not transitioned.plan_mode

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
    reflexive_retry_attempted: bool
    pending_retry_response_format: Any | None
    post_tool_continuation_attempted: bool
    sub_agent_report_finalization_requested: bool
    sub_agent_budget_finalization_requested: bool
    cycle_hint_attempted: bool
    current_info_context_injected: bool
    failure_context_outcome_count: int
    max_iterations: Any
    iteration_base: int
    iteration_total: int
    quota_registry: Any

    if TYPE_CHECKING:
        # Hub-owned methods (defined on ``_ToolLoopRun`` in tool_loop_run.py).
        # Never executed -- ``TYPE_CHECKING`` is False at runtime -- so these
        # cannot shadow the hub's real implementations.
        def _finish(self, loop_result: Any, *, reason: str) -> Any: ...

        def _settle_unfinished_tool_results(self, reason: str) -> int: ...

    def _request_sub_agent_budget_finalization(
        self,
        *,
        iteration: int,
        next_tool_contract: Any,
        next_tool_payload: list[dict[str, Any]],
    ) -> bool:
        """Reserve the next child iteration for a constrained terminal report."""
        import sidecar.ai.routing.tool_loop as _tl_hub

        if (
            not self.is_sub_agent_request
            or iteration >= self.iteration_total
            or self.sub_agent_report_finalization_requested
        ):
            return False
        self.sub_agent_report_finalization_requested = True
        self.sub_agent_budget_finalization_requested = True
        self.tool_contract = next_tool_contract
        self.tool_payload = next_tool_payload
        self.tool_statuses = next_tool_contract.status_entries
        _tl_hub.loop_event_emit.emit_stream_reset_for_retry(
            self.runtime,
            self.streamed_event_types,
            reason="deterministic_replacement",
        )
        _tl_hub.log_event(
            logger,
            logging.WARNING,
            component="ai.router",
            event="ai.router.subagent_budget_finalization_requested",
            message=(
                "Sub-agent work budget ended; using the reserved iteration for "
                "a constrained terminal report."
            ),
            status="retry",
            data={
                "iteration": iteration,
                "max_iterations": self.iteration_total,
                "outcome_count": len(self.outcomes),
            },
            request_id=self.request_id,
            session_id=self.session_id,
        )
        return True

    def _handle_final_response(self, result: Any, _iteration: int) -> Any | None:
        """Wind down an empty post-tool completion before normal finalization."""
        import sidecar.ai.routing.tool_loop as _tl_hub

        cap_final = _tl_hub.tool_loop_recovery.maybe_wind_down_tool_cap_final
        if tool_cap_result := cap_final(self, result):
            return tool_cap_result
        if (
            self.outcomes
            and not str(result.content or "").strip()
            and not self.post_tool_continuation_attempted
            and _iteration < self.iteration_total
        ):
            return _tl_hub.tool_loop_recovery.empty_final_wind_down(self)
        return super()._handle_final_response(result, _iteration)  # type: ignore[misc]

    # -- Closure conversions (910-1090) -----------------------------------

    def _append_failed_tool_context_if_needed(self) -> None:
        import sidecar.ai.routing.tool_loop as _tl_hub

        new_outcomes = self.outcomes[self.failure_context_outcome_count:]
        self.failure_context_outcome_count = len(self.outcomes)
        if not any(not getattr(outcome, "success", False) for outcome in new_outcomes):
            return
        # Appended after the conversation history -> a NON-leading system
        # message. Safe only because every template-based local engine builder
        # runs demote_non_leading_system_messages (sidecar/runtime/local_engine/
        # messages.py) before dispatch; without it, system-first GGUF templates
        # (e.g. ornith:9b-48k) reject the request with HTTP 400.
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

    @staticmethod
    def _advance_cycle_history(
        history: tuple[tuple[str, ...], ...],
        errors: tuple[str, ...],
        new_last_tool_calls: tuple[Any, ...],
        new_error_output: str | None,
    ) -> tuple[tuple[tuple[str, ...], ...], tuple[str, ...]]:
        import sidecar.ai.routing.tool_loop as _tl_hub

        if new_last_tool_calls:
            signature_entry = tuple(
                _tl_hub._tool_call_signature(call) for call in new_last_tool_calls
            )
            history = (*history, signature_entry)[-_tl_hub.CYCLE_HISTORY_DEPTH:]
        if new_error_output is not None:
            errors = (*errors, new_error_output)[-_tl_hub.CYCLE_HISTORY_DEPTH:]
        return history, errors

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
        self.working_messages.append({"role": "system", "content": stop_reason.user_hint})
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
        retired = tool_loop_cycle_recovery.repeated_missing_status_tools(self.outcomes)
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
        live budget tracker plus the ``context_usage_live`` flag, deduplicated
        per request, and never journaled. The provider-truth half is the most
        recent request's prompt size — ``last_request_input_tokens`` when the
        engine reports it, otherwise the merged ``input_tokens`` total.
        """
        usage = getattr(result, "usage", None)
        provider_tokens = 0
        if usage is not None:
            provider_tokens = (
                getattr(usage, "last_request_input_tokens", 0)
                or getattr(usage, "input_tokens", 0)
                or 0
            )
        context_usage_events.emit_context_usage(
            self.runtime,
            phase=context_usage_events.PHASE_ITERATION,
            iteration=iteration,
            budget_tracker=self.budget_tracker,
            feature_flags=self.feature_flags,
            config=self.kernel._config,
            engine=self.kernel._engine,
            context_tokens_estimate=current_context_tokens,
            last_request_input_tokens=provider_tokens,
        )

    # -- P7: tool-call branch (1303-1999) ---------------------------------

    def _handle_tool_calls(  # noqa: C901, PLR0911, PLR0912, PLR0915
        self,
        result: Any,
        _iteration: int,
        last_error_output: str | None,
    ) -> Any | None:
        import sidecar.ai.routing.tool_loop as _tl_hub

        runtime = self.runtime
        kernel = self.kernel
        request_id = self.request_id
        session_id = self.session_id

        result, canonicalization_blocked = (
            _tl_hub.tool_loop_recovery.canonicalize_tool_call_batch(
                self, result, last_error_output=last_error_output
            )
        )
        if canonicalization_blocked:
            return None
        for _requested in result.tool_calls:
            runtime.audit(
                _tl_hub.KIND_MODEL_TOOL_REQUESTED,
                tool_call_id=str(_requested.call_id or ""),
                tool_name=str(_requested.tool_id or ""),
                summary=f"model_tool_requested {_requested.tool_id}",
            )
        if result.tool_calls:
            from sidecar.ai.routing import tool_call_retry as _reliability

            _reliability.record_parse_success(kernel)
        if not self.mode_policy.allow_tools or not kernel._config.tools_enabled:
            # Turn-survival: the model called tools while a whole-batch gate
            # disallows them. Record recoverable failures and continue to a
            # graceful final response instead of raising a turn-killing error.
            _recovery = _tl_hub.tool_loop_recovery

            if not self.mode_policy.allow_tools:
                gate_code = CMP_MODE_TOOL_BLOCKED
                gate_reason = (
                    f"tool execution is disabled in '{self.mode_policy.mode}' mode."
                )
            else:
                gate_code = CMP_TOOL_DISABLED
                gate_reason = "tools are disabled by configuration."
            _recovery.record_batch_gate_block(
                self,
                result,
                error_code=gate_code,
                reason=gate_reason,
                last_error_output=last_error_output,
            )
            return None

        # -- Phase 5 route policy (gated native tools with fallback) ----
        _route_apply, self.outcome_index = _tl_hub.apply_route_policy_pre_dispatch(
            kernel=kernel,
            runtime=runtime,
            result=result,
            request_id=request_id,
            outcome_index=self.outcome_index,
            outcomes=self.outcomes,
            working_messages=self.working_messages,
            streamed_event_types=self.streamed_event_types,
            emit_tool_executing=_tl_hub.loop_event_emit.emit_tool_executing,
            emit_tool_result=_tl_hub.loop_event_emit.emit_tool_result,
            tool_payload=self.tool_payload,
            tool_contract=self.tool_contract,
        )
        result = _route_apply.result
        if _route_apply.blocked:
            self.last_tool_calls = result.tool_calls
            self._append_failed_tool_context_if_needed()
            self.tool_call_history, self.error_output_history = self._advance_cycle_history(
                self.tool_call_history, self.error_output_history, self.last_tool_calls, None,
            )
            return None

        valid_tool_calls, unknown_tool_calls = _tl_hub._partition_unknown_tool_calls(
            kernel,
            result.tool_calls,
            tool_resolution_context=self.tool_resolution_context,
            tool_contract=self.tool_contract,
            request_disabled_tools=self.request_disabled_tools,
        )
        if unknown_tool_calls:
            from sidecar.ai.routing import iteration_limits as _iteration_limits
            from sidecar.ai.routing.router import ToolExecutionOutcome

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
                    "iteration": _iteration,
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
                return None
            result = replace(result, tool_calls=valid_tool_calls)

        if self.quota_registry is not None and result.tool_calls:
            quota_decision = self.quota_registry.filter_calls(
                result.tool_calls,
                tool_contract=self.tool_contract,
            )
            if quota_decision.blocked:
                _tl_hub.log_event(
                    logger,
                    logging.WARNING,
                    component="ai.router",
                    event="ai.router.tool_quota_blocked",
                    message="Blocked model tool calls by resource discipline quota.",
                    status="blocked",
                    data={
                        "blocked_count": len(quota_decision.blocked),
                        "allowed_count": len(quota_decision.allowed),
                        "quota_scopes": sorted(
                            {
                                str(blocked.metadata.get("quota_scope") or "")
                                for blocked in quota_decision.blocked
                            }
                        ),
                    },
                    request_id=request_id,
                    session_id=session_id,
                )
                emitted_blocked_calls = self._record_blocked_tool_calls(
                    quota_decision.blocked,
                    result,
                )
                if not quota_decision.allowed:
                    _tl_hub.tool_loop_recovery.finish_all_blocked_iteration(
                        self,
                        emitted_blocked_calls,
                        last_error_output,
                    )
                    return None
                result = replace(result, tool_calls=quota_decision.allowed)

        # Record the outcomes length BEFORE this iteration's tool phase so failed
        # web/browser calls can refund the per-turn web slot they consumed up-front in
        # filter_calls (only successful web work should count toward web_per_turn).
        # MUST stay AFTER the quota-block append above: quota-blocked outcomes were
        # never counted by _record_allowed, so they must be outside the refund slice.
        outcomes_len_before_tool_phase = len(self.outcomes)

        policy_filter = kernel._filter_tool_calls_by_policy(
            result.tool_calls,
            mode=self.mode_policy.mode,
            mode_allows_side_effecting=self.mode_policy.allow_side_effecting_tools,
            resolution_context=self.tool_resolution_context,
            tool_contract=self.tool_contract,
            plan_mode=self.plan_mode,
            read_only=self.read_only,
            request_disabled_tools=self.request_disabled_tools,
        )
        audit_metadata_by_call = policy_filter.audit_metadata_by_call
        if policy_filter.denied:
            _tl_hub.log_event(
                logger,
                logging.WARNING,
                component="ai.router",
                event="ai.router.tool_policy_denied",
                message="Blocked model tool calls by tool permission policy.",
                status="blocked",
                data={
                    "blocked_count": len(policy_filter.denied),
                    "allowed_count": len(policy_filter.allowed),
                    "matched_rule_ids": _tl_hub._policy_denied_matched_rule_ids(
                        policy_filter.denied
                    ),
                },
                request_id=request_id,
                session_id=session_id,
            )
            _tl_hub.tool_loop_recovery.record_policy_denied_tool_calls(
                self, policy_filter.denied, result
            )
            if not policy_filter.allowed:
                _tl_hub.tool_loop_recovery.finish_all_blocked_iteration(
                    self,
                    tuple(denied.call for denied in policy_filter.denied),
                    last_error_output,
                )
                self._refund_failed_web_outcomes(
                    outcomes_len_before_tool_phase,
                    tool_contract=self.tool_contract,
                )
                return None
            result = replace(result, tool_calls=policy_filter.allowed)

        _recovery = _tl_hub.tool_loop_recovery
        result, budget_exhausted = _recovery.admit_tool_calls_for_turn(
            self,
            result,
            last_error_output=last_error_output,
        )
        if budget_exhausted:
            return None
        calls_before_approval = result.tool_calls
        approval, result = _recovery.approval_with_recovery(
            self,
            result,
            policy_decisions_by_call=policy_filter.decisions_by_call,
        )
        if not result.tool_calls:
            # Every call was blocked pre-dispatch and recorded as a
            # recoverable failure; finish the iteration so the model can
            # react to the failure context on its next generation.
            _recovery.finish_all_blocked_iteration(
                self,
                tuple(calls_before_approval),
                last_error_output,
            )
            self._refund_failed_web_outcomes(
                outcomes_len_before_tool_phase,
                tool_contract=self.tool_contract,
            )
            return None
        if approval is not None:
            runtime.audit(
                _tl_hub.KIND_USER_APPROVAL_REQUESTED,
                tool_call_id=str(getattr(approval, "tool_call_id", "") or ""),
                summary="user_approval_requested",
            )
            runtime.raise_if_cancelled()
            approval_tool_calls = _tl_hub._bind_missing_approval_call_id(
                result.tool_calls,
                approval.tool_call_id,
            )
            approval_result = (
                replace(result, tool_calls=approval_tool_calls)
                if approval_tool_calls != result.tool_calls
                else result
            )
            frozen_inputs = tuple(
                kernel._freeze_effective_execution_inputs(
                    call,
                    session_id=session_id,
                    read_snapshot_cache=self.read_snapshot_cache,
                    tool_contract=self.tool_contract,
                    plan_mode=self.plan_mode,
                    read_only=self.read_only,
                )
                for call in approval_tool_calls
            )
            approval_plan = _tl_hub.build_approval_plan(
                approved_call_id=str(approval.tool_call_id or "").strip(),
                request_context=self.request_context,
                latest_user_content=self.latest_user_content,
                request_messages_hash=(
                    str(self.request_messages_hash or "").strip()
                    or _tl_hub.build_message_history_hash(self.working_messages)
                ),
                working_messages=self.working_messages,
                generation_result=approval_result,
                tool_calls=approval_tool_calls,
                frozen_inputs=frozen_inputs,
                tool_contract=self.tool_contract,
                tool_resolution_context=self.tool_resolution_context,
                read_snapshot_cache=self.read_snapshot_cache,
                outcomes=tuple(self.outcomes),
                usage_totals=self.usage_totals,
                streamed_event_types=frozenset(self.streamed_event_types),
                system_prompt=self.system_prompt,
                prompt_cache_enabled=self.prompt_cache_enabled,
                cache_source_key=self.cache_source_key,
                remaining_iterations=max(self.iteration_total - _iteration, 0),
                completed_iterations=_iteration,
                wall_clock_deadline=runtime.wall_clock_deadline,
                tool_call_limit=runtime.tool_call_limit or 0,
                remaining_tool_calls=runtime.remaining_tool_calls,
                tool_payload=self.tool_payload,
                tool_statuses=self.tool_statuses,
                parent_approval_plan_hash=getattr(
                    self.request_context,
                    "parent_approval_plan_hash",
                    "",
                ),
                config=kernel._config,
                engine=kernel._engine,
                resolved_max_tokens=_tl_hub.resolve_effective_max_tokens(
                    kernel._config.max_tokens,
                    kernel._engine.get_model_max_output_tokens(),
                    user_override=getattr(kernel._config, "resolved_user_max_output_tokens", None),
                ),
            )
            return _tl_hub.ToolLoopResult(
                thinking_text=None,
                thinking_kind=_tl_hub.CHAT_THINKING_KIND_STATUS,
                persist_thinking=False,
                response_text="",
                approval_request=approval,
                approval_plan=approval_plan,
                outcomes=self.outcomes,
                usage_totals=self.usage_totals,
                streamed_event_types=self.streamed_event_types,
            )

        tool_calls_to_execute = result.tool_calls

        iteration_calls: list[Any] = []
        if tool_calls_to_execute:
            _tl_hub.loop_event_emit.pre_dispatch_emit_executing(
                runtime=runtime,
                tool_calls=tool_calls_to_execute,
                request_id=request_id,
            )
            if runtime.streaming:
                self.streamed_event_types.add("tool.executing")

        # -- Pre-filter deferred / coerced calls (shared) -----------
        from sidecar.ai.routing.tool_call_execution import (
            execute_tool_calls_sequentially,
            pre_filter_tool_calls,
        )

        _remaining, self.outcome_index = pre_filter_tool_calls(
            tool_calls_to_execute,
            kernel=kernel,
            runtime=runtime,
            result=result,
            request_id=request_id,
            tool_resolution_context=self.tool_resolution_context,
            tool_contract=self.tool_contract,
            plan_mode=self.plan_mode,
            read_only=self.read_only,
            request_disabled_tools=self.request_disabled_tools,
            session_id=session_id,
            outcomes=self.outcomes,
            working_messages=self.working_messages,
            iteration_calls=iteration_calls,
            streamed_event_types=self.streamed_event_types,
            outcome_index=self.outcome_index,
        )

        # Auto-checkpoint immediately before the canonical in-order dispatcher.
        _tl_hub.maybe_create_auto_checkpoint(self, _remaining)

        if _remaining:
            try:
                execute_tool_calls_sequentially(
                    indexed_calls=_remaining,
                    runtime=runtime,
                    kernel=kernel,
                    result=result,
                    request_id=request_id,
                    session_id=session_id,
                    tool_resolution_context=self.tool_resolution_context,
                    tool_contract=self.tool_contract,
                    read_snapshot_cache=self.read_snapshot_cache,
                    outcomes=self.outcomes,
                    working_messages=self.working_messages,
                    iteration_calls=iteration_calls,
                    streamed_event_types=self.streamed_event_types,
                    tool_payload_ref=self.tool_payload,
                    tool_preferences=self.tool_preferences,
                    request_context=self.request_context,
                    audit_metadata_by_call=audit_metadata_by_call,
                )
            except Exception:  # noqa: BLE001 - pair any pre-dispatch event before re-raising
                self._settle_unfinished_tool_results("sequential_execution_interrupted")
                raise

        self._refund_failed_web_outcomes(
            outcomes_len_before_tool_phase,
            tool_contract=self.tool_contract,
        )

        plan_mode_exited = self._apply_plan_mode_transition(
            self.outcomes[outcomes_len_before_tool_phase:])

        self._append_failed_tool_context_if_needed()

        if (
            runtime.streaming
            and "chat.token" in self.streamed_event_types
            and str(result.content or "").strip()
        ):
            # tool_continuation: the model streamed visible preamble before a
            # real tool call and the loop is continuing -- this is the ONLY
            # reset the Electron capture path preserves (genuine commentary).
            _tl_hub.loop_event_emit.emit_stream_reset_for_retry(
                runtime,
                self.streamed_event_types,
                reason="tool_continuation",
            )

        from sidecar.ai.routing import tool_call_retry as _reflexive_b
        _did_retry_b, _pending_b = _reflexive_b.run_reflexive_retry(
            kernel=kernel, inband_tool_call_parse_failed=False, surviving_calls=(),
            validation_errors=_reflexive_b.collect_validation_errors(
                self.outcomes[outcomes_len_before_tool_phase:]),
            tool_payload=self.tool_payload, working_messages=self.working_messages,
            already_retried=self.reflexive_retry_attempted, request_id=request_id,
            session_id=session_id, emit_reliability_event=True)
        if _did_retry_b:
            self.reflexive_retry_attempted = True
            self.pending_retry_response_format = _pending_b

        # -- Update cycle-detection state -----------------------------
        iteration_error_output = None
        if self.outcomes and not self.outcomes[-1].success:
            iteration_error_output = str(self.outcomes[-1].output)
        self.previous_error_output = last_error_output
        self.previous_tool_calls = self.last_tool_calls
        self.last_tool_calls = tuple(iteration_calls)
        self.tool_call_history, self.error_output_history = self._advance_cycle_history(
            self.tool_call_history,
            self.error_output_history,
            self.last_tool_calls,
            iteration_error_output,
        )

        retired_status_tools = self._retire_repeated_missing_status_tools()
        next_tool_contract = kernel._assemble_tool_contract(
            request_context=self.request_context,
            resolution_context=self.tool_resolution_context,
        )
        if plan_mode_exited:
            plan_mode_transition.apply_restored_tool_contract(
                working_messages=self.working_messages,
                tool_statuses=next_tool_contract.status_entries,
            )
        if retired_status_tools and self.tool_resolution_context is not None:
            from sidecar.ai.tools.tool_search import build_search_index

            self.tool_resolution_context.search_index = build_search_index(
                self.tool_resolution_context.remaining_unexposed_names(),
                next_tool_contract.filtered_descriptors,
            )
        # A cycle gets one discovery iteration and, only when discovery succeeds,
        # one execution iteration for the newly promoted tools. Ordinary schemas
        # never silently reappear after the hint.
        next_tool_payload = (
            self._next_cycle_recovery_payload(
                next_tool_contract,
                self.outcomes[outcomes_len_before_tool_phase:],
            )
            if runtime.remaining_tool_calls > 0
            else []
        )

        if self.budget_tracker is not None:
            # tool_search can promote deferred entries to full schemas between
            # iterations. Charge the prospective payload before deciding
            # whether the expanded request still fits the context window.
            self.budget_tracker.num_tools = _tl_hub.count_full_tool_schemas(
                next_tool_payload
            )
            current_context_tokens = _tl_hub.tool_loop_compaction.compact_tool_loop_context(
                self,
                num_tools=self.budget_tracker.num_tools,
            )
            self.budget_tracker.record_iteration(
                result.usage.output_tokens if result.usage is not None else None,
                current_context_tokens,
                made_tool_progress=any(
                    outcome.success
                    for outcome in self.outcomes[outcomes_len_before_tool_phase:]
                ),
            )
            # E3: the per-iteration context figure the loop already paid to
            # compute, published to the composer ring instead of discarded.
            self._emit_iteration_context_usage(
                iteration=_iteration,
                result=result,
                current_context_tokens=current_context_tokens,
            )
            if not self.budget_tracker.check_should_continue():
                if self._request_sub_agent_budget_finalization(
                    iteration=_iteration,
                    next_tool_contract=next_tool_contract,
                    next_tool_payload=next_tool_payload,
                ):
                    return None
                return _tl_hub.tool_loop_recovery.budget_exhausted_wind_down(
                    self,
                    result, reason=self.budget_tracker.stop_reason() or "diminishing_returns",
                )
        self.tool_contract = next_tool_contract
        self.tool_payload = next_tool_payload
        self.tool_statuses = self.tool_contract.status_entries
        return None
