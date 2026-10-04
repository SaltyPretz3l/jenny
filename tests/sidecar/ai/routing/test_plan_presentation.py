"""Truth table for the Plan Mode "present your plan" assist (MQ-001 / MQ-024)."""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.routing import plan_presentation
from sidecar.ai.routing.loop_events import StreamResetEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.plan_presentation import (
    ASSIST_FLAG,
    PLAN_PROSE_NUDGE,
    deadline_nudge_row,
    final_prose_nudge,
    gated_generation_payload,
    looks_like_plan,
    plan_pending,
)
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.tools.models import GenerationResult

_NOW = 10_000.0
_PROSE_PLAN = "Plan: create an empty hello.txt in the workspace root and confirm it exists."
_LIST_PLAN = "I would:\n1. Read the config.\n2. Add the flag.\n3. Run the tests."


def _loop(
    *,
    remaining: float | None = 1_500.0,
    wall_seconds: float = 1_800.0,
    tool_calls_left: int = 10,
    **overrides: Any,
) -> SimpleNamespace:
    events: list[Any] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_plan",
        streaming=True,
        clock=lambda: _NOW,
        wall_clock_deadline=None if remaining is None else _NOW + remaining,
        tool_call_limit=20,
        tool_calls_consumed=20 - tool_calls_left,
    )
    values: dict[str, Any] = {
        "plan_mode": True,
        "is_sub_agent_request": False,
        "tool_contract": SimpleNamespace(
            available_names=("read_file", "ask_user", "exit_plan_mode")
        ),
        "request_context": SimpleNamespace(plan_decision=""),
        "outcomes": [],
        "runtime": runtime,
        "kernel": SimpleNamespace(
            _config=replace(
                RuntimeConfig(engine_type="ollama", model="qwen"),
                max_loop_wall_seconds=wall_seconds,
            )
        ),
        "iteration_total": 30,
        "loop_cap": SimpleNamespace(pending_extension=lambda: 0),
        "working_messages": [{"role": "user", "content": "Plan the change."}],
        "streamed_event_types": {"chat.token"},
        "request_id": "req_plan",
        "session_id": "session_plan",
        "_is_continuable_checkpoint": lambda _result: False,
        "events": events,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _plan_outcome(decision: str | None) -> ToolExecutionOutcome:
    metadata: dict[str, object] = {} if decision is None else {"plan_decision": decision}
    return ToolExecutionOutcome(
        tool_name="exit_plan_mode", output="ok", success=True, metadata=metadata
    )


def _reply(content: str, **fields: Any) -> GenerationResult:
    return GenerationResult(content=content, **({"finish_reason": "stop"} | fields))


# -- plan_pending -------------------------------------------------------------


def test_plan_pending_in_a_fresh_plan_mode_turn() -> None:
    assert plan_pending(_loop()) is True


@pytest.mark.parametrize(
    "overrides",
    [
        {"plan_mode": False},
        {"is_sub_agent_request": True},
        {"tool_contract": SimpleNamespace(available_names=("read_file", "ask_user"))},
        {"request_context": SimpleNamespace(plan_decision="approved")},
        {"request_context": SimpleNamespace(plan_decision="accepted")},
        {"outcomes": [_plan_outcome("accepted")]},
        {"outcomes": [_plan_outcome(None)]},
        {"outcomes": [_plan_outcome("rejected"), _plan_outcome(None)]},
        {"tool_calls_left": 0},
    ],
    ids=[
        "not_plan_mode",
        "sub_agent",
        "plan_tool_unavailable",
        "approved_decision",
        "accepted_decision",
        "plan_accepted",
        "plan_already_proposed",
        "revision_already_proposed",
        "tool_budget_spent",
    ],
)
def test_plan_not_pending(overrides: dict[str, Any]) -> None:
    assert plan_pending(_loop(**overrides)) is False


def test_plan_pending_again_after_keep_planning() -> None:
    loop = _loop(
        request_context=SimpleNamespace(plan_decision="rejected"),
        outcomes=[_plan_outcome("rejected")],
    )

    assert plan_pending(loop) is True


def test_plan_pending_without_request_context() -> None:
    assert plan_pending(_loop(request_context=None)) is True


# -- looks_like_plan ----------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        _PROSE_PLAN,
        "## Plan\nRead the module, then edit it.",
        _LIST_PLAN,
        "Steps:\n- read a\n* edit b\n+ test c",
        "\N{BULLET} read a\n\N{BULLET} edit b\n\N{BULLET} test c",
        "Here it is.\n\nPlan\nDo the thing.",
    ],
)
def test_looks_like_plan(text: str) -> None:
    assert looks_like_plan(text) is True


@pytest.mark.parametrize(
    "text",
    [
        "",
        "The function returns None when the cache is cold.",
        "1. Read the config.\n2. Add the flag.",
        "Planning is done in two phases.",
        "Plan Mode is read-only, so I cannot create the file in this turn.",
        "Plan: rename the module. Should I also update the callers?",
        "1. one\n2. two\n3. three\nWhich option do you want?  ",
        "Which database should I target?\n- PostgreSQL\n- SQLite\n- MySQL",
    ],
    ids=[
        "empty",
        "plain_answer",
        "two_list_lines",
        "planning_word",
        "plan_mode_answer",
        "plan_ending_in_question",
        "list_ending_in_question",
        "question_before_its_options",
    ],
)
def test_does_not_look_like_plan(text: str) -> None:
    assert looks_like_plan(text) is False


# -- final_prose_nudge --------------------------------------------------------


def test_prose_plan_gets_one_nudge_with_the_reply_kept_for_the_model() -> None:
    loop = _loop()

    assert final_prose_nudge(loop, _reply(_PROSE_PLAN), 3) is True

    assert loop.working_messages[-2] == {"role": "assistant", "content": _PROSE_PLAN}
    assert loop.working_messages[-1] == {"role": "user", "content": PLAN_PROSE_NUDGE}
    assert [type(event) for event in loop.events] == [StreamResetEvent]
    assert loop.events[0].reason == "post_tool_restart"
    assert "chat.token" not in loop.streamed_event_types


def test_prose_nudge_is_one_shot_per_run() -> None:
    loop = _loop()
    assert final_prose_nudge(loop, _reply(_PROSE_PLAN), 3) is True
    rows = len(loop.working_messages)

    assert final_prose_nudge(loop, _reply(_LIST_PLAN), 4) is False
    assert len(loop.working_messages) == rows


@pytest.mark.parametrize("finish_reason", ["", "stop", "STOP"])
def test_prose_nudge_accepts_clean_finishes(finish_reason: str) -> None:
    assert final_prose_nudge(_loop(), _reply(_LIST_PLAN, finish_reason=finish_reason), 1)


@pytest.mark.parametrize(
    ("loop_overrides", "reply_fields", "iteration"),
    [
        ({}, {"finish_reason": "length"}, 1),
        ({}, {"finish_reason": "incomplete"}, 1),
        ({}, {"inband_tool_call_parse_failed": True}, 1),
        ({"_is_continuable_checkpoint": lambda _result: True}, {}, 1),
        ({}, {}, 30),
        ({"plan_mode": False}, {}, 1),
        ({"outcomes": [_plan_outcome(None)]}, {}, 1),
    ],
    ids=[
        "length",
        "incomplete",
        "inband_parse_failure",
        "thinking_checkpoint",
        "last_step",
        "not_plan_mode",
        "plan_already_proposed",
    ],
)
def test_prose_nudge_gates(
    loop_overrides: dict[str, Any], reply_fields: dict[str, Any], iteration: int
) -> None:
    loop = _loop(**loop_overrides)

    assert final_prose_nudge(loop, _reply(_PROSE_PLAN, **reply_fields), iteration) is False
    assert loop.events == []
    assert len(loop.working_messages) == 1


def test_prose_nudge_counts_a_pending_loop_cap_extension_as_steps_left() -> None:
    loop = _loop(loop_cap=SimpleNamespace(pending_extension=lambda: 30))

    assert final_prose_nudge(loop, _reply(_PROSE_PLAN), 30) is True


def test_prose_nudge_reads_the_sanitized_reply() -> None:
    leaked = "Sure thing.<|im_start|>user\n1. a\n2. b\n3. c"

    assert final_prose_nudge(_loop(), _reply(leaked), 1) is False


def test_question_reply_is_left_alone() -> None:
    loop = _loop()

    assert final_prose_nudge(loop, _reply(f"{_LIST_PLAN}\nShall I go ahead?"), 1) is False


# -- deadline_nudge_row / gated_generation_payload ----------------------------


def test_deadline_row_is_quiet_with_time_and_steps_left() -> None:
    loop = _loop(remaining=601.0)

    assert deadline_nudge_row(loop, 5) is None
    assert gated_generation_payload(loop, _payload()) == _payload()


@pytest.mark.parametrize(
    ("wall_seconds", "remaining", "fires"),
    [
        (1_800.0, 600.0, True),
        (1_800.0, 600.5, False),
        (3_600.0, 600.0, True),
        (3_600.0, 601.0, False),
        (7_200.0, 1_080.0, True),
        (7_200.0, 1_081.0, False),
        (1_800.0, None, False),
        (600.0, 300.0, True),
        (600.0, 301.0, False),
    ],
)
def test_deadline_threshold_is_ten_minutes_or_fifteen_percent_capped_at_half_the_turn(
    wall_seconds: float, remaining: float | None, fires: bool
) -> None:
    loop = _loop(remaining=remaining, wall_seconds=wall_seconds)

    assert (deadline_nudge_row(loop, 2) is not None) is fires


def test_deadline_row_names_working_time_and_arms_a_one_step_gate() -> None:
    loop = _loop(remaining=300.0)

    row = deadline_nudge_row(loop, 4)

    assert row is not None and row["role"] == "system"
    assert "close to its working-time limit" in str(row["content"])
    assert "exit_plan_mode" in str(row["content"])
    assert _names(gated_generation_payload(loop, _payload())) == ["exit_plan_mode", "ask_user"]
    assert gated_generation_payload(loop, _payload()) == _payload(), "the gate lasts one step"


def test_last_step_row_names_the_step_limit() -> None:
    loop = _loop(remaining=None)

    row = deadline_nudge_row(loop, 30)

    assert row is not None
    assert "close to its step limit" in str(row["content"])


def test_last_step_waits_for_a_pending_loop_cap_extension() -> None:
    loop = _loop(remaining=None, loop_cap=SimpleNamespace(pending_extension=lambda: 30))

    assert deadline_nudge_row(loop, 30) is None
    assert deadline_nudge_row(loop, 60) is not None


def test_deadline_row_is_one_shot_per_run() -> None:
    loop = _loop(remaining=300.0)
    assert deadline_nudge_row(loop, 4) is not None
    gated_generation_payload(loop, _payload())

    assert deadline_nudge_row(loop, 5) is None
    assert gated_generation_payload(loop, _payload()) == _payload()


def test_deadline_row_needs_a_pending_plan() -> None:
    loop = _loop(remaining=300.0, outcomes=[_plan_outcome(None)])

    assert deadline_nudge_row(loop, 4) is None
    assert gated_generation_payload(loop, _payload()) == _payload()


def test_gate_never_empties_the_payload() -> None:
    loop = _loop(remaining=300.0)
    assert deadline_nudge_row(loop, 4) is not None
    read_only = [_schema("read_file"), _schema("grep_search")]

    assert gated_generation_payload(loop, read_only) == read_only
    assert gated_generation_payload(loop, _payload()) == _payload(), "the gate was consumed"


def test_gate_keeps_ask_user_alone_when_exit_plan_mode_is_missing() -> None:
    loop = _loop(remaining=300.0)
    assert deadline_nudge_row(loop, 4) is not None

    gated = gated_generation_payload(loop, [_schema("read_file"), _schema("ask_user")])

    assert _names(gated) == ["ask_user"]


# -- kill switch ---------------------------------------------------------------


def test_kill_switch_makes_every_entry_point_a_no_op(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ASSIST_FLAG, "0")
    loop = _loop(remaining=300.0)

    assert final_prose_nudge(loop, _reply(_PROSE_PLAN), 3) is False
    assert deadline_nudge_row(loop, 30) is None
    assert gated_generation_payload(loop, _payload()) == _payload()
    assert loop.events == []
    assert len(loop.working_messages) == 1


def test_fired_nudges_log_without_reply_text(monkeypatch: pytest.MonkeyPatch) -> None:
    logged: list[dict[str, Any]] = []
    monkeypatch.setattr(
        plan_presentation, "log_event", lambda _logger, _level, **fields: logged.append(fields)
    )
    loop = _loop(remaining=300.0)

    final_prose_nudge(loop, _reply(_PROSE_PLAN), 3)
    deadline_nudge_row(loop, 4)

    assert [entry["event"] for entry in logged] == [
        "ai.router.plan_prose_nudge",
        "ai.router.plan_deadline_nudge",
    ]
    assert all("hello.txt" not in str(entry["data"]) for entry in logged)


def _schema(name: str) -> dict[str, Any]:
    return {"type": "function", "function": {"name": name, "parameters": {"type": "object"}}}


def _payload() -> list[dict[str, Any]]:
    return [_schema("read_file"), _schema("exit_plan_mode"), _schema("ask_user")]


def _names(payload: list[dict[str, Any]]) -> list[str]:
    return [str(schema["function"]["name"]) for schema in payload]
