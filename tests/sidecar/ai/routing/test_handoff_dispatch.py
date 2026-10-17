"""Handoff completion reaches its Electron authority without a runtime operation."""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.error_codes import CMP_TOOL_DISABLED
from sidecar.ai.routing.tool_dispatch import dispatch_tool_call
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.handoff_preparation import HandoffPreparation


def dispatch(*, preparing: Any, name: str, server: str) -> tuple[Any, list[Any]]:
    events: list[Any] = []

    def deny_operation(**_kwargs: Any) -> None:
        raise ToolExecutionFailure(
            code=CMP_TOOL_DISABLED, message="runtime operation refused", retryable=False,
        )

    def electron(request: Any) -> str:
        events.append(request)
        return "handoff completed"

    result = dispatch_tool_call(
        kernel=SimpleNamespace(_config=SimpleNamespace(host_mode="desktop")),
        call=SimpleNamespace(tool_id=name, call_id="handoff_call"),
        tool_arguments={"task": "Reply with LANTERN-431"},
        descriptor=SimpleNamespace(server_name=server),
        request_id="preparation_request", session_id="parent_session",
        runtime=SimpleNamespace(
            request_context=SimpleNamespace(execution_context=object(), handoff_preparation=preparing),
            operation_admission=deny_operation, continuation_checkpoint=lambda: None,
        ),
        timeout_seconds=10, cancel_handle=None, on_output_chunk=None,
        admission_arguments={"task": "Reply with LANTERN-431"},
        builtin_server_name="jenny_builtin", electron_server_name="electron_tool_bridge",
        electron_request_type=SimpleNamespace, electron_executor=electron,
        logger=logging.getLogger(__name__), on_dispatch_ready=lambda: events.append("ready"),
    )
    return result, events


def test_trusted_handoff_completion_reaches_electron_without_runtime_resource_admission() -> None:
    result, events = dispatch(
        preparing=HandoffPreparation("proposal_" + "a" * 64, "11111111-1111-4111-8111-111111111111"),
        name="complete_session_handoff", server="electron_tool_bridge",
    )
    assert result == "handoff completed"
    assert events[0] == "ready"
    request = events[1]
    assert request.tool_name == "complete_session_handoff"
    assert request.session_id == "parent_session"
    assert request.tool_call_id == "handoff_call"
    assert request.arguments == {"task": "Reply with LANTERN-431"}
    assert request.before_resource_start is None


@pytest.mark.parametrize(
    ("preparing", "name", "server"),
    [
        (None, "complete_session_handoff", "electron_tool_bridge"),
        ({"proposal_id": "forged"}, "complete_session_handoff", "electron_tool_bridge"),
        (HandoffPreparation("proposal", "attempt"), "run_command", "electron_tool_bridge"),
        (HandoffPreparation("proposal", "attempt"), "complete_session_handoff", "jenny_builtin"),
        (HandoffPreparation("proposal", "attempt"), "complete_session_handoff", "external_mcp"),
    ],
)
def test_other_calls_still_require_runtime_operation_authority(preparing: Any, name: str, server: str) -> None:
    with pytest.raises(ToolExecutionFailure, match="runtime operation refused"):
        dispatch(preparing=preparing, name=name, server=server)
