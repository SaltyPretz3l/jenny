"""Turn-finalization verification gate for the tool loop.

Default-off (flag ``verification_gate``): when a run has mutated the workspace
with the typed file tools and the model is about to finish, run whichever Test
Runner configuration the user designated as the gate, and hand a failing verdict
back so the model can fix it instead of claiming success.

**The gate can never prevent a turn from completing.** Every failure mode --
no bridge, no designated gate, the user's own run holding the single-run lock, a
timeout, an ``MCPError``, or anything else -- degrades to a note appended to the
model's own response. A failing gate is never a terminal error, never a
``StopEvent``, and never withholds the answer. This is the opposite of a CI gate:
it exists to stop false "done" claims, not to withhold work.

Retry capacity comes from a **carve-out**, not the model's working budget. The
local chat loop is only 8 iterations (``iteration_limits._MODE_DEFAULTS``); the
gate grants itself at most ``GATE_MAX_RETRIES`` extra iterations via
``_ToolLoopRun.grant_gate_iteration()`` and never depends on the model having
left one spare. Exhausting that cap is not a terminal state -- the turn proceeds
to a normal final response that honestly reports the gate did not pass.

Naming note: the gate deliberately reuses ``auto_checkpoint``'s mutation
vocabulary rather than inventing a second mutation tracker.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from sidecar.ai.routing.auto_checkpoint import REPO_MUTATING_TOOL_NAMES
from sidecar.ai.routing.iteration_limits import (
    effective_tools_execution_timeout_seconds,
)
from sidecar.ai.tools.distill import FILTER_SNIFF_CHARS, select_filter
from sidecar.ai.tools.distill.filters.base import omission_placeholder
from sidecar.runtime.electron_tool_bridge import (
    ElectronToolBridgeRequest,
    execute_electron_tool,
)
from sidecar.runtime.tool_execution_support import is_feature_flag_enabled

logger = logging.getLogger(__name__)

VERIFICATION_GATE_FLAG = "verification_gate"
GATE_TOOL_NAME = "verify"

# How many extra loop iterations the gate may claim per turn. One is a real cap:
# the model gets a single chance to act on the failing verdict. Raising it is a
# one-line change, but every increment is an increment of worst-case turn latency.
GATE_MAX_RETRIES = 1

# Deliberately NARROWER than REPO_MUTATING_TOOL_NAMES: ``run_command`` is
# excluded because it is ambiguous (``git status`` is not a mutation) and firing a
# whole test suite after every read-only shell call would be pure latency. The
# typed file tools are the same signal Jenny's other recovery systems key off.
GATE_TRIGGER_TOOL_NAMES = frozenset(REPO_MUTATING_TOOL_NAMES - {"run_command"})

# Verdict statuses the gate tool can report back.
_STATUS_PASSED = "passed"
_STATUS_FAILED = "failed"
_STATUS_SKIPPED = "skipped"

# Failing output handed back to the model, applied AFTER distillation so the
# budget is spent on failure lines rather than on a pass parade.
MAX_FEEDBACK_CHARS = 3000


@dataclass(frozen=True)
class GateDecision:
    """What the finalize hook should do about the gate.

    ``retry`` asks the caller to grant a carve-out iteration, append ``feedback``
    to the working messages, and keep looping. ``note`` is non-empty when the
    turn should finish now with that sentence appended to the model's response.
    Both empty means the gate did nothing at all.
    """

    retry: bool = False
    feedback: str = ""
    note: str = ""
    status: str = ""
    reason: str = ""


NO_GATE_ACTION = GateDecision()


def workspace_was_mutated(outcomes: Iterable[Any]) -> bool:
    """True when a typed file-mutating tool succeeded in this run.

    Requires ``success``: a rejected ``edit_file`` changed nothing, so there is
    nothing to verify.
    """
    return any(
        getattr(outcome, "success", False)
        and str(getattr(outcome, "tool_name", "") or "") in GATE_TRIGGER_TOOL_NAMES
        for outcome in outcomes
    )


def already_verified(outcomes: Iterable[Any]) -> bool:
    """True when the model already ran ``verify`` itself and it passed.

    Re-running the suite the model just ran green would be pure latency, and the
    point of the gate is that verification happened -- not that the gate is what
    did it.
    """
    for outcome in outcomes:
        if str(getattr(outcome, "tool_name", "") or "") != GATE_TOOL_NAME:
            continue
        metadata = getattr(outcome, "metadata", None)
        if isinstance(metadata, dict) and str(metadata.get("status") or "") == _STATUS_PASSED:
            return True
    return False


def should_run_gate(
    *,
    feature_flags: dict[str, bool] | None,
    tools_verify_enabled: bool,
    attempts: int,
    outcomes: Iterable[Any],
) -> bool:
    """Pure decision: should the gate run as this turn finalizes?

    Ordered cheapest-first because this runs on the finalize path of every turn.
    ``outcomes`` is only walked once both flags have passed.
    """
    if attempts >= GATE_MAX_RETRIES + 1:
        return False
    if not is_feature_flag_enabled(feature_flags or {}, VERIFICATION_GATE_FLAG):
        return False
    if not tools_verify_enabled:
        # Without the tool the bridge call could only ever fail. Skip silently.
        return False
    materialized = list(outcomes)
    if not workspace_was_mutated(materialized):
        return False
    return not already_verified(materialized)


def _attempts_of(loop_run: Any) -> int:
    """How many times the gate has run this turn, counting the one in flight."""
    try:
        return max(0, int(getattr(loop_run, "gate_attempts", 0) or 0))
    except (TypeError, ValueError):
        return 0


def _run_gate_tool(loop_run: Any) -> Any | None:
    """Ask Electron to run the designated gate, or ``None`` if no bridge exists.

    Uses ``loop_run.request_id`` (the enclosing TURN's request id), not a fresh
    one: the Electron handler correlates the response by the turn's request id.
    """
    runtime = loop_run.runtime
    runtime.raise_if_interrupted()
    write_message = getattr(runtime, "electron_tool_writer", None)
    if write_message is None:
        return None
    config = getattr(loop_run.kernel, "_config", None)
    configured_timeout = effective_tools_execution_timeout_seconds(config)
    # The 1-based attempt rides along so the Test Runner panel can label the
    # run ("attempt 2 of 2"); it is a harness-only argument, absent from the
    # model-facing schema.
    attempts = _attempts_of(loop_run)
    request = ElectronToolBridgeRequest(
        tool_name=GATE_TOOL_NAME,
        arguments={"action": "gate", **({"attempt": attempts} if attempts > 0 else {})},
        request_id=str(loop_run.request_id or ""),
        trace_id=getattr(runtime, "trace_id", None),
        session_id=loop_run.session_id,
        tool_call_id=f"{GATE_TOOL_NAME}:gate:{loop_run.request_id}",
        write_message=write_message,
        read_message=getattr(runtime, "electron_tool_reader", None),
        response_reader_factory=getattr(runtime, "electron_tool_reader_factory", None),
        # Clamped to the turn's remaining wall clock by tool_timeout_seconds, so
        # a slow suite can never outlive the turn it is verifying.
        timeout_seconds=runtime.tool_timeout_seconds(configured_timeout),
        logger=logger,
        cancel_handle=getattr(runtime, "cancel_handle", None),
    )
    return execute_electron_tool(request)


def distill_gate_output(output: str) -> str:
    """Reduce a failing gate verdict to its failure lines.

    Reuses the build/test/lint filters that already back ``run_command``: every
    classified error line is kept verbatim and runs of pass/progress lines
    collapse into a marker. Unlike ``distill_command_output`` this deliberately
    uses no ``OmissionStore`` -- the model has no call id to recover a gate
    omission through, so the marker is plain prose instead of a recovery ref.

    Falls back to the input untouched on any miss or any exception: over-keeping
    is safe, dropping a real failure line is not.
    """
    text = str(output or "")
    if not text.strip():
        return text
    try:
        output_filter = select_filter(command="", content=text[:FILTER_SNIFF_CHARS])
        if output_filter is None:
            return text
        distilled = output_filter.distill(text)
        if not distilled.omitted:
            return text
        kept = distilled.kept
        for index, segment in enumerate(distilled.omitted):
            kept = kept.replace(
                omission_placeholder(index),
                f"[{segment.line_count} lines of passing output omitted]",
                1,
            )
        # Only take the reduction when it actually reduced.
        return kept if len(kept) < len(text) else text
    except Exception:  # noqa: BLE001 - fall back to raw rather than lose a failure
        logger.warning("gate output distillation failed; using raw output")
        return text


def build_failure_feedback(output: str) -> str:
    """The user-role message that hands a failing verdict back to the model."""
    body = distill_gate_output(output).strip()[:MAX_FEEDBACK_CHARS]
    return (
        "Verification did not pass. Before answering, the workspace's verification "
        "gate ran and reported a failure:\n\n"
        f"{body}\n\n"
        "Fix the cause if you can, then re-run the gate with "
        'verify {"action":"gate"}. If you cannot fix it, say plainly what still '
        "fails instead of describing the work as done."
    )


def build_unverified_note(*, status: str, reason: str, attempts: int = 0) -> str:
    """One honest sentence appended to a response the gate could not clear.

    Never raises and never returns something that reads as a system error: the
    user is being told the state of their workspace, not shown a stack trace.
    ``attempts`` is how many times the gate ran this turn; two or more means a
    fix was tried and the suite still failed, one means no fix was attempted
    (report-only mode).
    """
    if status == _STATUS_FAILED:
        if attempts > 1:
            return (
                "\n\n---\n*Verification gate: the workspace's test configuration "
                f"still did not pass after {attempts} attempts.*"
            )
        return (
            "\n\n---\n*Verification gate: the workspace's test configuration did "
            "not pass after this change; no fix was attempted.*"
        )
    if reason == "no_gate_configured":
        return ""
    return (
        "\n\n---\n*Verification gate: could not be run for this change, so it is "
        "unverified.*"
    )


def _decide_from_result(
    result: Any, *, retry_allowed: bool, attempts: int = 0
) -> GateDecision:
    """Map a gate tool result onto a decision. Pure; no bridge, no loop state."""
    metadata = getattr(result, "metadata", None)
    metadata = metadata if isinstance(metadata, dict) else {}
    status = str(metadata.get("status") or "").strip().lower()
    reason = str(metadata.get("reason") or "").strip().lower()
    on_failure = str(metadata.get("gate_on_failure") or "").strip().lower()

    if status == _STATUS_PASSED:
        return GateDecision(status=_STATUS_PASSED)
    if status == _STATUS_SKIPPED:
        # No gate designated, lock held, unreadable store: the turn continues.
        return GateDecision(
            note=build_unverified_note(status=_STATUS_SKIPPED, reason=reason),
            status=_STATUS_SKIPPED,
            reason=reason,
        )

    # Anything else is treated as a failing verdict, including a malformed
    # result: failing closed here means "tell the truth", not "block the turn".
    output = str(getattr(result, "output", "") or "")
    if retry_allowed and on_failure != "report":
        return GateDecision(
            retry=True,
            feedback=build_failure_feedback(output),
            status=_STATUS_FAILED,
            reason=reason or "gate_failed",
        )
    return GateDecision(
        note=build_unverified_note(
            status=_STATUS_FAILED, reason=reason, attempts=attempts
        ),
        status=_STATUS_FAILED,
        reason=reason or "gate_failed",
    )


def run_gate(loop_run: Any, *, retry_allowed: bool) -> GateDecision:
    """Run the gate and decide, swallowing every failure.

    ``retry_allowed`` is the caller's answer to "can a carve-out iteration still
    be granted?". False forces the note path even on a genuine failure, which is
    how the retry cap stays a cap.
    """
    try:
        result = _run_gate_tool(loop_run)
    except Exception as error:  # noqa: BLE001 - a gate hiccup must never break a turn
        logger.warning("verification gate could not run: %s", error)
        return GateDecision(
            note=build_unverified_note(status="", reason="gate_error"),
            status="",
            reason="gate_error",
        )
    if result is None:
        # Headless / no bridge (tests, sub-agents): not an error, nothing to say.
        return NO_GATE_ACTION
    return _decide_from_result(
        result, retry_allowed=retry_allowed, attempts=_attempts_of(loop_run)
    )
