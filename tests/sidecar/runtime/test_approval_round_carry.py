"""Approval resume: the same-tool edits after the approved one are asked for, not dropped."""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.routing.router import ApprovalRequest
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.runtime.approval_plan import FrozenExecutionInputs, stable_hash
from sidecar.runtime.approval_resume_window import _approval_resume_call_window
from sidecar.runtime.approval_round_carry import (
    MAX_CARRIED_CALLS,
    MAX_HINT_BYTES,
    MAX_HINT_CALL_BYTES,
    NO_CARRY,
    RoundCarry,
    round_call_hints,
    run_loop_or_pause_round,
    split_round_carry,
    with_round_hint,
)
from tests.sidecar.runtime.test_approval_resume_window import _Contract, _kernel, _plan


def _split(plan: Any, kernel: Any) -> tuple[list[str], list[str], RoundCarry]:
    selected, dropped = _approval_resume_call_window(
        plan, kernel=kernel, tool_contract=_Contract(), recheck_trailing=True
    )
    carry, still_dropped = split_round_carry(
        plan, selected, dropped, kernel=kernel, tool_contract=_Contract()
    )
    return (
        [call.call_id for call in selected],
        [call.call_id for call in still_dropped],
        carry,
    )


def test_the_edits_straight_after_the_approved_edit_are_carried_not_dropped() -> None:
    plan = _plan("edit_file", "edit_file", "edit_file")

    selected, dropped, carry = _split(plan, _kernel(RuntimeConfig()))

    assert selected == ["c1"]
    assert dropped == []
    assert [call.call_id for call in carry.calls] == ["c2", "c3"]
    # The next card is for the first carried call, and it names the ones behind it.
    assert isinstance(carry.approval, ApprovalRequest)
    assert carry.approval.tool_call_id == "c2"
    assert carry.approval.tool_name == "edit_file"
    assert carry.approval.to_payload()["round_calls"] == [
        {"tool_call_id": "c3", "tool_name": "edit_file", "tool_input": {"path": "a"}}
    ]


def test_the_carry_starts_after_the_read_only_calls_the_window_took() -> None:
    plan = _plan("edit_file", "read_file", "edit_file")

    selected, dropped, carry = _split(plan, _kernel(RuntimeConfig()))

    assert selected == ["c1", "c2"]
    assert dropped == []
    assert [call.call_id for call in carry.calls] == ["c3"]
    assert "round_calls" not in carry.approval.to_payload()


def test_another_tool_ends_the_carry_and_the_rest_is_dropped_as_before() -> None:
    plan = _plan("edit_file", "edit_file", "write_file", "edit_file")

    selected, dropped, carry = _split(plan, _kernel(RuntimeConfig()))

    assert selected == ["c1"]
    assert [call.call_id for call in carry.calls] == ["c2"]
    assert dropped == ["c3", "c4"]


def test_a_different_tool_straight_after_the_window_is_never_carried() -> None:
    plan = _plan("edit_file", "write_file", "write_file")

    selected, dropped, carry = _split(plan, _kernel(RuntimeConfig()))

    assert selected == ["c1"]
    assert carry is NO_CARRY
    assert dropped == ["c2", "c3"]


def test_only_typed_file_edits_are_carried() -> None:
    plan = _plan("workspace_present", "workspace_present")
    selected, dropped = (plan.tool_calls[0],), (plan.tool_calls[1],)

    carry, still_dropped = split_round_carry(
        plan, selected, dropped, kernel=_kernel(RuntimeConfig()), tool_contract=_Contract()
    )

    assert carry is NO_CARRY
    assert still_dropped == dropped


def test_a_call_that_would_run_unprompted_is_not_carried() -> None:
    # Auto: the next edit needs no approval, so there is no card to carry it to.
    plan = _plan("edit_file", "edit_file", approval_mode="auto_run")

    selected, dropped, carry = _split(plan, _kernel(RuntimeConfig()))

    assert selected == ["c1"]
    assert carry is NO_CARRY
    assert dropped == ["c2"]


def test_a_gate_that_cannot_be_evaluated_carries_nothing() -> None:
    plan = _plan("edit_file", "edit_file")
    kernel = _kernel(RuntimeConfig())
    selected, dropped = (plan.tool_calls[0],), (plan.tool_calls[1],)
    del kernel._approval_if_needed

    carry, still_dropped = split_round_carry(
        plan, selected, dropped, kernel=kernel, tool_contract=_Contract()
    )

    assert carry is NO_CARRY
    assert still_dropped == dropped


def test_a_refused_call_carries_nothing() -> None:
    plan = _plan("edit_file", "edit_file")
    plan.app_refusal = "The app refused this call."

    selected, dropped, carry = _split(plan, _kernel(RuntimeConfig()))

    assert selected == []
    assert carry is NO_CARRY
    assert dropped == ["c2"]


def test_a_window_with_a_call_that_has_no_id_carries_nothing() -> None:
    # The window's end is found by id: an empty one would point at the first id-less call, and the
    # approved edit, already run, would be asked for and run again.
    plan = _plan("read_file", "edit_file", "read_file", "edit_file", approved="c2")
    plan.tool_calls = tuple(
        replace(call, call_id="") if call.tool_id == "read_file" else call
        for call in plan.tool_calls
    )

    selected, dropped, carry = _split(plan, _kernel(RuntimeConfig()))

    assert selected == ["", "c2", ""]
    assert carry is NO_CARRY
    assert dropped == ["c4"]


def test_the_carry_is_bounded() -> None:
    plan = _plan(*(["edit_file"] * (MAX_CARRIED_CALLS + 4)))

    _selected, dropped, carry = _split(plan, _kernel(RuntimeConfig()))

    assert len(carry.calls) == MAX_CARRIED_CALLS
    assert len(dropped) == 3


def test_the_card_shows_the_call_as_the_model_sent_it() -> None:
    plan = _plan("edit_file", "edit_file")
    generated = plan.tool_calls
    # The plan's own copies carry private attribution; the card must not show it.
    plan.tool_calls = tuple(
        replace(call, arguments={**call.arguments, "_jenny_turn_id": "turn-1"})
        for call in generated
    )
    plan.generation_result = SimpleNamespace(tool_calls=generated)

    _selected, _dropped, carry = _split(plan, _kernel(RuntimeConfig()))

    assert carry.calls == (generated[1],)
    assert carry.approval.tool_input == {"path": "a"}


def test_round_call_hints_stop_at_a_call_without_an_id() -> None:
    calls = (
        ToolCallRequest(tool_id="edit_file", arguments={"path": "a"}, call_id="c1"),
        ToolCallRequest(tool_id="edit_file", arguments={"path": "b"}, call_id=""),
    )

    assert round_call_hints(calls) == (
        {"tool_call_id": "c1", "tool_name": "edit_file", "tool_input": {"path": "a"}},
    )


def test_round_call_hints_send_only_what_a_card_can_show() -> None:
    def write(index: int, size: int) -> ToolCallRequest:
        return ToolCallRequest(
            tool_id="write_file", arguments={"path": "f", "content": "x" * size}, call_id=f"c{index}"
        )

    small = 30 * 1024
    # One call too large for a card ends the list; the calls behind it ask on their own.
    too_large = (write(1, small), write(2, MAX_HINT_CALL_BYTES + 1), write(3, small))
    assert [hint["tool_call_id"] for hint in round_call_hints(too_large)] == ["c1"]
    # So does a list that would not fit one card.
    many = tuple(write(index, small) for index in range(1, 9))
    sent = round_call_hints(many)
    assert len(sent) == 4
    assert sum(len(str(hint["tool_input"])) for hint in sent) < MAX_HINT_BYTES


def _edits(*tool_ids: str) -> tuple[ToolCallRequest, ...]:
    return tuple(
        ToolCallRequest(tool_id=tool_id, arguments={"path": f"f{index}"}, call_id=f"c{index}")
        for index, tool_id in enumerate(tool_ids, start=1)
    )


def _request(call: ToolCallRequest, **extra: Any) -> ApprovalRequest:
    return ApprovalRequest(
        tool_call_id=call.call_id,
        tool_name=call.tool_id,
        tool_input=dict(call.arguments),
        reason="",
        mode="prompt",
        **extra,
    )


def test_the_first_card_names_the_same_tool_edits_straight_after_it() -> None:
    calls = _edits("read_file", "edit_file", "edit_file", "edit_file", "write_file", "edit_file")

    hinted = with_round_hint(_request(calls[1]), calls)

    assert [item["tool_call_id"] for item in hinted.round_calls] == ["c3", "c4"]
    assert hinted.to_payload()["round_calls"][0] == {
        "tool_call_id": "c3",
        "tool_name": "edit_file",
        "tool_input": {"path": "f3"},
    }


@pytest.mark.parametrize(
    ("tool_ids", "asked", "extra"),
    [
        (("edit_file", "read_file", "edit_file"), 0, {}),  # the next call is another tool
        (("run_command", "run_command"), 0, {}),  # not a typed file edit
        (("edit_file", "edit_file"), 1, {}),  # nothing after it
        (("edit_file", "edit_file"), 0, {"one_off_only": True}),  # approved once, by a person
    ],
)
def test_the_first_card_names_nothing_it_would_not_carry(
    tool_ids: tuple[str, ...], asked: int, extra: dict[str, Any]
) -> None:
    calls = _edits(*tool_ids)
    request = _request(calls[asked], **extra)

    assert with_round_hint(request, calls) is request


def test_a_request_for_a_call_outside_the_round_is_left_alone() -> None:
    calls = _edits("edit_file", "edit_file")
    request = replace(_request(calls[0]), tool_call_id="elsewhere")

    assert with_round_hint(request, calls) is request
    assert with_round_hint(SimpleNamespace(tool_call_id="c1"), calls).tool_call_id == "c1"


# -- the pause ---------------------------------------------------------------


class _Engine:
    name = "mock"

    def get_model_max_output_tokens(self) -> int | None:
        return None

    def model_identity(self) -> dict[str, object]:
        return {"engine": "mock", "model": "mock-v1"}


def _loop_kwargs(calls: tuple[ToolCallRequest, ...], *, cancelled: bool = False) -> dict[str, Any]:
    audits: list[tuple[str, dict[str, Any]]] = []
    frozen: list[str] = []

    def _raise_if_cancelled() -> None:
        if cancelled:
            raise RuntimeError("cancelled")

    def _freeze(call: Any, **kwargs: Any) -> FrozenExecutionInputs:
        frozen.append(call.call_id)
        assert kwargs["read_snapshot_cache"] == {"a": {"sha256": "after-first-edit"}}
        return FrozenExecutionInputs(
            call_id=call.call_id,
            tool_name=call.tool_id,
            visible_tool_arguments=dict(call.arguments),
            effective_tool_arguments=dict(call.arguments),
            injected_arg_keys=(),
            effective_args_fingerprint=stable_hash(dict(call.arguments)),
            execution_context_payload={"session_id": "session-1"},
        )

    config = RuntimeConfig()
    kernel = SimpleNamespace(
        _config=config, _engine=_Engine(), _freeze_effective_execution_inputs=_freeze
    )
    runtime = SimpleNamespace(
        raise_if_cancelled=_raise_if_cancelled,
        audit=lambda kind, **fields: audits.append((kind, fields)),
        logical_turn_id="turn-1",
        wall_clock_deadline=123.0,
        tool_call_limit=8,
        remaining_tool_calls=5,
    )
    context = SimpleNamespace(
        request_id="req-1", trace_id="trace-1", session_id="session-1", mode="assist",
        plan_mode=False, read_only=False, execution_context=None, context_blocks=(),
        reasoning_effort="medium", parent_approval_plan_hash="",
    )
    return {
        "runtime": runtime,
        "kernel": kernel,
        "request_context": context,
        "working_messages": [
            {"role": "system", "content": "System"},
            {"role": "user", "content": "edit three places"},
        ],
        "tool_contract": SimpleNamespace(prompt_schemas=(), status_entries=()),
        "tool_payload": [],
        "tool_resolution_context": None,
        "plan_mode": False,
        "read_only": False,
        "request_id": "req-1",
        "session_id": "session-1",
        "latest_user_content": "edit three places",
        "prompt_cache_enabled": False,
        "cache_source_key": "",
        "system_prompt": "System",
        "read_snapshot_cache": {"a": {"sha256": "after-first-edit"}},
        "tool_statuses": (),
        "initial_outcomes": ("first-edit-outcome",),
        "initial_usage_totals": None,
        "initial_streamed_event_types": frozenset({"tool.result"}),
        "request_messages_hash": "hash-of-request",
        "initial_change_set_id": "changeset-1",
        "_audits": audits,
        "_frozen": frozen,
    }


def _pause_inputs() -> tuple[RoundCarry, Any, tuple[ToolCallRequest, ...]]:
    calls = tuple(
        ToolCallRequest(tool_id="edit_file", arguments={"path": "a", "n": index}, call_id=f"c{index}")
        for index in (1, 2, 3)
    )
    plan = SimpleNamespace(
        generation_result=GenerationResult(content="Editing.", tool_calls=calls),
        remaining_iterations=4,
        completed_iterations=2,
        approval_plan_hash="parent-hash",
    )
    approval = ApprovalRequest(
        tool_name="edit_file", reason="Edits need approval.", tool_input=dict(calls[1].arguments),
        mode="assist", tool_call_id="c2", round_calls=round_call_hints(calls[2:]),
    )
    return RoundCarry(calls=calls[1:], approval=approval), plan, calls


def test_with_nothing_carried_the_resumed_loop_runs_as_before() -> None:
    seen: dict[str, Any] = {}

    def _run_loop(**kwargs: Any) -> str:
        seen.update(kwargs)
        return "loop-result"

    result = run_loop_or_pause_round(NO_CARRY, SimpleNamespace(), _run_loop, runtime="r", kernel="k")

    assert result == "loop-result"
    assert seen == {"runtime": "r", "kernel": "k"}


def test_a_carried_round_pauses_on_its_first_call_before_any_generation() -> None:
    carry, plan, calls = _pause_inputs()
    loop = _loop_kwargs(calls)
    audits, frozen = loop.pop("_audits"), loop.pop("_frozen")

    def _run_loop(**_kwargs: Any) -> None:
        raise AssertionError("no generation may run while calls of the round are waiting")

    result = run_loop_or_pause_round(carry, plan, _run_loop, **loop)

    assert result.approval_request is carry.approval
    assert result.response_text == ""
    assert result.outcomes == ["first-edit-outcome"]
    assert result.streamed_event_types == {"tool.result"}
    paused = result.approval_plan
    # A whole approval plan of its own: the carried calls only, frozen against the files as the
    # first edit left them, on the same iteration and budget.
    assert paused.call_id == paused.approved_call_id == "c2"
    assert [call.call_id for call in paused.tool_calls] == ["c2", "c3"]
    assert [call.call_id for call in paused.generation_result.tool_calls] == ["c2", "c3"]
    assert paused.generation_result.content == "Editing."
    assert frozen == ["c2", "c3"]
    assert [item.call_id for item in paused.frozen_inputs] == ["c2", "c3"]
    assert (paused.remaining_iterations, paused.completed_iterations) == (4, 2)
    assert (paused.tool_call_limit, paused.remaining_tool_calls) == (8, 5)
    assert paused.wall_clock_deadline == 123.0
    assert paused.request_messages_hash == "hash-of-request"
    assert paused.outcomes == ("first-edit-outcome",)
    assert paused.request_id == "req-1"
    assert paused.approval_plan_hash
    assert [fields["tool_call_id"] for _kind, fields in audits] == ["c2"]


def test_a_cancelled_turn_does_not_pause_for_the_carried_calls() -> None:
    carry, plan, calls = _pause_inputs()
    loop = _loop_kwargs(calls, cancelled=True)
    loop.pop("_audits")
    loop.pop("_frozen")

    with pytest.raises(RuntimeError, match="cancelled"):
        run_loop_or_pause_round(carry, plan, lambda **_kwargs: None, **loop)


# -- through the resume ------------------------------------------------------


def test_the_resume_runs_the_approved_write_and_asks_for_the_next_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from sidecar.ai.error_codes import CMP_TOOL_APPROVAL_WINDOW_DROPPED
    from sidecar.ai.routing.router import ToolExecutionOutcome
    from sidecar.runtime.chat import resume_chat_send_response_from_approval_plan
    from tests.sidecar.runtime.test_chat import (
        _ApprovalResumeRouter,
        _build_approval_plan_for_chat_tests,
        _TextOnlyEngine,
    )

    first = ToolCallRequest(
        tool_id="write_file", arguments={"path": "notes.md", "content": "hello"},
        call_id="call-write-1",
    )
    second = ToolCallRequest(
        tool_id="write_file", arguments={"path": "later.md", "content": "later"},
        call_id="call-write-2",
    )
    third = ToolCallRequest(
        tool_id="write_file", arguments={"path": "last.md", "content": "last"},
        call_id="call-write-3",
    )
    calls = (first, second, third)

    def _frozen(call: ToolCallRequest) -> FrozenExecutionInputs:
        return FrozenExecutionInputs(
            call_id=call.call_id,
            tool_name=call.tool_id,
            visible_tool_arguments=dict(call.arguments),
            effective_tool_arguments=dict(call.arguments),
            injected_arg_keys=(),
            effective_args_fingerprint=stable_hash(dict(call.arguments)),
            execution_context_payload={"session_id": "session-1"},
        )

    plan = replace(
        _build_approval_plan_for_chat_tests(
            remaining_iterations=1, tool_call_limit=3, remaining_tool_calls=0
        ),
        tool_calls=calls,
        frozen_inputs=tuple(_frozen(call) for call in calls),
        generation_result=GenerationResult(content="Writing three files.", tool_calls=calls),
        completed_iterations=5,
    )
    config = SimpleNamespace(
        engine_type="mock", model="mock-v1", model_tier="", fallback_model="",
        system_prompt="Frozen system prompt", temperature=0.0, top_p=1.0, stop_sequences=None,
        max_tokens=16384, max_loop_wall_seconds=300.0, max_tools_per_turn=3,
        chunk_inactivity_seconds=60.0, model_load_grace_seconds=300.0,
        session_start_date="2026-04-13", feature_flags={}, max_inline_payload_bytes=65_536,
    )
    class _EngineWithLimits(_TextOnlyEngine):
        def get_model_max_output_tokens(self) -> int | None:
            return None

    engine = _EngineWithLimits()

    class _Router(_ApprovalResumeRouter):
        _config = config
        _engine = engine

        def _freeze_effective_execution_inputs(self, call: Any, **_kwargs: Any) -> Any:
            return _frozen(call)

        def _request_tool_set(self, _preferences: Any, _key: str) -> frozenset[str]:
            return frozenset()

        def _filter_tool_calls_by_policy(self, tool_calls: Any, **_kwargs: Any) -> Any:
            return SimpleNamespace(allowed=tuple(tool_calls), denied=(), decisions_by_call={})

        def _approval_if_needed(self, tool_calls: Any, **_kwargs: Any) -> Any:
            call = tool_calls[0]
            return ApprovalRequest(
                tool_name=call.tool_id, reason="Writes need approval.",
                tool_input=dict(call.arguments), mode="chat", tool_call_id=call.call_id,
            )

    router = _Router(
        frozen_inputs=plan.frozen_inputs,
        tool_contract=SimpleNamespace(
            prompt_schemas=(), status_entries=(),
            entry=lambda name: SimpleNamespace(
                descriptor=SimpleNamespace(name=name, side_effecting=name == "write_file")
            ),
        ),
        prompt_text="Frozen system prompt",
    )
    brain_container = SimpleNamespace(
        stack=SimpleNamespace(config=config, engine=engine, router=router)
    )
    captured: dict[str, Any] = {}

    def fake_pre_filter_tool_calls(tool_calls: Any, **_kwargs: Any) -> Any:
        captured["prefilter_call_ids"] = [call.call_id for call in tool_calls]
        return [(tool_calls[0], 1)], 1

    def fake_execute_tool_calls_sequentially(**kwargs: Any) -> None:
        kwargs["outcomes"].append(
            ToolExecutionOutcome(
                tool_name="write_file", output="notes.md saved", success=True,
                call_id="call-write-1",
            )
        )

    def fake_run_tool_loop(**_kwargs: Any) -> None:
        raise AssertionError("the model must not be asked again while a write is waiting")

    monkeypatch.setattr(
        "sidecar.runtime.chat._validate_approval_plan_live_context", lambda *args, **kwargs: None
    )
    monkeypatch.setattr(
        "sidecar.ai.routing.tool_call_execution.pre_filter_tool_calls",
        fake_pre_filter_tool_calls,
    )
    monkeypatch.setattr(
        "sidecar.ai.routing.tool_call_execution.execute_tool_calls_sequentially",
        fake_execute_tool_calls_sequentially,
    )
    monkeypatch.setattr("sidecar.ai.routing.tool_loop.run_tool_loop", fake_run_tool_loop)

    response = resume_chat_send_response_from_approval_plan(
        plan,
        brain_container=brain_container,
        live_params={"messages": [{"role": "user", "content": "write notes.md"}]},
        canonical_session_messages=[],
    )

    # Only the approved write ran, and the turn now waits on the second one.
    assert captured["prefilter_call_ids"] == ["call-write-1"]
    assert response.result == {"request_id": plan.request_id, "status": "awaiting_approval"}
    assert response.approval_request["tool_call_id"] == "call-write-2"
    assert response.approval_request["tool_input"] == {"path": "later.md", "content": "later"}
    assert [item["tool_call_id"] for item in response.approval_request["round_calls"]] == [
        "call-write-3"
    ]
    next_plan = response.approval_plan
    assert next_plan.approved_call_id == "call-write-2"
    assert [call.call_id for call in next_plan.tool_calls] == ["call-write-2", "call-write-3"]
    assert next_plan.completed_iterations == 5
    # Nothing was settled as "not run": the model is not told to send the writes again.
    assert [outcome.call_id for outcome in next_plan.outcomes] == ["call-write-1"]
    assert all(
        getattr(outcome, "error_code", None) != CMP_TOOL_APPROVAL_WINDOW_DROPPED
        for outcome in next_plan.outcomes
    )
