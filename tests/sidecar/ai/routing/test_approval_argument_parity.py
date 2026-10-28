"""Approved tool calls must be admitted with the arguments the user approved.

In the 2026-10-19 live session the model echoed private ``_jenny_*`` attribution
keys (it saw them in its own approved calls), so the approval signature covered
the raw arguments while admission checked the stripped ones and approved
commands failed with CMP-TOOL-0039. The fix strips ``_jenny_*`` keys from the
approval ``tool_input`` and from the assistant tool-call echo the model sees.
"""

from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.routing.route_policy_runtime import build_approval_request
from sidecar.ai.routing.tool_execution_results import assistant_tool_call_message
from sidecar.ai.routing.tool_execution_snapshots import split_visible_execution_arguments
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest

_VISIBLE = {
    "command": "curl.exe -s https://example.com",
    "timeout_seconds": 30,
    "purpose": "x",
}
_PRIVATE = {
    "_jenny_turn_id": "turn-1",
    "_jenny_tool_call_id": "call-1",
    "_jenny_change_set_id": "cs-1",
}


def _approval_tool_input(call: ToolCallRequest) -> dict[str, object]:
    request = build_approval_request(
        SimpleNamespace,
        call,
        SimpleNamespace(name=call.tool_id),
        mode="ask",
        reason="test",
        policy_decision=None,
    )
    return dict(request.tool_input)


def test_approval_tool_input_matches_admitted_visible_arguments() -> None:
    call = ToolCallRequest("run_command", {**_VISIBLE, **_PRIVATE}, call_id="call-1")

    visible, attribution = split_visible_execution_arguments(call)

    assert _approval_tool_input(call) == visible == _VISIBLE
    assert attribution == _PRIVATE


def test_approval_tool_input_without_private_keys_is_unchanged() -> None:
    call = ToolCallRequest("run_command", dict(_VISIBLE), call_id="call-2")

    assert _approval_tool_input(call) == call.arguments


def test_assistant_echo_drops_private_keys_without_mutating_call() -> None:
    arguments = {**_VISIBLE, **_PRIVATE}
    call = ToolCallRequest("run_command", arguments, call_id="call-1")

    message = assistant_tool_call_message(GenerationResult(tool_calls=(call,)), call)

    tool_calls = message["tool_calls"]
    assert isinstance(tool_calls, list)
    (echo,) = tool_calls
    assert echo == {"id": "call-1", "name": "run_command", "arguments": _VISIBLE}
    assert call.arguments == {**_VISIBLE, **_PRIVATE}
    assert call.arguments is arguments


def test_assistant_echo_passes_a_malformed_payload_through() -> None:
    call = ToolCallRequest("run_command", ["not", "an", "object"], call_id="call-3")  # type: ignore[arg-type]

    message = assistant_tool_call_message(GenerationResult(tool_calls=(call,)), call)

    tool_calls = message["tool_calls"]
    assert isinstance(tool_calls, list)
    (echo,) = tool_calls
    assert echo["arguments"] == ["not", "an", "object"]
