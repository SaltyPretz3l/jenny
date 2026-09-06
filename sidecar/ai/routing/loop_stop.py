"""Centralized stop-logic for the tool loop.

``StopController`` answers "continue, degrade, or stop" at each decision
point in the loop.  All stop policies are registered as checks and are
testable in isolation.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from enum import Enum
from typing import Callable

from sidecar.ai.error_codes import (
    CMP_LOOP_BUDGET_EXCEEDED,
    CMP_LOOP_CYCLE_DETECTED,
    CMP_LOOP_WALL_CLOCK_EXCEEDED,
)
from sidecar.ai.routing.loop_events import StopEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.stuck_loop_detector import detect_stuck_loop
from sidecar.ai.routing.tool_observation import (
    KIND_TURN_FAILED,
    ToolObservationStore,
    tool_argument_fingerprint,
)
from sidecar.ai.tools.models import ToolCallRequest


class StopDecision(Enum):
    CONTINUE = "continue"
    DEGRADE = "degrade"
    STOP = "stop"


@dataclass
class StopReason:
    decision: StopDecision
    message: str
    code: str
    user_hint: str = ""
    subcode: str | None = None


# Six entries so the alternating check can see three full A/B rounds.
CYCLE_HISTORY_DEPTH = 6
SEMANTIC_STUCK_LOOP_WINDOW = 8

# Refines ``terminal_status: "runtime_error"`` for the semantic stuck-loop
# guardrail. Documented in ``docs/operations/turn-diagnostic-schema.md``.
SUBCODE_GUARDRAIL_ABORTED = "guardrail_aborted"
logger = logging.getLogger(__name__)


def _normalize_provider_cost(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        normalized = float(value)
    except (TypeError, ValueError):
        return None
    return normalized if math.isfinite(normalized) and normalized >= 0.0 else None


@dataclass
class LoopState:
    """Snapshot of loop state passed to stop-policy checks."""

    iteration: int
    max_iterations: int
    elapsed_seconds: float
    last_tool_calls: tuple[ToolCallRequest, ...] = ()
    previous_tool_calls: tuple[ToolCallRequest, ...] = ()
    last_error_output: str | None = None
    previous_error_output: str | None = None
    provider_cost_usd: float | None = None
    completed_generations: int = 0
    phase: str = "preflight"
    tool_call_history: tuple[tuple[str, ...], ...] = ()
    error_output_history: tuple[str, ...] = ()
    # True once the runner has already spent its one summarize-and-stop
    # cycle hint this turn; cycle detections then become terminal STOPs
    # instead of recoverable DEGRADEs.
    cycle_hint_attempted: bool = False


def _tool_call_signature(call: ToolCallRequest) -> str:
    """Deterministic fingerprint for a tool call (name + args hash)."""
    return f"{call.tool_id}:{tool_argument_fingerprint(call.arguments)}"


class StopController:
    """Evaluates all registered stop policies per iteration."""

    def __init__(
        self,
        runtime: LoopRuntime,
        wall_clock_deadline: float | None = None,
        max_budget_usd: float | None = None,
        *,
        enable_cycle_detection: bool = True,
        observation_store: ToolObservationStore | None = None,
    ) -> None:
        self._runtime = runtime
        self._wall_clock_deadline = wall_clock_deadline
        self._max_budget_usd = max_budget_usd
        self._enable_cycle_detection = enable_cycle_detection
        self._observation_store = observation_store
        self._budget_unavailable_logged = False
        self._semantic_hint_sequence = 0
        self._checks: list[Callable[[LoopState], StopReason | None]] = []
        self._register_defaults()

    def _register_defaults(self) -> None:
        if self._wall_clock_deadline is not None:
            self._checks.append(self._check_wall_clock)
        if self._max_budget_usd is not None:
            self._checks.append(self._check_budget)
        if self._enable_cycle_detection:
            self._checks.append(self._check_cycle)

    def evaluate(self, state: LoopState) -> StopReason | None:
        """Run all checks.  Return first non-None stop reason, or None.

        After the syntactic checks, consult the semantic
        ``stuck_loop_detector`` over the recent observation buffer. The
        syntactic detector wins when both fire — the semantic detector
        only catches patterns the syntactic check misses.
        """
        for check in self._checks:
            reason = check(state)
            if reason is not None:
                # DEGRADE reasons are recoverable: the runner pauses tools
                # and injects the summarize hint, then the turn continues to
                # a graceful finish. Emitting a terminal StopEvent or a
                # ``turn_failed`` audit row here would mislabel a turn that
                # goes on to complete.
                if reason.decision is not StopDecision.STOP:
                    self._record_semantic_hint_watermark()
                    return reason
                self._runtime.emit(
                    StopEvent(
                        reason=reason.message,
                        code=reason.code,
                        user_hint=reason.user_hint,
                        subcode=reason.subcode,
                    )
                )
                # The promotion bridge feeds off ``ToolObservationStore``;
                # syntactic stops must record an audit row so the Electron
                # collector can promote them into ``turn_events``.
                # ``_check_semantic_stuck_loop`` audits its own row, so this
                # path stays scoped to the syntactic checks. Summary mirrors
                # the semantic-detector richness — code first for grep, then
                # the human-readable reason capped to keep the audit buffer
                # bounded.
                if reason.code:
                    summary_message = (reason.message or "")[:120]
                    summary = (
                        f"turn_failed {reason.code} {summary_message}".rstrip()
                    )
                    self._runtime.audit(
                        KIND_TURN_FAILED,
                        error_code=reason.code,
                        summary=summary,
                    )
                return reason
        semantic_reason = self._check_semantic_stuck_loop(state)
        if semantic_reason is not None:
            if semantic_reason.decision is not StopDecision.STOP:
                return semantic_reason
            self._runtime.emit(
                StopEvent(
                    reason=semantic_reason.message,
                    code=semantic_reason.code,
                    user_hint=semantic_reason.user_hint,
                    subcode=semantic_reason.subcode,
                )
            )
            return semantic_reason
        return None

    def _record_semantic_hint_watermark(self) -> None:
        store = self._observation_store
        if store is None:
            return
        try:
            recent = store.recent_events(
                request_id=self._runtime.request_id,
                limit=SEMANTIC_STUCK_LOOP_WINDOW,
            )
        except Exception:
            return
        self._semantic_hint_sequence = max(
            (event.sequence for event in recent),
            default=self._semantic_hint_sequence,
        )

    def _check_semantic_stuck_loop(self, state: LoopState) -> StopReason | None:
        store = self._observation_store
        if store is None:
            return None
        try:
            recent = store.recent_events(
                request_id=self._runtime.request_id,
                limit=SEMANTIC_STUCK_LOOP_WINDOW,
            )
            if state.cycle_hint_attempted and self._semantic_hint_sequence:
                recent = tuple(
                    event
                    for event in recent
                    if event.sequence > self._semantic_hint_sequence
                )
            finding = detect_stuck_loop(recent, window=SEMANTIC_STUCK_LOOP_WINDOW)
        except Exception:
            return None
        if finding is None:
            return None
        if not state.cycle_hint_attempted:
            self._record_semantic_hint_watermark()
            return StopReason(
                decision=StopDecision.DEGRADE,
                message=(
                    "I may be repeating tool activity, so I am pausing tools "
                    "and summarizing the work completed so far."
                ),
                code=finding.code,
                user_hint=(
                    "The recent observation pattern suggests the model is stuck. "
                    "Stop calling tools, summarize what you have, and tell the "
                    "user what you could not resolve."
                ),
                subcode=SUBCODE_GUARDRAIL_ABORTED,
            )
        self._runtime.audit(
            KIND_TURN_FAILED,
            error_code=finding.code,
            summary=(
                f"semantic_stuck_loop pattern={finding.pattern} "
                f"summary={finding.summary}"
            ),
        )
        return StopReason(
            decision=StopDecision.STOP,
            message=(
                "I got stuck repeating tool activity, so I stopped before "
                "making more tool calls."
            ),
            code=finding.code,
            user_hint=(
                "The recent observation pattern suggests the model is stuck. "
                "Stop calling tools, summarize what you have, and tell the "
                "user what you could not resolve."
            ),
            subcode=SUBCODE_GUARDRAIL_ABORTED,
        )

    def _check_wall_clock(self, state: LoopState) -> StopReason | None:
        # Read the runtime's deadline live rather than ``self._wall_clock_deadline``
        # (the constructor-time copy): an ask_user wait is credited back onto
        # ``runtime.wall_clock_deadline`` after it settles (tool_execution.py's
        # human-interaction credit, mirroring approval-wait crediting), and this
        # check must see that credit immediately rather than judge the turn
        # against a deadline frozen before the wait happened.
        deadline = self._runtime.wall_clock_deadline
        if deadline is None:
            deadline = self._wall_clock_deadline
        if deadline is None:
            return None
        if self._runtime.clock() >= deadline:
            return StopReason(
                decision=StopDecision.STOP,
                message=(f"Loop wall-clock limit exceeded after {state.elapsed_seconds:.1f}s."),
                code=CMP_LOOP_WALL_CLOCK_EXCEEDED,
            )
        return None

    def _check_budget(self, state: LoopState) -> StopReason | None:
        max_budget_usd = self._max_budget_usd
        if max_budget_usd is None:
            return None
        provider_cost_usd = _normalize_provider_cost(state.provider_cost_usd)
        if provider_cost_usd is None:
            if (
                self._runtime.provider_cost_expected
                and state.completed_generations > 0
                and not self._budget_unavailable_logged
            ):
                self._budget_unavailable_logged = True
                logger.warning(
                    "Provider cost unavailable; configured max_budget_usd cannot be evaluated "
                    "(request_id=%s).",
                    str(self._runtime.request_id or "")[:160],
                )
            return None
        if provider_cost_usd <= 0.0:
            return None

        if state.phase == "preflight" and state.completed_generations > 0:
            average_cost = provider_cost_usd / float(state.completed_generations)
            remaining_budget = max_budget_usd - provider_cost_usd
            if remaining_budget < average_cost:
                return StopReason(
                    decision=StopDecision.STOP,
                    message=(
                        f"Budget limit (${max_budget_usd:g}) nearly exhausted "
                        f"(used ${provider_cost_usd:.6f})."
                    ),
                    code=CMP_LOOP_BUDGET_EXCEEDED,
                )

        if state.phase == "post_generation" and provider_cost_usd > max_budget_usd:
            return StopReason(
                decision=StopDecision.STOP,
                message=(
                    f"Budget limit (${max_budget_usd:g}) exceeded (used ${provider_cost_usd:.6f})."
                ),
                code=CMP_LOOP_BUDGET_EXCEEDED,
            )
        return None

    @staticmethod
    def _cycle_reason(state: LoopState, *, message: str, user_hint: str) -> StopReason:
        """Cycle detections degrade (pause tools + summarize hint) before the
        one-per-turn hint is spent; after that they are terminal stops."""
        decision = (
            StopDecision.STOP if state.cycle_hint_attempted else StopDecision.DEGRADE
        )
        return StopReason(
            decision=decision,
            message=message,
            code=CMP_LOOP_CYCLE_DETECTED,
            user_hint=user_hint,
        )

    def _check_cycle(self, state: LoopState) -> StopReason | None:
        current_signatures = tuple(_tool_call_signature(c) for c in state.last_tool_calls)
        signature_history: list[tuple[str, ...]] = [
            tuple(entry) for entry in state.tool_call_history
        ]
        if current_signatures and (
            not signature_history or signature_history[-1] != current_signatures
        ):
            signature_history.append(current_signatures)

        # The runner advances ``tool_call_history`` after execution, so at
        # the preflight check ``last_tool_calls`` is already the newest
        # history entry: N matching window entries mean N real executions.
        # Two identical batches in a row are legitimate (small local models
        # routinely re-read a file they just wrote); intervene at three.
        last_four_signatures = signature_history[-4:]
        if current_signatures and last_four_signatures.count(current_signatures) >= 3:
            return self._cycle_reason(
                state,
                message="Detected repeated tool calls. Please review and adjust.",
                user_hint=(
                    "The same tool call has now run three times without new "
                    "information. Stop calling tools, summarize what you "
                    "found so far, and tell the user what you could not "
                    "resolve."
                ),
            )

        # A/B alternation: three full rounds of the same two batches. The
        # semantic ``stuck_loop_detector`` cannot catch this — observation
        # signatures exclude tool arguments and real streams record several
        # observation kinds per call, so its period-2 tail never matches.
        # Batch signatures here include the args hash, so exactly the
        # pathological alternation trips and an A/B/A compare-two-files
        # pattern stays legitimate.
        last_six_signatures = signature_history[-6:]
        if (
            current_signatures
            and len(last_six_signatures) == 6
            and last_six_signatures[0] == last_six_signatures[2] == last_six_signatures[4]
            and last_six_signatures[1] == last_six_signatures[3] == last_six_signatures[5]
            and last_six_signatures[0] != last_six_signatures[1]
        ):
            return self._cycle_reason(
                state,
                message="Detected repeated tool calls. Please review and adjust.",
                user_hint=(
                    "The last several tool calls alternated between the same "
                    "two requests without new information. Stop calling "
                    "tools, summarize what you found so far, and tell the "
                    "user what you could not resolve."
                ),
            )

        error_history: list[str] = [entry for entry in state.error_output_history]
        if state.last_error_output is not None and (
            not error_history or error_history[-1] != state.last_error_output
        ):
            error_history.append(state.last_error_output)
        recent_errors = [entry for entry in error_history[-3:] if entry]
        if state.last_error_output and recent_errors.count(state.last_error_output) >= 2:
            return self._cycle_reason(
                state,
                message="Detected repeated error output. Breaking to avoid loop.",
                user_hint=(
                    "The last tool calls kept failing with the same error. "
                    "Stop calling tools, summarize what you learned, and tell "
                    "the user what you could not resolve."
                ),
            )
        return None
