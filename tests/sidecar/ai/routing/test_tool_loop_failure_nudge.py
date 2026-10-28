"""The tool-failure context nudge: one self-describing row per turn.

Template-based local engines relabel the row to ``user`` on the wire. Two
unmarked copies in one turn (two failed fetches) read to a 27B model as "the
user has now sent two more messages", and it answered a question nobody asked.
"""

from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.routing import tool_loop
from sidecar.ai.routing.tool_loop_calls import _ToolCallPhasesMixin


def _loop(*outcomes: bool) -> SimpleNamespace:
    return SimpleNamespace(
        outcomes=[SimpleNamespace(success=ok) for ok in outcomes],
        failure_context_outcome_count=0,
        failure_context_nudged=False,
        working_messages=[],
    )


def _append(loop: SimpleNamespace) -> None:
    _ToolCallPhasesMixin._append_failed_tool_context_if_needed(loop)


def test_only_the_first_failure_of_a_turn_appends_the_nudge() -> None:
    loop = _loop(True, False)
    _append(loop)
    loop.outcomes.append(SimpleNamespace(success=False))
    _append(loop)
    loop.outcomes.append(SimpleNamespace(success=False))
    _append(loop)

    rows = [row for row in loop.working_messages if row["content"] == tool_loop._TOOL_FAILURE_CONTEXT_NUDGE]
    assert len(rows) == 1
    assert rows[0]["role"] == "system"
    assert loop.failure_context_outcome_count == 4


def test_successful_outcomes_append_nothing() -> None:
    loop = _loop(True, True)
    _append(loop)
    assert loop.working_messages == []
    assert loop.failure_context_nudged is False


def test_the_nudge_names_itself_as_harness_text() -> None:
    text = tool_loop._TOOL_FAILURE_CONTEXT_NUDGE
    assert text.startswith("[Harness note, not a message from the user]")
    assert "the user has not sent anything new" in text
    assert "Tool failure context" in text  # the user-role retry in tool_loop_finalize reuses this text
