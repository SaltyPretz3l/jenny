"""Approval resume: Python runs behind the approved call are carried to their own approval
(session review 2026-11-17, P2), split from test_approval_round_carry.py at its size cap."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.runtime.approval_resume_window import _approval_resume_call_window
from sidecar.runtime.approval_round_carry import (
    MAX_CARRIED_CALLS,
    NO_CARRY,
    RoundCarry,
    split_round_carry,
    with_round_hint,
)
from tests.sidecar.runtime.test_approval_resume_window import _Contract, _kernel, _plan
from tests.sidecar.runtime.test_approval_round_carry import _request


class _PythonContract(_Contract):
    """The window's contract, with the two tools that can run Python."""

    def entry(self, tool_id: str) -> Any:
        if tool_id in ("python_execute", "run_temp_script"):
            descriptor = SimpleNamespace(
                name=tool_id, side_effecting=True, input_schema={"type": "object"}
            )
            return SimpleNamespace(available=True, descriptor=descriptor)
        return super().entry(tool_id)


def _calls(*specs: tuple[str, dict[str, Any]]) -> tuple[ToolCallRequest, ...]:
    return tuple(
        ToolCallRequest(tool_id=tool_id, arguments=arguments, call_id=f"c{index}")
        for index, (tool_id, arguments) in enumerate(specs, start=1)
    )


def _split_calls(
    calls: tuple[ToolCallRequest, ...],
) -> tuple[list[str], RoundCarry]:
    plan = _plan("edit_file")
    plan.tool_calls = calls
    kernel = _kernel(RuntimeConfig())
    contract = _PythonContract()
    selected, dropped = _approval_resume_call_window(
        plan, kernel=kernel, tool_contract=contract, recheck_trailing=True
    )
    carry, still_dropped = split_round_carry(
        plan, selected, dropped, kernel=kernel, tool_contract=contract
    )
    return [call.call_id for call in still_dropped], carry


def test_a_second_python_call_is_carried_to_its_own_approval_not_dropped() -> None:
    calls = _calls(
        ("python_execute", {"code": "print(1)"}),
        ("python_execute", {"code": "print(2)"}),
        ("python_execute", {"code": "print(3)"}),
    )

    dropped, carry = _split_calls(calls)

    assert dropped == []
    assert [call.call_id for call in carry.calls] == ["c2", "c3"]
    assert carry.approval.tool_call_id == "c2"
    assert carry.approval.tool_name == "python_execute"
    # Python never rides on an edit card.
    assert "round_calls" not in carry.approval.to_payload()


def test_a_python_run_temp_script_is_carried_and_any_other_language_is_not() -> None:
    python = _calls(
        ("python_execute", {"code": "print(1)"}),
        ("run_temp_script", {"language": "python", "script": "print(2)"}),
    )
    dropped, carry = _split_calls(python)
    assert dropped == []
    assert [call.call_id for call in carry.calls] == ["c2"]

    for language in ("powershell", "sh", None):
        arguments: dict[str, Any] = {"script": "echo 2"}
        if language is not None:
            arguments["language"] = language
        other = _calls(("python_execute", {"code": "print(1)"}), ("run_temp_script", arguments))
        dropped, carry = _split_calls(other)
        assert carry is NO_CARRY
        assert dropped == ["c2"]


def test_other_tools_behind_a_python_call_are_still_dropped() -> None:
    calls = _calls(
        ("python_execute", {"code": "print(1)"}),
        ("python_execute", {"code": "print(2)"}),
        ("edit_file", {"path": "a"}),
    )

    dropped, carry = _split_calls(calls)

    assert [call.call_id for call in carry.calls] == ["c2"]
    assert dropped == ["c3"]


def test_python_calls_behind_an_edit_are_not_carried() -> None:
    calls = _calls(("edit_file", {"path": "a"}), ("python_execute", {"code": "print(1)"}))

    dropped, carry = _split_calls(calls)

    assert carry is NO_CARRY
    assert dropped == ["c2"]


def test_the_edit_card_names_only_the_edits_of_a_mixed_batch() -> None:
    calls = _calls(
        ("edit_file", {"path": "a"}),
        ("edit_file", {"path": "b"}),
        ("python_execute", {"code": "print(1)"}),
    )

    hinted = with_round_hint(_request(calls[0]), calls)
    assert [item["tool_call_id"] for item in hinted.round_calls] == ["c2"]

    # Edits followed by a python call: the python call is never on the edit card, and a python
    # card behind edits names nothing.
    assert [item["tool_call_id"] for item in hinted.round_calls] == ["c2"]
    assert with_round_hint(_request(calls[2]), calls).to_payload().get("round_calls") is None


def test_the_python_card_names_no_later_calls() -> None:
    calls = _calls(
        ("python_execute", {"code": "print(1)"}),
        ("python_execute", {"code": "print(2)"}),
        ("python_execute", {"code": "print(3)"}),
    )

    first = with_round_hint(_request(calls[0]), calls)

    assert getattr(first, "round_calls", ()) == ()


def test_the_python_carry_is_bounded() -> None:
    calls = _calls(*[("python_execute", {"code": "x"})] * (MAX_CARRIED_CALLS + 4))

    dropped, carry = _split_calls(calls)

    assert len(carry.calls) == MAX_CARRIED_CALLS
    assert len(dropped) == 3
