"""Context-budget stops distinguish output-capped replies from other stops."""

import logging
from types import SimpleNamespace

import pytest

from sidecar.ai.routing.budget_stop_details import budget_stop_details, fallback_sentence
from sidecar.ai.routing.loop_events import StreamResetEvent, ThinkingEvent, TokenDeltaEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.tool_loop_recovery import _output_capped, budget_exhausted_wind_down
from sidecar.ai.tools.models import GenerationResult

_OUTPUT_CAP_FOOTER = (
    "Stopped: the reply was cut off and this turn's context budget is used up. "
    "Reply 'resume' to continue."
)
_CONTEXT_BUDGET_FOOTER = (
    "Stopped: this turn's context budget is used up. Reply 'resume' to continue."
)


def _budget_stop_loop(events: list[object]) -> SimpleNamespace:
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_output_cap_stop",
        tool_call_limit=3,
        tool_calls_consumed=2,
        streaming=True,
    )
    return SimpleNamespace(
        runtime=runtime,
        request_id=runtime.request_id,
        session_id="",
        budget_tracker=SimpleNamespace(current_context_tokens=42),
        outcomes=[],
        usage_totals=None,
        streamed_event_types=set(),
        max_iterations=3,
        _finish=lambda result, *, reason: result,
        _settle_unfinished_tool_results=lambda _reason: None,
    )


@pytest.mark.parametrize("tool_call_truncated", [True, False])
def test_output_capped_context_stop_reports_output_limit(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    tool_call_truncated: bool,
) -> None:
    caplog.set_level(logging.INFO, logger="sidecar.ai.routing.tool_loop")
    monkeypatch.setattr(
        "sidecar.ai.routing.tool_loop._empty_post_tool_context_response",
        lambda _outcomes: "Completed tool work.",
    )

    def unexpected_regeneration(_loop, _spec):
        pytest.fail("context-budget stops must not regenerate")

    monkeypatch.setattr(
        "sidecar.ai.routing.tool_loop_recovery.wind_down_response",
        unexpected_regeneration,
    )
    events: list[object] = []
    result = budget_exhausted_wind_down(
        _budget_stop_loop(events),
        GenerationResult(
            content="runaway text", finish_reason="length",
            tool_call_truncated=tool_call_truncated,
        ),
        reason="context_budget",
    )

    assert result.response_text.endswith(_OUTPUT_CAP_FOOTER)
    assert _CONTEXT_BUDGET_FOOTER not in result.response_text
    assert result.response_text.startswith("Completed tool work.")
    assert "runaway text" not in result.response_text
    assert result.resumable_stop == "context_budget"
    assert result.completion_source == "deterministic_tool_fallback"
    stop_records = [
        record for record in caplog.records
        if record.__dict__.get("event") == "ai.router.context_budget_stop"
    ]
    assert len(stop_records) == 1
    assert stop_records[0].__dict__["data"]["cause"] == "length"
    assert any(
        isinstance(event, StreamResetEvent) and event.reason == "deterministic_replacement"
        for event in events
    )
    assert "".join(
        event.delta for event in events if isinstance(event, TokenDeltaEvent)
    ) == "Completed tool work."
    assert any(
        isinstance(event, ThinkingEvent) and event.delta == _OUTPUT_CAP_FOOTER
        for event in events
    )


@pytest.mark.parametrize(
    ("finish_reason", "expected"),
    [
        (
            "length",
            (
                _OUTPUT_CAP_FOOTER,
                "I stopped because my reply was cut off and this turn's context budget is used up.",
                "length",
            ),
        ),
        (
            "stop",
            (
                _CONTEXT_BUDGET_FOOTER,
                "I stopped because this turn's context budget is used up.",
                "context_budget",
            ),
        ),
    ],
)
def test_context_stop_uses_cause_specific_fallback(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    finish_reason: str,
    expected: tuple[str, str, str],
) -> None:
    footer, sentence, cause = expected
    caplog.set_level(logging.INFO, logger="sidecar.ai.routing.tool_loop")
    monkeypatch.setattr(
        "sidecar.ai.routing.tool_loop._empty_post_tool_context_response",
        lambda _outcomes: "",
    )

    def unexpected_regeneration(_loop, _spec):
        pytest.fail("context-budget stops must not regenerate")

    monkeypatch.setattr(
        "sidecar.ai.routing.tool_loop_recovery.wind_down_response",
        unexpected_regeneration,
    )
    result = budget_exhausted_wind_down(
        _budget_stop_loop([]),
        GenerationResult(
            content="runaway text", finish_reason=finish_reason, tool_call_truncated=True,
        ),
        reason="context_budget",
    )

    assert result.response_text == f"{sentence}\n\n{footer}"
    assert result.resumable_stop == "context_budget"
    assert result.completion_source == "deterministic_tool_fallback"
    stop_records = [
        record for record in caplog.records
        if record.__dict__.get("event") == "ai.router.context_budget_stop"
    ]
    assert len(stop_records) == 1
    assert stop_records[0].__dict__["data"] == {
        "context_tokens": 42, "tool_calls_used": 2, "cause": cause,
    }


def test_tool_cap_clean_answer_footer_names_the_limit_and_keeps_resume() -> None:
    loop = _budget_stop_loop([])
    loop.runtime.tool_call_limit = 20
    footer, event, data = budget_stop_details(loop, "tool_cap", clean_answer=True)
    assert footer == (
        "Reached this turn's tool limit (20); the reply above was written without further "
        "tool calls. Reply 'resume' if you want it to keep going."
    )
    assert (event, data) == ("ai.router.tool_cap_reached", {"limit": 20, "tool_calls_used": 2})
    assert budget_stop_details(loop, "context_budget", clean_answer=True)[0].startswith("Stopped:")


@pytest.mark.parametrize("output_capped", [True, False])
def test_other_budget_stops_keep_their_copy(output_capped: bool) -> None:
    loop = _budget_stop_loop([])
    loop.runtime.tool_call_limit = 1
    assert budget_stop_details(loop, "tool_cap", output_capped=output_capped) == (
        "Reached this turn's tool limit (1). Reply 'resume' to continue.",
        "ai.router.tool_cap_reached",
        {"limit": 1, "tool_calls_used": 2},
    )
    assert budget_stop_details(loop, "diminishing_returns", output_capped=output_capped) == (
        "Stopped after 3 tool calls in a row made no progress. Reply 'resume' to continue.",
        "ai.router.diminishing_returns_stop",
        {"consecutive_no_progress_window_size": 3, "tool_calls_used": 2},
    )
    assert fallback_sentence("tool_cap", output_capped=output_capped) == (
        "I reached this turn's tool limit before I could finish."
    )
    assert fallback_sentence("diminishing_returns", output_capped=output_capped) == (
        "I stopped because further tool calls were not making progress."
    )


@pytest.mark.parametrize(
    ("finish_reason", "expected"),
    [("length", True), (" LeNgTh ", True), ("stop", False), ("thinking_budget", False)],
)
def test_output_cap_detection_uses_only_finish_reason(finish_reason: str, expected: bool) -> None:
    assert _output_capped(GenerationResult(finish_reason=finish_reason)) is expected
