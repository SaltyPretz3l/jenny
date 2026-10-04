"""Bounded process-local circuit breaker for builtin tool phases.

Three consecutive tool-side failures of one (tool, phase) open the breaker.
After ``BREAKER_COOLDOWN_SECONDS`` it is half-open: calls go through, any call
the tool answers (a result, even a failed one, or a handled model-input
error) closes it, and the next counted failure re-opens it for a fresh
cooldown. Callers decide which failures count; model-input mistakes (bad path,
stale snapshot, blocked command) must not.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.phase_trace import PHASE_NAMES

BREAKER_FAILURE_THRESHOLD = 3
BREAKER_COOLDOWN_SECONDS = 60.0
_MAX_FAILURE_KEYS = 1024


@dataclass
class _KeyState:
    failures: int = 0
    opened_at: float | None = None


_FAILURE_COUNTS: OrderedDict[tuple[str, str], _KeyState] = OrderedDict()
_FAILURE_COUNTS_LOCK = threading.Lock()
_clock: Callable[[], float] = time.monotonic


def record_failure(tool_name: str, phase: str) -> None:
    key = (tool_name, phase)
    with _FAILURE_COUNTS_LOCK:
        state = _FAILURE_COUNTS.get(key)
        if state is None:
            if len(_FAILURE_COUNTS) >= _MAX_FAILURE_KEYS:
                _FAILURE_COUNTS.popitem(last=False)
            state = _FAILURE_COUNTS[key] = _KeyState()
        state.failures += 1
        if state.failures >= BREAKER_FAILURE_THRESHOLD:
            # Opening, or a failed half-open trial: start a fresh cooldown.
            state.opened_at = _clock()


def record_success(tool_name: str, phase: str) -> None:
    with _FAILURE_COUNTS_LOCK:
        _FAILURE_COUNTS.pop((tool_name, phase), None)


def breaker_open_reason(tool_name: str, phase: str) -> str | None:
    """Return the refusal text while open; ``None`` when closed or half-open.

    Half-open claims nothing: a trial call can end without a verdict (a
    handled failure in another phase, a crash), and a claimed slot would then
    lock a working tool for another cooldown (Fable B2 review).
    """
    with _FAILURE_COUNTS_LOCK:
        state = _FAILURE_COUNTS.get((tool_name, phase))
        if state is None or state.failures < BREAKER_FAILURE_THRESHOLD:
            return None
        now = _clock()
        opened_at = state.opened_at if state.opened_at is not None else now
        remaining = BREAKER_COOLDOWN_SECONDS - (now - opened_at)
        if remaining <= 0:
            return None
    return (
        f"Circuit breaker is open for tool '{tool_name}' phase '{phase}'; "
        f"the tool is temporarily unavailable. It allows a retry in about "
        f"{max(1, int(remaining + 0.999))}s."
    )


class BreakerOpenFailure(ToolExecutionFailure):
    """The breaker's own refusal: never counted as a tool failure or success."""


def raise_if_breaker_open(tool_name: str) -> None:
    for phase in PHASE_NAMES:
        open_reason = breaker_open_reason(tool_name, phase)
        if open_reason is not None:
            raise BreakerOpenFailure(
                code=CMP_TOOL_IO_FAILED,
                message=open_reason,
                retryable=False,
                error_details={
                    "failure_class": "unavailable",
                    "effects": "none",
                    "failed_phase": phase,
                },
            )


def record_breaker_outcome(
    tool_name: str, phase: str, error: ToolExecutionFailure, error_data: dict[str, str]
) -> None:
    """Count only failures that point at the tool itself (dogfood HB-015).

    Transient (retryable) and ``unavailable`` failures count toward opening the
    breaker. A handled non-retryable failure (bad path, stale snapshot, blocked
    command) is the model's input, not a broken tool: the phase worked, so it
    closes the key like a success. The breaker's own refusal counts as neither.
    """
    if isinstance(error, BreakerOpenFailure):
        return
    if error.retryable or error_data.get("failure_class") == "unavailable":
        record_failure(tool_name, phase)
    else:
        record_success(tool_name, phase)


def reset_all_for_tests() -> None:
    with _FAILURE_COUNTS_LOCK:
        _FAILURE_COUNTS.clear()
