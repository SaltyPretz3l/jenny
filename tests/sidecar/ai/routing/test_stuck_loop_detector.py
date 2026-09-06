from __future__ import annotations

from sidecar.ai.error_codes import (
    CMP_LOOP_REPEATED_ERRORS,
    CMP_LOOP_REPEATED_OBSERVATIONS,
    CMP_LOOP_STUCK_SUSPECTED,
)
from sidecar.ai.routing.stuck_loop_detector import (
    PATTERN_ALTERNATING_CYCLE,
    PATTERN_REPEATED_ERRORS,
    PATTERN_REPEATED_OBSERVATION,
    detect_stuck_loop,
)
from sidecar.ai.routing.tool_observation import (
    KIND_MODEL_REASONING_DELTA,
    KIND_MODEL_TOOL_REQUESTED,
    KIND_MODEL_VISIBLE_TEXT_DELTA,
    KIND_TOOL_EXECUTION_FAILED,
    KIND_TOOL_EXECUTION_OBSERVED,
    KIND_TOOL_EXECUTION_STARTED,
    ToolObservationEvent,
)


def _event(
    kind: str,
    *,
    tool_name: str | None = "read_file",
    error_code: str | None = None,
    summary: str = "",
    request_id: str = "req",
    sequence: int = 0,
    argument_fingerprint: str = "args-shared",
) -> ToolObservationEvent:
    return ToolObservationEvent(
        kind=kind,
        request_id=request_id,
        turn_id="turn",
        tool_call_id=f"call-{sequence}",
        tool_name=tool_name,
        summary=summary,
        error_code=error_code,
        sequence=sequence,
        _argument_fingerprint=argument_fingerprint,
    )


# ---------------------------------------------------------------------------
# Negative cases
# ---------------------------------------------------------------------------


def test_returns_none_when_window_empty() -> None:
    assert detect_stuck_loop(()) is None


def test_returns_none_when_below_threshold() -> None:
    events = (
        _event(KIND_TOOL_EXECUTION_OBSERVED, summary="x", sequence=1),
        _event(KIND_TOOL_EXECUTION_OBSERVED, summary="x", sequence=2),
    )
    assert detect_stuck_loop(events) is None


def test_meaningful_progress_does_not_fire() -> None:
    events = tuple(
        _event(
            KIND_TOOL_EXECUTION_OBSERVED,
            tool_name=f"tool_{index}",
            summary=f"distinct-{index}",
            sequence=index,
        )
        for index in range(8)
    )
    assert detect_stuck_loop(events) is None


def test_streaming_model_deltas_do_not_count_as_repeated_observations() -> None:
    events = tuple(
        _event(
            KIND_MODEL_REASONING_DELTA,
            tool_name=None,
            summary="len=9",
            sequence=index,
        )
        for index in range(4)
    ) + tuple(
        _event(
            KIND_MODEL_VISIBLE_TEXT_DELTA,
            tool_name=None,
            summary="len=4",
            sequence=10 + index,
        )
        for index in range(4)
    )

    assert detect_stuck_loop(events) is None


def test_streaming_model_deltas_do_not_shrink_semantic_window() -> None:
    events = (
        _event(KIND_TOOL_EXECUTION_OBSERVED, summary="repeat", sequence=1),
        _event(KIND_MODEL_REASONING_DELTA, tool_name=None, summary="len=3", sequence=2),
        _event(KIND_MODEL_VISIBLE_TEXT_DELTA, tool_name=None, summary="len=4", sequence=3),
        _event(KIND_TOOL_EXECUTION_OBSERVED, summary="repeat", sequence=4),
        _event(KIND_MODEL_REASONING_DELTA, tool_name=None, summary="len=5", sequence=5),
        _event(KIND_MODEL_VISIBLE_TEXT_DELTA, tool_name=None, summary="len=6", sequence=6),
        _event(KIND_TOOL_EXECUTION_OBSERVED, summary="repeat", sequence=7),
        _event(KIND_MODEL_REASONING_DELTA, tool_name=None, summary="len=7", sequence=8),
        _event(KIND_MODEL_VISIBLE_TEXT_DELTA, tool_name=None, summary="len=8", sequence=9),
        _event(KIND_TOOL_EXECUTION_OBSERVED, summary="repeat", sequence=10),
        _event(KIND_MODEL_REASONING_DELTA, tool_name=None, summary="len=9", sequence=11),
        _event(KIND_MODEL_VISIBLE_TEXT_DELTA, tool_name=None, summary="len=10", sequence=12),
    )

    finding = detect_stuck_loop(events, window=4)

    assert finding is not None
    assert finding.pattern == PATTERN_REPEATED_OBSERVATION


def test_alternating_cycle_below_length_six_does_not_fire() -> None:
    events = (
        _event(KIND_TOOL_EXECUTION_STARTED, tool_name="a", summary="a", sequence=1),
        _event(KIND_TOOL_EXECUTION_STARTED, tool_name="b", summary="b", sequence=2),
        _event(KIND_TOOL_EXECUTION_STARTED, tool_name="a", summary="a", sequence=3),
        _event(KIND_TOOL_EXECUTION_STARTED, tool_name="b", summary="b", sequence=4),
    )
    assert detect_stuck_loop(events) is None


def test_zero_window_returns_none() -> None:
    events = tuple(
        _event(KIND_TOOL_EXECUTION_FAILED, error_code="CMP-X", sequence=index)
        for index in range(5)
    )
    assert detect_stuck_loop(events, window=0) is None


# ---------------------------------------------------------------------------
# Pattern 1 — repeated_observation
# ---------------------------------------------------------------------------


def test_repeated_observation_pattern_fires() -> None:
    events = tuple(
        _event(
            KIND_TOOL_EXECUTION_OBSERVED,
            tool_name="read_file",
            summary="read_file path=README.md",
            sequence=index,
        )
        for index in range(4)
    )
    finding = detect_stuck_loop(events)
    assert finding is not None
    assert finding.pattern == PATTERN_REPEATED_OBSERVATION
    assert finding.code == CMP_LOOP_REPEATED_OBSERVATIONS
    assert "repeated" in finding.summary
    assert len(finding.signatures) == 4


def test_parallel_same_tool_with_distinct_arguments_does_not_fire() -> None:
    events = tuple(
        _event(
            KIND_TOOL_EXECUTION_OBSERVED,
            tool_name="read_file",
            sequence=index,
            argument_fingerprint=f"args-{index}",
        )
        for index in range(5)
    )
    assert detect_stuck_loop(events) is None


def test_repeated_observation_requires_consecutive_run() -> None:
    # Same signature appears 4 times but interleaved — pattern should NOT fire,
    # but pattern 2 (errors) and pattern 3 (alternating) also do not match.
    events = (
        _event(KIND_TOOL_EXECUTION_OBSERVED, tool_name="read_file", summary="a", sequence=1),
        _event(KIND_TOOL_EXECUTION_OBSERVED, tool_name="write_file", summary="b", sequence=2),
        _event(KIND_TOOL_EXECUTION_OBSERVED, tool_name="read_file", summary="a", sequence=3),
        _event(KIND_TOOL_EXECUTION_OBSERVED, tool_name="write_file", summary="b", sequence=4),
        _event(KIND_TOOL_EXECUTION_OBSERVED, tool_name="read_file", summary="a", sequence=5),
        # Length 5 — alternating-cycle requires ≥ 6.
    )
    assert detect_stuck_loop(events) is None


# ---------------------------------------------------------------------------
# Pattern 2 — repeated_errors
# ---------------------------------------------------------------------------


def test_repeated_errors_pattern_fires() -> None:
    events = (
        _event(KIND_TOOL_EXECUTION_FAILED, tool_name="a", error_code="CMP-TOOL-0008", summary="s1", sequence=1),
        _event(KIND_TOOL_EXECUTION_OBSERVED, tool_name="b", summary="s2", sequence=2),
        _event(KIND_TOOL_EXECUTION_FAILED, tool_name="c", error_code="CMP-TOOL-0008", summary="s3", sequence=3),
        _event(KIND_TOOL_EXECUTION_OBSERVED, tool_name="d", summary="s4", sequence=4),
        _event(KIND_TOOL_EXECUTION_FAILED, tool_name="e", error_code="CMP-TOOL-0008", summary="s5", sequence=5),
    )
    finding = detect_stuck_loop(events)
    assert finding is not None
    assert finding.pattern == PATTERN_REPEATED_ERRORS
    assert finding.code == CMP_LOOP_REPEATED_ERRORS
    assert "CMP-TOOL-0008" in finding.summary


def test_repeated_errors_requires_threshold_three() -> None:
    events = (
        _event(KIND_TOOL_EXECUTION_FAILED, error_code="CMP-X", summary="s1", sequence=1),
        _event(KIND_TOOL_EXECUTION_FAILED, error_code="CMP-X", summary="s2", sequence=2),
    )
    assert detect_stuck_loop(events) is None


# ---------------------------------------------------------------------------
# Pattern 3 — alternating_cycle
# ---------------------------------------------------------------------------


def test_alternating_cycle_pattern_fires() -> None:
    events = (
        _event(KIND_TOOL_EXECUTION_STARTED, tool_name="a", summary="a", sequence=1),
        _event(KIND_TOOL_EXECUTION_STARTED, tool_name="b", summary="b", sequence=2),
        _event(KIND_TOOL_EXECUTION_STARTED, tool_name="a", summary="a", sequence=3),
        _event(KIND_TOOL_EXECUTION_STARTED, tool_name="b", summary="b", sequence=4),
        _event(KIND_TOOL_EXECUTION_STARTED, tool_name="a", summary="a", sequence=5),
        _event(KIND_TOOL_EXECUTION_STARTED, tool_name="b", summary="b", sequence=6),
    )
    finding = detect_stuck_loop(events)
    assert finding is not None
    assert finding.pattern == PATTERN_ALTERNATING_CYCLE
    assert finding.code == CMP_LOOP_STUCK_SUSPECTED


# ---------------------------------------------------------------------------
# Priority + purity
# ---------------------------------------------------------------------------


def test_pattern_priority_repeated_observation_beats_repeated_errors() -> None:
    # Same kind + tool + error_code 4× consecutively. Pattern 1 must win
    # over pattern 2 (which would also match because the error_code repeats).
    events = tuple(
        _event(
            KIND_TOOL_EXECUTION_FAILED,
            tool_name="read_file",
            error_code="CMP-TOOL-0008",
            summary="s",
            sequence=index,
        )
        for index in range(5)
    )
    finding = detect_stuck_loop(events)
    assert finding is not None
    assert finding.pattern == PATTERN_REPEATED_OBSERVATION


def test_pure_function_same_input_same_output() -> None:
    events = tuple(
        _event(
            KIND_TOOL_EXECUTION_OBSERVED,
            tool_name="read_file",
            summary="x",
            sequence=index,
        )
        for index in range(4)
    )
    first = detect_stuck_loop(events)
    second = detect_stuck_loop(events)
    assert first == second


def test_window_parameter_respected() -> None:
    # 4 stuck observations followed by 4 distinct ones; with window=4 we
    # examine only the distinct tail and see no pattern.
    stuck = tuple(
        _event(
            KIND_TOOL_EXECUTION_OBSERVED,
            tool_name="read_file",
            summary="stuck",
            sequence=index,
        )
        for index in range(4)
    )
    distinct = tuple(
        _event(
            KIND_TOOL_EXECUTION_OBSERVED,
            tool_name=f"tool_{index}",
            summary=f"d-{index}",
            sequence=10 + index,
        )
        for index in range(4)
    )
    assert detect_stuck_loop(stuck + distinct, window=4) is None
    finding = detect_stuck_loop(stuck + distinct, window=8)
    assert finding is not None
    assert finding.pattern == PATTERN_REPEATED_OBSERVATION


def test_signature_volatility_resilient() -> None:
    # Different request_id / sequence per event but identical semantic key.
    events = tuple(
        _event(
            KIND_MODEL_TOOL_REQUESTED,
            tool_name="read_file",
            summary="read_file path=README.md",
            request_id=f"req_{index}",
            sequence=index,
        )
        for index in range(4)
    )
    finding = detect_stuck_loop(events)
    assert finding is not None
    assert finding.pattern == PATTERN_REPEATED_OBSERVATION
