"""Run lifecycle helpers for the tool loop, mixed into ``_ToolLoopRun``.

Finishing and settling a run, the loop-state snapshot the stop policy reads, the
iteration grants (verification gate, slow-model cap extension), the mid-turn
mail drain and the engine-stall terminal. Hub module names are reached through
a function-local ``import sidecar.ai.routing.tool_loop as _tl_hub`` like the
other mixins (``tool_loop_calls``, ``tool_loop_finalize``).
"""

from __future__ import annotations

import logging
import time
from typing import Any, NoReturn

from sidecar.runtime.turn_state import current_pending_mail

logger = logging.getLogger("sidecar.ai.routing.tool_loop")
_CLOUD_PROVIDER_ENGINE_TYPES = frozenset({"chatgpt", "codex-cli", "api-provider"})


def _engine_stall_message(
    *,
    config: Any,
    stall_phase: str,
    inactivity_seconds: int,
    model_load_grace_seconds: float,
    engine_was_active: bool = False,
) -> str:
    engine_type = str(getattr(config, "engine_type", "") or "").strip().lower()
    if engine_was_active and stall_phase != "model_load":
        # The engine kept reporting activity through the silence, so the
        # machine is not the suspect: something between the engine and this
        # stream stopped delivering chunks, or the window is simply too short
        # for this turn's output.
        return (
            f"The turn timed out after {inactivity_seconds}s without new streamed output, "
            "even though the model engine was still reporting activity. Retry the turn, "
            "or raise the stream inactivity timeout in Settings > Models > Model Library "
            "> Advanced."
        )
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


class _RunLifecycleMixin:
    """Bound helpers of ``_ToolLoopRun`` that are not an iteration phase."""

    # -- Host-state declarations (zero runtime effect) --------------------
    # ``_ToolLoopRun.__init__`` (tool_loop_run.py) owns these attributes; the
    # bare annotations let mypy check this split module without shadowing them.
    runtime: Any
    kernel: Any
    is_sub_agent_request: bool
    working_messages: list[dict[str, object]]
    turn_context_row: dict[str, Any] | None
    failure_context_nudged: bool
    request_id: str
    session_id: str | None
    thinking_text: str | None
    outcomes: list[Any]
    usage_totals: Any | None
    streamed_event_types: set[str]
    loop_start: float
    last_tool_calls: tuple[Any, ...]
    previous_tool_calls: tuple[Any, ...]
    previous_error_output: str | None
    tool_call_history: tuple[tuple[str, ...], ...]
    error_output_history: tuple[str, ...]
    completed_generations: int
    cycle_hint_attempted: bool
    current_tool_signatures: tuple[str, ...] | None
    max_iterations: Any
    iteration_total: int
    loop_cap: Any
    gate_iterations_granted: int

    def _interrupted_tool_outcome(self, record: dict[str, Any], output: str) -> Any:
        # Delegates to the shared builder so the approval-resume dispatch path
        # settles orphaned tool rows with byte-identical shape.
        import sidecar.ai.routing.tool_loop as _tl_hub

        return _tl_hub.loop_event_emit.build_interrupted_tool_outcome(record, output)

    def _hold_turn_context_row(self) -> dict[str, Any] | None:
        """The turn-context row in the window, kept to be restored after compaction."""
        import sidecar.ai.routing.tool_loop as _tl_hub

        row = next(
            (m for m in self.working_messages if _tl_hub.turn_context.is_turn_context_row(m)),
            None,
        )
        if row is not None:
            self.turn_context_row = dict(row)
        return row

    def _after_context_compaction(self) -> None:
        """Called by tool_loop_compaction once the rebuilt window is in place (TR-015)."""
        import sidecar.ai.routing.tool_loop as _tl_hub

        _tl_hub.turn_context.restore_turn_context_row(
            self.working_messages, getattr(self, "turn_context_row", None)
        )
        _tl_hub.write_progress.repin_after_compaction(self)
        # The rebuilt window dropped the nudge row; the next failure re-pins it.
        self.failure_context_nudged = False

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
        import sidecar.ai.routing.tool_loop as _tl_hub

        self.runtime.completion_reason = str(reason or "").strip() or None
        if loop_result.approval_request is None:
            self._settle_unfinished_tool_results(reason)
        _tl_hub.mutation_change_set_lifecycle.finish_run_change_set(
            self,
            approval_paused=loop_result.approval_request is not None,
            reason=reason,
        )
        return loop_result

    def _finish_text(
        self,
        response_text: str,
        *,
        reason: str,
        status: str | None = None,
        reasoning: object = None,
        completion_source: str = "model",
        **terminal: Any,
    ) -> Any:
        """Finish the turn with a text reply and no approval.

        Non-blank ``reasoning`` is persisted as the reasoning block; otherwise
        the thinking row is the ``status`` line, or the run's own thinking text
        when no status is given. ``terminal`` carries the terminal_* fields.
        """
        import sidecar.ai.routing.tool_loop as _tl_hub

        reasoning_text = str(reasoning or "").strip()
        return self._finish(
            _tl_hub.ToolLoopResult(
                thinking_text=reasoning_text
                or (self.thinking_text if status is None else status),
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
                completion_source=completion_source,
                **terminal,
            ),
            reason=reason,
        )

    def _finish_empty_generation(self, result: Any) -> Any | None:
        import sidecar.ai.routing.tool_loop as _tl_hub

        finish_reason = str(getattr(result, "finish_reason", "") or "").strip().lower()
        if (
            not result.content
            and not result.tool_calls
            and not self.outcomes
            # A truncated/aborted stream must reach the finalize fence
            # instead of settling as a canned success.
            and finish_reason not in ("incomplete", "error", "thinking_budget", "length")
        ):
            if str(getattr(result, "thinking_text", "") or "").strip():
                # Stopped inside its reasoning: answer from it, not canned text.
                return _tl_hub.thinking_checkpoint.reasoning_only_stop_wind_down(
                    self, result
                )
            return self._finish_text(
                "I could not produce a valid response for that request.",
                completion_source="deterministic_tool_fallback",
                reason="empty_generation",
            )
        return None

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
            current_tool_signatures=self.current_tool_signatures,
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

    def release_gate_iteration(self) -> None:
        """Hand back an unused ``grant_gate_iteration`` claim."""
        self.gate_iterations_granted -= 1
        self.max_iterations -= 1
        self.iteration_total -= 1

    def _extend_loop_cap(self) -> bool:
        """At the step cap, grant a slow local model its speed-scaled extension.

        Widens both counters like the other grants, so every capacity check
        stays consistent; the working-time deadline is untouched and still ends
        the turn. Returns False (the loop ends as before) when nothing is added.
        """
        import sidecar.ai.routing.tool_loop as _tl_hub

        delta = self.loop_cap.claim_extension()
        if delta <= 0:
            return False
        self.max_iterations += delta
        self.iteration_total += delta
        mean = self.loop_cap.mean_seconds() or 0.0
        _tl_hub.log_event(
            logger,
            logging.INFO,
            component="ai.router",
            event="ai.router.loop_cap_extended",
            message="Extended the local task step limit for a slow model.",
            status="active",
            data={
                "base": self.loop_cap.base,
                "mean_s": round(mean, 1),
                "new_cap": self.loop_cap.allowed_total,
                "added": delta,
                "max_iterations": self.iteration_total,
            },
            request_id=self.request_id,
            session_id=self.session_id,
        )
        return True

    def _drain_pending_mail(self, iteration: int) -> None:
        """Append mid-turn mail (row 70 W2a) before the next generation.

        ``session.mail_arrived`` rows were validated by the multiplexer. They join
        the working messages exactly as next-turn mail does, as canonical
        ``role:"context"`` rows the provider seam renders into the user-role data
        entry (``engine_messages``), so compaction exclusion, history hashing and
        the vision anchor keep their context-row rules. A sub-agent never drains
        its parent's mail. Logs carry ids and counts, never a body.
        """
        import sidecar.ai.routing.tool_loop as _tl_hub

        if self.is_sub_agent_request:
            return
        pending = current_pending_mail()
        if pending is None:
            return
        rows = pending.drain()
        if not rows:
            return
        self.working_messages.extend(rows)
        message_ids = [str(row["session_message"]["message_id"]) for row in rows]
        self.runtime.emit(_tl_hub.MailConsumedEvent(message_ids=message_ids, iteration=iteration))
        _tl_hub.log_event(
            logger,
            logging.INFO,
            component="ai.router",
            event="ai.router.mail_consumed",
            message="Mid-turn mail joined the working messages.",
            status="active",
            data={"count": len(message_ids), "iteration": iteration},
            request_id=self.request_id,
            session_id=self.session_id,
        )

    def _raise_engine_stall(self) -> NoReturn:
        """Settle open tool rows and end the turn with the engine-stall failure."""
        import sidecar.ai.routing.tool_loop as _tl_hub

        runtime = self.runtime
        self._settle_unfinished_tool_results("engine_stalled")
        inactivity_seconds = int(getattr(runtime, "chunk_inactivity_seconds", 120.0))
        message = _engine_stall_message(
            config=self.kernel._config,
            stall_phase=str(getattr(runtime, "stall_phase", "") or ""),
            inactivity_seconds=inactivity_seconds,
            model_load_grace_seconds=float(
                getattr(runtime, "model_load_grace_seconds", 300.0)
            ),
            engine_was_active=bool(
                getattr(runtime, "stall_engine_was_active", False)
            ),
        )
        raise _tl_hub.ToolExecutionFailure(
            code=_tl_hub.CMP_LOOP_ENGINE_STALLED,
            message=message,
            retryable=True,
        )
