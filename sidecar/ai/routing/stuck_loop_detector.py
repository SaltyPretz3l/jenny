"""Semantic stuck-loop detector (Phase 6).

Pure helper that consumes a recent window of ``ToolObservationEvent`` and
returns a ``StuckLoopFinding`` when one of three semantic patterns is
recognized. The detector is **additive** to the existing syntactic
``StopController._check_cycle`` — the syntactic detector still fires first;
this module only catches patterns the syntactic check misses.

The function is pure (no clock, no I/O); given the same input it always
produces the same output. Pattern priority is most-specific first:

1. ``repeated_observation`` — same argument-aware observation signature
   appears ≥ 4 times consecutively.
2. ``repeated_errors`` — same non-empty ``error_code`` appears ≥ 3 times
   anywhere in the window.
3. ``alternating_cycle`` — semantic signatures form an A,B,A,B,A,B sequence
   of length ≥ 6 at the tail of the window.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from sidecar.ai.error_codes import (
    CMP_LOOP_REPEATED_ERRORS,
    CMP_LOOP_REPEATED_OBSERVATIONS,
    CMP_LOOP_STUCK_SUSPECTED,
)
from sidecar.ai.routing.tool_observation import (
    KIND_MODEL_REASONING_DELTA,
    KIND_MODEL_VISIBLE_TEXT_DELTA,
    ToolObservationEvent,
    observation_signature,
)

PATTERN_REPEATED_OBSERVATION = "repeated_observation"
PATTERN_REPEATED_ERRORS = "repeated_errors"
PATTERN_ALTERNATING_CYCLE = "alternating_cycle"
_REPEATED_OBSERVATION_THRESHOLD = 4
_REPEATED_ERROR_THRESHOLD = 3
_ALTERNATING_CYCLE_LENGTH = 6
_STREAMING_DELTA_KINDS = frozenset(
    {
        KIND_MODEL_REASONING_DELTA,
        KIND_MODEL_VISIBLE_TEXT_DELTA,
    }
)


def _recent_eligible_events(
    events: Sequence[ToolObservationEvent],
    *,
    window: int,
) -> tuple[ToolObservationEvent, ...]:
    bounded_window = max(int(window or 0), 0)
    if bounded_window <= 0:
        return ()
    eligible = tuple(
        event
        for event in events
        if event.kind not in _STREAMING_DELTA_KINDS
    )
    return eligible[-bounded_window:]


def _detect_repeated_observation(
    recent: tuple[ToolObservationEvent, ...],
    signatures: tuple[str, ...],
) -> StuckLoopFinding | None:
    keys = signatures
    run = 1
    for index in range(1, len(keys)):
        if keys[index] == keys[index - 1]:
            run += 1
        else:
            run = 1
        if run >= _REPEATED_OBSERVATION_THRESHOLD:
            event = recent[index]
            kind = event.kind
            tool_name = event.tool_name or ""
            error_code = event.error_code or ""
            tool_label = tool_name or "<no-tool>"
            error_label = f" error={error_code}" if error_code else ""
            return StuckLoopFinding(
                pattern=PATTERN_REPEATED_OBSERVATION,
                code=CMP_LOOP_REPEATED_OBSERVATIONS,
                summary=(
                    f"Same observation kind={kind} tool={tool_label}{error_label} "
                    f"repeated {run} times consecutively."
                ),
                signatures=signatures,
            )
    return None


def _detect_repeated_errors(
    recent: tuple[ToolObservationEvent, ...],
    signatures: tuple[str, ...],
) -> StuckLoopFinding | None:
    error_codes = [event.error_code for event in recent if event.error_code]
    if not error_codes:
        return None
    # First-seen order keeps the surfaced error stable when multiple
    # codes share the threshold count.
    seen: list[str] = []
    for code in error_codes:
        if code not in seen:
            seen.append(code)
    for code in seen:
        occurrences = error_codes.count(code)
        if occurrences >= _REPEATED_ERROR_THRESHOLD:
            return StuckLoopFinding(
                pattern=PATTERN_REPEATED_ERRORS,
                code=CMP_LOOP_REPEATED_ERRORS,
                summary=(
                    f"Error {code} repeated {occurrences} times in the recent "
                    f"{len(recent)}-event window."
                ),
                signatures=signatures,
            )
    return None


def _detect_alternating_cycle(
    signatures: tuple[str, ...],
) -> StuckLoopFinding | None:
    if len(signatures) < _ALTERNATING_CYCLE_LENGTH:
        return None
    tail = signatures[-_ALTERNATING_CYCLE_LENGTH:]
    if (
        tail[0] == tail[2] == tail[4]
        and tail[1] == tail[3] == tail[5]
        and tail[0] != tail[1]
    ):
        return StuckLoopFinding(
            pattern=PATTERN_ALTERNATING_CYCLE,
            code=CMP_LOOP_STUCK_SUSPECTED,
            summary=(
                "Alternating cycle between two observation signatures detected "
                "for three rounds."
            ),
            signatures=signatures,
        )
    return None


@dataclass(frozen=True)
class StuckLoopFinding:
    """Result of a stuck-loop pattern check."""

    pattern: str
    code: str
    summary: str
    signatures: tuple[str, ...]


def detect_stuck_loop(
    events: Sequence[ToolObservationEvent],
    *,
    window: int = 8,
) -> StuckLoopFinding | None:
    """Return a finding when a semantic stuck pattern is present, else None."""
    if not events:
        return None
    recent = _recent_eligible_events(events, window=window)
    if not recent:
        return None
    sigs = tuple(observation_signature(event) for event in recent)

    for detector in (
        _detect_repeated_observation,
        _detect_repeated_errors,
    ):
        finding = detector(recent, sigs)
        if finding is not None:
            return finding

    return _detect_alternating_cycle(sigs)


__all__ = [
    "PATTERN_ALTERNATING_CYCLE",
    "PATTERN_REPEATED_ERRORS",
    "PATTERN_REPEATED_OBSERVATION",
    "StuckLoopFinding",
    "detect_stuck_loop",
]
