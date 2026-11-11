"""Tool-call phase (P7), mixed into ``_ToolLoopRun``.

Host attributes come from that class; hub names use a function-local import to
keep this module's import fan-out bounded. The cycle-state and blocked-call
helpers live in ``tool_loop_call_state`` (inherited).
"""

from __future__ import annotations

import logging
from dataclasses import replace
from typing import TYPE_CHECKING, Any

from sidecar.ai.error_codes import (
    CMP_MODE_TOOL_BLOCKED,
    CMP_TOOL_DISABLED,
)
from sidecar.ai.routing import (
    plan_mode_transition,
    tool_explicit_pause,
    tool_resource_deferral,
    write_progress,
)
from sidecar.ai.routing.tool_loop_call_state import _ToolCallStateMixin
from sidecar.runtime.turn_state import current_live_run_mode_state

logger = logging.getLogger("sidecar.ai.routing.tool_loop")
class _ToolCallPhasesMixin(_ToolCallStateMixin):
    """P7: the tool-call branch of the loop; cycle-state helpers come from the base."""

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

    if TYPE_CHECKING:
        # Hub methods (``_ToolLoopRun``, tool_loop_run.py). ``TYPE_CHECKING``
        # is False at runtime, so these never shadow the real implementations.
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

    # -- P7: tool-call branch ----------------------------------------------

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
            result, all_invalid = self._record_unknown_tool_calls(
                result,
                valid_tool_calls,
                unknown_tool_calls,
                iteration=_iteration,
                last_error_output=last_error_output,
            )
            if all_invalid:
                return None

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

        execution_context = getattr(self.request_context, "execution_context", None)
        policy_filter = kernel._filter_tool_calls_by_policy(
            result.tool_calls,
            mode=self.mode_policy.mode,
            mode_allows_side_effecting=self.mode_policy.allow_side_effecting_tools,
            resolution_context=self.tool_resolution_context,
            tool_contract=self.tool_contract,
            plan_mode=self.plan_mode,
            read_only=self.read_only,
            request_disabled_tools=self.request_disabled_tools,
            policy_snapshot=getattr(execution_context, "tool_policy_snapshot", None),
        )
        policy_filter = _tl_hub.verify_after_write.escalate_after_writes(
            policy_filter, outcomes=self.outcomes, tool_contract=self.tool_contract
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
        live_run_mode = current_live_run_mode_state()
        scan_approval_mode = (
            live_run_mode.snapshot()[0] if live_run_mode is not None
            else str(getattr(self.request_context, "approval_mode", "prompt"))
        )
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
                result.tool_calls, approval.tool_call_id)
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
                    plan_mode=self.plan_mode, read_only=self.read_only,
                    execution_context=execution_context,
                    turn_id=runtime.logical_turn_id or request_id,
                )
                for call in approval_tool_calls
            )
            approval_plan = _tl_hub.build_approval_plan(
                quota_state_json=tool_resource_deferral._freeze_loop_quota(self),
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
        from sidecar.ai.routing import tool_call_execution as _tce
        _remaining, self.outcome_index = _tce.pre_filter_tool_calls(
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
        allow_resource_deferral = tool_explicit_pause.prepare_tool_continuation(
                self, current_iteration=_iteration,
                outcomes_before_batch=outcomes_len_before_tool_phase,
                remaining_calls=_remaining, ordered_calls=tool_calls_to_execute)
        # Auto-checkpoint immediately before the canonical in-order dispatcher.
        _tl_hub.maybe_create_auto_checkpoint(self, _remaining)
        boundary = None
        if _remaining:
            try:
                boundary = _tce.execute_tool_calls_sequentially(
                    indexed_calls=_remaining,
                    runtime=runtime, kernel=kernel, result=result,
                    request_id=request_id, session_id=session_id,
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
                    approvals_pre_granted=self.approvals_pre_granted,
                    scan_approval_mode=scan_approval_mode,
                    allow_resource_deferral=allow_resource_deferral,
                    on_resource_deferral=tool_explicit_pause.resource_callback(self, _iteration),
                )
            except tool_resource_deferral.ToolResourceDeferred as error:
                raise tool_resource_deferral.suspend_loop_for_resource(
                    self, error, ordered_calls=tool_calls_to_execute,
                    current_iteration=_iteration) from error
            except (tool_resource_deferral.ToolLoopSuspended,
                    tool_resource_deferral.DecisionSuspensionError):
                raise
            except Exception:  # pair any pre-dispatch event before re-raising
                self._settle_unfinished_tool_results("sequential_execution_interrupted")
                raise
        if boundary is not None:  # a session proposal ended the turn: no further generation
            return _tl_hub.finish_loop_at_boundary(
                self, boundary, raw_content=str(result.content or ""))
        if _tl_hub.ends_turn_at_next_step(
                self.outcomes[outcomes_len_before_tool_phase:], tool_calls_to_execute):
            return _tl_hub.finish_loop_at_next_step(self, raw_content=str(result.content or ""))
        self._refund_failed_web_outcomes(
            outcomes_len_before_tool_phase, tool_contract=self.tool_contract)

        new_outcomes = self.outcomes[outcomes_len_before_tool_phase:]
        plan_mode_exited = self._apply_plan_mode_transition(new_outcomes)

        self._append_failed_tool_context_if_needed()
        write_progress.append_write_progress_nudge(self, new_outcomes)  # TR-015 read streak

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
            retries_used=self.reflexive_retries_used, request_id=request_id,
            session_id=session_id, emit_reliability_event=True,
            parse_diagnostics=getattr(result, "tool_call_parse_diagnostics", None))
        if _did_retry_b:
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
            new_outcomes,
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
        # never silently reappear after the hint. A spent tool cap keeps the list
        # offered so the prompt prefix holds (F15); admission rejects the calls.
        next_tool_payload = self._next_cycle_recovery_payload(
            next_tool_contract,
            self.outcomes[outcomes_len_before_tool_phase:],
        )

        if self.budget_tracker is not None:
            # tool_search can promote deferred entries to full schemas between
            # iterations. Charge the prospective payload before deciding
            # whether the expanded request still fits the context window.
            self.budget_tracker.charge_tool_schemas(
                next_tool_payload, _tl_hub.count_full_tool_schemas(next_tool_payload)
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
