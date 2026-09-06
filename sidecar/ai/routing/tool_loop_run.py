"""Stateful driver for the tool loop.

Hoists the closure-heavy ``run_tool_loop`` orchestrator into a class:
``__init__`` performs the state initialization, ``execute`` runs the
iteration loop, and the per-phase tool-call / final-response branches live
in sibling mixins (``tool_loop_calls``, ``tool_loop_finalize``). The public
``run_tool_loop`` in ``tool_loop`` remains a thin delegator over this class.

Hub routing: names the hub module imports at module level are referenced via a
function-local ``import sidecar.ai.routing.tool_loop as _tl_hub`` so this file
stays within the per-module import-fanout budget (the two mixins and the hub
are the only ``sidecar.ai.*`` module-level dependencies; ``router``,
``iteration_limits`` and ``tool_quotas`` stay function-local).
"""

from __future__ import annotations

import logging
import time
from dataclasses import replace
from types import SimpleNamespace
from typing import Any

from sidecar.ai.routing.tool_loop_calls import _ToolCallPhasesMixin
from sidecar.ai.routing.tool_loop_finalize import _FinalResponseMixin

logger = logging.getLogger("sidecar.ai.routing.tool_loop")
_CLOUD_PROVIDER_ENGINE_TYPES = frozenset({"chatgpt", "codex-cli"})


def _engine_stall_message(
    *,
    config: Any,
    stall_phase: str,
    inactivity_seconds: int,
    model_load_grace_seconds: float,
) -> str:
    engine_type = str(getattr(config, "engine_type", "") or "").strip().lower()
    if engine_type in _CLOUD_PROVIDER_ENGINE_TYPES:
        if stall_phase == "model_load":
            grace_seconds = int(max(float(inactivity_seconds), model_load_grace_seconds))
            return (
                f"The cloud model provider did not begin streaming within {grace_seconds}s. "
                "The provider request may be stalled or unavailable; retry the turn, check "
                "the provider connection, or try a lower reasoning effort."
            )
        return (
            f"The cloud model provider produced no new output for {inactivity_seconds}s. "
            "The request may be stalled or still reasoning; retry the turn, check the "
            "provider connection, try a lower reasoning effort, or review the stream "
            "inactivity timeout in Settings > Models > Model Library > Advanced."
        )
    if stall_phase == "model_load":
        grace_seconds = int(max(float(inactivity_seconds), model_load_grace_seconds))
        return (
            f"The local model did not start producing output within {grace_seconds}s while "
            "loading. The model may be too large to load on this machine, or the load was "
            "interrupted; try a smaller or faster model, or free up VRAM so it loads faster."
        )
    return (
        f"The local model produced no new output for {inactivity_seconds}s and the turn "
        "timed out. This usually means the model is too large or slow for this machine; "
        "try a smaller or faster model, lower the reasoning effort, or raise the stream "
        "inactivity timeout in Settings > Models > Model Library > Advanced."
    )


class _ToolLoopRun(_ToolCallPhasesMixin, _FinalResponseMixin):
    """Owns the mutable state that ``run_tool_loop`` previously kept in
    nonlocals and cross-phase locals; ``execute`` drives the iteration loop.
    """

    def __init__(  # noqa: PLR0913, PLR0915
        self,
        *,
        runtime: Any,
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
        budget_tracker: Any | None,
        read_snapshot_cache: dict[str, Any],
        tool_statuses: Any,
        initial_thinking_text: str | None,
        initial_outcomes: tuple[Any, ...] = (),
        initial_usage_totals: Any | None = None,
        initial_streamed_event_types: frozenset[str] | set[str] = frozenset(),
        request_messages_hash: str = "",
        initial_change_set_id: str | None = None,
    ) -> None:
        import sidecar.ai.routing.tool_loop as _tl_hub
        from sidecar.ai.routing.iteration_limits import (
            effective_max_tools_per_turn,
            is_sub_agent_request_context,
        )

        self.runtime = runtime
        self.kernel = kernel
        runtime.ensure_tool_call_budget(effective_max_tools_per_turn(kernel._config))
        self.request_context = request_context
        self.is_sub_agent_request = is_sub_agent_request_context(request_context)
        # Shared list identity with the caller is load-bearing: chat/chat_resume
        # read the post-loop message count, context-token estimate, and budget
        # messages off the same object, so the loop must append into it rather
        # than rebind. History hygiene therefore lands in place, once, before the
        # first generation -- but only the structural half. The model-facing
        # placeholder backfill stays on a per-iteration copy
        # (build_generation_messages) so "(no content)" never enters live loop
        # state or the approval-plan snapshot that resume replays.
        self.working_messages = working_messages
        self.working_messages[:] = _tl_hub.normalize_history_for_loop(self.working_messages)
        self.tool_contract = tool_contract
        self.tool_payload = tool_payload
        self.tool_resolution_context = tool_resolution_context
        self.tool_preferences = tool_preferences
        self.mode_policy = mode_policy
        self.plan_mode = plan_mode
        self.read_only = read_only
        self.approvals_pre_granted = approvals_pre_granted
        self.request_id = request_id
        self.session_id = session_id
        self._jenny_change_set_id = str(initial_change_set_id or "").strip()
        mutation_lifecycle = __import__(
            "sidecar.ai.routing.mutation_change_set_lifecycle",
            fromlist=["bind_run_context"],
        )
        mutation_lifecycle.bind_run_context(self)
        self.latest_user_content = latest_user_content
        self.reasoning_effort = reasoning_effort
        self.prompt_cache_enabled = prompt_cache_enabled
        self.cache_source_key = cache_source_key
        self.system_prompt = system_prompt
        self.cache_break_detector = cache_break_detector
        self.budget_tracker = budget_tracker
        self.read_snapshot_cache = read_snapshot_cache
        self.tool_statuses = tool_statuses
        self.request_messages_hash = request_messages_hash

        self.thinking_text: str | None = initial_thinking_text
        self.outcomes: list[Any] = list(initial_outcomes)
        self.usage_totals: Any | None = initial_usage_totals
        self.request_disabled_tools = kernel._request_tool_set(
            tool_preferences,
            "disabled_tools",
        )
        self.streamed_event_types: set[str] = set(initial_streamed_event_types)

        self.loop_start = time.monotonic()
        if runtime.observation_store is not None:
            try:
                runtime.observation_store.ensure_turn(request_id=request_id)
            except Exception:
                pass

        runtime.provider_cost_expected = (
            str(kernel._config.engine_type or "").strip().lower()
            in _CLOUD_PROVIDER_ENGINE_TYPES
        )
        self.stop_controller = _tl_hub.StopController(
            runtime=runtime,
            wall_clock_deadline=runtime.wall_clock_deadline,
            max_budget_usd=kernel._config.max_budget_usd,
            enable_cycle_detection=budget_tracker is None,
            observation_store=runtime.observation_store,
        )

        self.last_tool_calls: tuple[Any, ...] = ()
        self.previous_tool_calls: tuple[Any, ...] = ()
        self.previous_error_output: str | None = None
        self.tool_call_history: tuple[tuple[str, ...], ...] = ()
        self.error_output_history: tuple[str, ...] = ()
        self.outcome_index = len(self.outcomes)
        self.completed_generations = 0
        self.tool_nudge_attempted = False
        self.checkpoint_created = False
        self.thinking_budget_checkpoints = 0
        self.reflexive_retry_attempted, self.pending_retry_response_format = False, None  # type: bool, Any | None
        self.post_tool_continuation_attempted = False
        self.sub_agent_report_finalization_requested = False
        self.sub_agent_budget_finalization_requested = False
        self.cycle_hint_attempted = False
        self.cycle_recovery_phase = ""
        self.cycle_recovery_baseline_undeferred: frozenset[str] = frozenset()
        self.degraded_transport_notified = False
        self.tool_budget_exhausted_notified = False
        self.compaction_stalled = False
        self.compaction_last_ditch_used = False
        self.current_info_context_injected = False
        self.failure_context_outcome_count = 0

        self.max_iterations = runtime.max_iterations
        # Approval-resume continuity: iterations are numbered absolutely as
        # ``iteration_base + 1 .. iteration_total`` so a resumed loop never
        # reuses a pre-approval iteration number within the same turn.
        self.iteration_base = max(int(getattr(runtime, "iteration_base", 0) or 0), 0)
        self.iteration_total = self.iteration_base + self.max_iterations
        # Verification-gate carve-out. The gate never spends the model's working
        # budget: when it needs the model to act on a failing verdict it claims an
        # EXTRA iteration here, at most GATE_MAX_RETRIES times per run. The model
        # cannot reach this capacity on its own -- only a gate failure grants it.
        self.gate_iterations_granted = 0
        self.gate_attempts = 0
        self.wind_down_injected = False
        self.feature_flags = kernel._config.feature_flags or {}

        self.quota_registry = None
        if _tl_hub.is_resource_discipline_enabled(self.feature_flags):
            from sidecar.ai.routing.tool_quotas import ToolQuotaRegistry, policy_from_config

            self.quota_registry = ToolQuotaRegistry(
                policy_from_config(kernel._config),
                session_tool_call_count=getattr(request_context, "session_tool_call_count", 0),
            )

    # -- Bound helpers (were closures 863-908) ----------------------------

    def _interrupted_tool_outcome(self, record: dict[str, Any], output: str) -> Any:
        # Delegates to the shared builder so the approval-resume dispatch path
        # settles orphaned tool rows with byte-identical shape.
        import sidecar.ai.routing.tool_loop as _tl_hub

        return _tl_hub.loop_event_emit.build_interrupted_tool_outcome(record, output)

    def _settle_unfinished_tool_results(self, reason: str) -> int:
        import sidecar.ai.routing.tool_loop as _tl_hub

        settled = _tl_hub.loop_event_emit.emit_interrupted_results_for_pending_calls(
            runtime=self.runtime,
            outcomes=self.outcomes,
            streamed_event_types=self.streamed_event_types,
            outcome_factory=self._interrupted_tool_outcome,
        )
        if settled:
            _tl_hub.log_event(
                logger,
                logging.WARNING,
                component="ai.router",
                event="ai.router.orphaned_tool_calls_settled",
                message="Settled tool calls that had no terminal tool.result.",
                status="recovered",
                data={
                    "reason": reason,
                    "settled_count": settled,
                    "code": _tl_hub.CMP_LOOP_TOOL_INTERRUPTED,
                },
                request_id=self.request_id,
                session_id=self.session_id,
            )
        return settled

    def _finish(self, loop_result: Any, *, reason: str) -> Any:
        self.runtime.completion_reason = str(reason or "").strip() or None
        if loop_result.approval_request is None:
            self._settle_unfinished_tool_results(reason)
        mutation_lifecycle = __import__(
            "sidecar.ai.routing.mutation_change_set_lifecycle",
            fromlist=["finish_run_change_set"],
        )
        mutation_lifecycle.finish_run_change_set(
            self,
            approval_paused=loop_result.approval_request is not None,
            reason=reason,
        )
        return loop_result

    def _build_loop_state(
        self,
        iteration: int,
        *,
        phase: str,
        last_error_output: str | None,
    ) -> Any:
        import sidecar.ai.routing.tool_loop as _tl_hub

        return _tl_hub.LoopState(
            iteration=iteration,
            max_iterations=self.iteration_total,
            elapsed_seconds=time.monotonic() - self.loop_start,
            last_tool_calls=self.last_tool_calls,
            previous_tool_calls=self.previous_tool_calls,
            last_error_output=last_error_output,
            previous_error_output=self.previous_error_output,
            provider_cost_usd=(
                self.usage_totals.provider_cost_usd
                if self.usage_totals is not None
                else None
            ),
            completed_generations=self.completed_generations,
            phase=phase,
            tool_call_history=self.tool_call_history,
            error_output_history=self.error_output_history,
            cycle_hint_attempted=self.cycle_hint_attempted,
        )

    def grant_gate_iteration(self) -> bool:
        """Claim one carve-out iteration for the verification gate.

        Returns False once the cap is spent, which is how the retry cap stays a
        cap. Widening both counters keeps every existing capacity check
        (``iteration < self.iteration_total``) correct without special-casing;
        the main loop re-reads ``self.max_iterations`` each pass, so the grant
        takes effect immediately.
        """
        from sidecar.ai.routing.verification_gate import GATE_MAX_RETRIES

        if self.gate_iterations_granted >= GATE_MAX_RETRIES:
            return False
        self.gate_iterations_granted += 1
        self.max_iterations += 1
        self.iteration_total += 1
        return True

    # -- Main loop --------------------------------------------------------

    def execute(self) -> Any:  # noqa: C901, PLR0911, PLR0912, PLR0915
        import sidecar.ai.routing.tool_loop as _tl_hub
        from sidecar.ai.routing.iteration_limits import (
            append_sub_agent_finalization_message,
            append_wind_down_system_message,
            is_sub_agent_final_iteration,
            should_emit_wind_down,
            sub_agent_report_response_format,
            wind_down_enabled,
        )

        runtime = self.runtime
        kernel = self.kernel

        # A while loop, not `for ... in range(...)`: range() materializes the
        # bound once, so the verification gate's carve-out grant (which raises
        # self.max_iterations mid-run) would silently have no effect. Behaviour is
        # identical to the range form whenever max_iterations does not change.
        _local_iteration = 0
        while _local_iteration < self.max_iterations:
            _local_iteration += 1
            _iteration = self.iteration_base + _local_iteration
            runtime.current_iteration = _iteration
            runtime.phase_events_enabled = _tl_hub.is_feature_flag_enabled(
                kernel._config.feature_flags or {}, _tl_hub.FEATURE_PHASE_EVENTS
            )
            runtime.raise_if_cancelled()
            if wind_down_enabled(kernel._config) and should_emit_wind_down(
                iteration=_iteration,
                max_iterations=self.iteration_total,
                already_emitted=self.wind_down_injected,
            ):
                append_wind_down_system_message(self.working_messages)
                self.wind_down_injected = True
                _tl_hub.log_event(
                    logger,
                    logging.INFO,
                    component="ai.router",
                    event="ai.router.iteration_wind_down_injected",
                    message="Injected iteration wind-down system message.",
                    status="active",
                    data={"iteration": _iteration, "max_iterations": self.iteration_total},
                    request_id=self.request_id,
                    session_id=self.session_id,
                )
            # -- Emit iteration-start *before* model call -----------------
            runtime.emit(
                _tl_hub.IterationStartEvent(
                    iteration=_iteration,
                    max_iterations=self.iteration_total,
                )
            )
            if runtime.streaming:
                self.streamed_event_types.add("chat.thinking")

            # -- Stop-policy check ----------------------------------------
            last_error_output: str | None = None
            if self.outcomes:
                last_outcome = self.outcomes[-1]
                if not last_outcome.success:
                    last_error_output = last_outcome.output

            stop_reason = self.stop_controller.evaluate(
                self._build_loop_state(
                    _iteration,
                    phase="preflight",
                    last_error_output=last_error_output,
                )
            )
            if (
                stop_reason is not None
                and stop_reason.decision == _tl_hub.StopDecision.DEGRADE
                and stop_reason.user_hint
                and not self.cycle_hint_attempted
            ):
                # Recoverable cycle detection: pause tools, inject the
                # summarize-and-stop hint, and let this iteration generate a
                # graceful final answer instead of killing the turn with the
                # raw guardrail message.
                self._apply_cycle_hint(
                    stop_reason,
                    _iteration,
                    reset_visible_text=False,
                )
                stop_reason = None
            if stop_reason is not None and stop_reason.decision == _tl_hub.StopDecision.STOP:
                return self._finish(
                    _tl_hub._build_stopped_tool_loop_result(
                        runtime=runtime,
                        kernel=kernel,
                        stop_reason=stop_reason,
                        streamed_event_types=self.streamed_event_types,
                        outcomes=self.outcomes,
                        usage_totals=self.usage_totals,
                    ),
                    reason="stop_policy",
                )

            _tl_hub.log_event(
                logger,
                logging.DEBUG,
                component="ai.router",
                event="ai.router.loop_iteration",
                message=f"Agent loop iteration {_iteration}/{self.iteration_total}",
                status="start",
                data={"iteration": _iteration, "max_iterations": self.iteration_total},
            )

            if not self.current_info_context_injected and not self.outcomes:
                context_message = _tl_hub._current_info_unavailability_context(
                    latest_user_content=self.latest_user_content,
                    tool_statuses=self.tool_statuses,
                )
                if context_message:
                    self.current_info_context_injected = True
                    self.working_messages.append({"role": "system", "content": context_message})

            sub_agent_final_iteration = is_sub_agent_final_iteration(
                iteration=_iteration,
                max_iterations=self.iteration_total,
                request_context=self.request_context,
            ) or self.sub_agent_report_finalization_requested
            generation_tool_payload = self._cycle_recovery_generation_payload()
            generation_response_format = self.pending_retry_response_format
            if sub_agent_final_iteration:
                append_sub_agent_finalization_message(
                    self.working_messages,
                    self.request_context,
                )
                generation_tool_payload = []
                generation_response_format = sub_agent_report_response_format(
                    self.request_context
                )
                _tl_hub.log_event(
                    logger,
                    logging.INFO,
                    component="ai.router",
                    event="ai.router.subagent_finalization_injected",
                    message="Reserved final sub-agent iteration for report synthesis.",
                    status="active",
                    data={"iteration": _iteration, "max_iterations": self.iteration_total},
                    request_id=self.request_id,
                    session_id=self.session_id,
                )

            try:
                result, streamed_generation_types = kernel._generate_step(
                    latest_user_content=self.latest_user_content,
                    working_messages=_tl_hub.build_generation_messages(self.working_messages),
                    reasoning_effort=self.reasoning_effort,
                    prompt_cache_enabled=self.prompt_cache_enabled,
                    source_key=self.cache_source_key,
                    system_prompt=self.system_prompt,
                    tool_schemas=generation_tool_payload,
                    cache_break_detector=self.cache_break_detector,
                    runtime=runtime,
                    response_format=generation_response_format,
                )
            except _tl_hub.TerminalChatStateError:
                raise
            except Exception as error:
                if not (
                    sub_agent_final_iteration
                    and self.sub_agent_budget_finalization_requested
                ):
                    raise
                _tl_hub.log_event(
                    logger,
                    logging.WARNING,
                    component="ai.router",
                    event="ai.router.subagent_budget_finalization_failed",
                    message="Constrained sub-agent budget finalization failed.",
                    status="failed",
                    data={"exception_type": type(error).__name__},
                    request_id=self.request_id,
                    session_id=self.session_id,
                )
                return self._finish_invalid_sub_agent_report(
                    SimpleNamespace(content="")
                )
            self.pending_retry_response_format = None
            self.streamed_event_types.update(streamed_generation_types)
            try:
                runtime.raise_if_cancelled()
            except _tl_hub.TerminalChatStateError:
                self._settle_unfinished_tool_results("cancelled_after_generation")
                raise
            self.usage_totals = _tl_hub._merge_generation_usage(self.usage_totals, result.usage)
            self.completed_generations += 1

            if sub_agent_final_iteration and result.tool_calls:
                _tl_hub.log_event(
                    logger,
                    logging.WARNING,
                    component="ai.router",
                    event="ai.router.subagent_finalization_tool_calls_suppressed",
                    message=(
                        "Suppressed tool calls returned during the reserved child report "
                        "iteration."
                    ),
                    status="degraded",
                    data={
                        "iteration": _iteration,
                        "max_iterations": self.iteration_total,
                        "tool_call_count": len(result.tool_calls),
                    },
                    request_id=self.request_id,
                    session_id=self.session_id,
                )
                result = replace(result, tool_calls=())

            if (
                getattr(result, "degraded_tool_transport", False)
                and not self.degraded_transport_notified
            ):
                self.degraded_transport_notified = True
                _tl_hub.tool_loop_recovery.emit_degradation_status(
                    self,
                    text=(
                        "The model server rejected native tool calling for this "
                        "request; falling back to text-only output."
                    ),
                    event="ai.router.tool_transport_degraded",
                    data={"iteration": _iteration},
                )

            if str(getattr(result, "finish_reason", "") or "") == "timeout":
                # Engine stall: generation_runtime already emitted the
                # CMP_LOOP_ENGINE_STALLED StopEvent and a synthetic timeout
                # sentence. Terminate the turn instead of promoting that
                # sentence to assistant content -- another iteration would just
                # stall again until the Electron idle watchdog kills the stream
                # with a misleading transport error.
                self._settle_unfinished_tool_results("engine_stalled")
                inactivity_seconds = int(getattr(runtime, "chunk_inactivity_seconds", 120.0))
                message = _engine_stall_message(
                    config=kernel._config,
                    stall_phase=str(getattr(runtime, "stall_phase", "") or ""),
                    inactivity_seconds=inactivity_seconds,
                    model_load_grace_seconds=float(
                        getattr(runtime, "model_load_grace_seconds", 300.0)
                    ),
                )
                raise _tl_hub.ToolExecutionFailure(
                    code=_tl_hub.CMP_LOOP_ENGINE_STALLED,
                    message=message,
                    retryable=True,
                )

            post_generation_stop_reason = self.stop_controller.evaluate(
                self._build_loop_state(
                    _iteration,
                    phase="post_generation",
                    last_error_output=last_error_output,
                )
            )
            if (
                post_generation_stop_reason is not None
                and post_generation_stop_reason.decision == _tl_hub.StopDecision.STOP
            ):
                if post_generation_stop_reason.user_hint and not self.cycle_hint_attempted:
                    self._apply_cycle_hint(
                        post_generation_stop_reason,
                        _iteration,
                        reset_visible_text=True,
                    )
                    continue
                # Stop-policy cancellation happens before normal dispatch; emit
                # paired cancellation events so backend pending-tool state remains
                # terminal.
                return self._finish(
                    _tl_hub._build_stopped_tool_loop_result(
                        runtime=runtime,
                        kernel=kernel,
                        stop_reason=post_generation_stop_reason,
                        streamed_event_types=self.streamed_event_types,
                        outcomes=self.outcomes,
                        usage_totals=self.usage_totals,
                        pending_tool_calls=tuple(result.tool_calls or ()),
                        generated_response_text=str(result.content or ""),
                    ),
                    reason="post_generation_stop",
                )

            if not result.tool_calls:
                report_disposition = self._sub_agent_report_disposition(
                    result,
                    _iteration,
                    already_finalizing=sub_agent_final_iteration,
                )
                if report_disposition == "retry":
                    continue
                if report_disposition == "invalid_final":
                    return self._finish_invalid_sub_agent_report(result)
                if report_disposition == "valid":
                    return self._finish_valid_sub_agent_report(result)

            finish_reason = str(
                getattr(result, "finish_reason", "") or ""
            ).strip().lower()
            if (
                not result.content
                and not result.tool_calls
                and not self.outcomes
                # A truncated/aborted stream must reach the finalize fence
                # instead of settling as a canned success.
                and finish_reason not in ("incomplete", "error", "thinking_budget", "length")
            ):
                return self._finish(
                    _tl_hub.ToolLoopResult(
                        thinking_text=self.thinking_text,
                        thinking_kind=_tl_hub.CHAT_THINKING_KIND_STATUS,
                        persist_thinking=False,
                        response_text="I could not produce a valid response for that request.",
                        approval_request=None,
                        approval_plan=None,
                        outcomes=self.outcomes,
                        usage_totals=self.usage_totals,
                        streamed_event_types=self.streamed_event_types,
                        completion_source="deterministic_tool_fallback",
                    ),
                    reason="empty_generation",
                )

            if result.tool_calls:
                outcome = self._handle_tool_calls(result, _iteration, last_error_output)
                if outcome is not None:
                    return outcome
                continue

            outcome = self._handle_final_response(result, _iteration)
            if outcome is not None:
                return outcome
            continue

        return _tl_hub.tool_loop_recovery.max_iterations_summary(self)
