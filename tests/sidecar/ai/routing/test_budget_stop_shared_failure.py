"""The no-progress stop names the harness refusal when every call in the window shared it."""

from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.routing.budget_stop_details import (
    _NO_PROGRESS_WINDOW,
    budget_stop_details,
)
from sidecar.ai.routing.router import ToolExecutionOutcome

_POLICY_CODE = "CMP-TOOL-0039"
_POLICY_MESSAGE = "Current tool policy does not authorize this operation."


def _refused(code: str = _POLICY_CODE, message: str = _POLICY_MESSAGE) -> ToolExecutionOutcome:
    return ToolExecutionOutcome(
        tool_name="run_command",
        output=(
            f"Tool 'run_command' failed: {message} "
            "Review the error and retry with corrected arguments if applicable."
        ),
        success=False,
        error_code=code,
    )


def _loop(outcomes: list[ToolExecutionOutcome]) -> SimpleNamespace:
    return SimpleNamespace(
        runtime=SimpleNamespace(tool_calls_consumed=len(outcomes)),
        outcomes=outcomes,
    )


def test_a_window_of_identical_refusals_names_the_code_and_message() -> None:
    outcomes = [_refused() for _ in range(_NO_PROGRESS_WINDOW)]

    footer, event, data = budget_stop_details(_loop(outcomes), "diminishing_returns")

    assert footer == (
        f"Stopped after 3 tool calls in a row failed with {_POLICY_CODE} "
        f"({_POLICY_MESSAGE}). Reply 'resume' to continue."
    )
    assert event == "ai.router.diminishing_returns_stop"
    assert data == {
        "consecutive_no_progress_window_size": 3,
        "tool_calls_used": 3,
        "error_code": _POLICY_CODE,
    }


def test_only_the_last_window_counts() -> None:
    success = ToolExecutionOutcome(tool_name="read_file", output="ok", success=True)
    outcomes = [success, *(_refused("CMP-TOOL-0008", "cleanup unconfirmed") for _ in range(3))]

    footer, _event, data = budget_stop_details(_loop(outcomes), "diminishing_returns")

    assert "failed with CMP-TOOL-0008 (cleanup unconfirmed)" in footer
    assert data["error_code"] == "CMP-TOOL-0008"


def test_mixed_codes_keep_the_generic_footer() -> None:
    outcomes = [_refused(), _refused(), _refused("CMP-TOOL-0008")]

    footer, _event, data = budget_stop_details(_loop(outcomes), "diminishing_returns")

    assert footer == (
        "Stopped after 3 tool calls in a row made no progress. Reply 'resume' to continue."
    )
    assert "error_code" not in data


def test_a_success_or_an_uncoded_failure_keeps_the_generic_footer() -> None:
    uncoded = ToolExecutionOutcome(tool_name="read_file", output="nothing new", success=False)
    for odd_one in (uncoded, ToolExecutionOutcome(tool_name="read_file", output="", success=True)):
        footer, _event, data = budget_stop_details(
            _loop([_refused(), _refused(), odd_one]), "diminishing_returns"
        )
        assert "made no progress" in footer
        assert "error_code" not in data


def test_a_short_window_keeps_the_generic_footer() -> None:
    footer, _event, _data = budget_stop_details(
        _loop([_refused(), _refused()]), "diminishing_returns"
    )

    assert "made no progress" in footer


def test_the_named_message_is_bounded_and_single_line() -> None:
    long_message = "Refused because " + "the reason keeps going " * 20 + "\nsecond line"
    outcomes = [_refused(message=long_message) for _ in range(3)]

    footer, _event, _data = budget_stop_details(_loop(outcomes), "diminishing_returns")

    detail = footer.split("(", 1)[1].rsplit(")", 1)[0]
    assert len(detail) <= 120
    assert detail.endswith("...")
    assert "\n" not in footer
    assert footer.endswith("Reply 'resume' to continue.")


def test_a_code_without_a_readable_message_names_only_the_code() -> None:
    outcomes = [
        ToolExecutionOutcome(tool_name="x", output="", success=False, error_code=_POLICY_CODE)
        for _ in range(3)
    ]

    footer, _event, _data = budget_stop_details(_loop(outcomes), "diminishing_returns")

    assert footer == (
        f"Stopped after 3 tool calls in a row failed with {_POLICY_CODE}. "
        "Reply 'resume' to continue."
    )
