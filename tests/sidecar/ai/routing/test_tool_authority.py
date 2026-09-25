from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.routing.tool_authority import admit_scoped_tool_call
from sidecar.ai.tools.contracts import ToolExecutionFailure


def _runtime(admission: Any) -> SimpleNamespace:
    return SimpleNamespace(
        request_context=SimpleNamespace(execution_context=object()),
        operation_admission=admission,
    )


def test_builtin_admission_injects_only_the_trusted_returned_envelope() -> None:
    observed: list[dict[str, Any]] = []
    envelope = {"schema_version": 1, "authority_revision": "rev_1"}

    def admission(**kwargs: Any) -> dict[str, Any]:
        observed.append(kwargs)
        return envelope

    arguments = {"path": "note.txt"}
    admit_scoped_tool_call(
        runtime=_runtime(admission),
        call=SimpleNamespace(call_id="call_9", tool_id="read_file"),
        descriptor=SimpleNamespace(server_name="jenny_builtin"),
        tool_arguments=arguments,
        visible_arguments={"path": "note.txt"},
        builtin_server_name="jenny_builtin",
        timeout_seconds=5.0,
    )

    assert observed == [{
        "operation_id": "call_9",
        "tool_name": "read_file",
        "arguments": {"path": "note.txt"},
        "timeout_seconds": 5.0,
    }]
    assert arguments["_jenny_execution_context"] is envelope
    assert arguments["_jenny_operation_id"] == "call_9"


def test_external_server_is_checked_without_receiving_the_authority_envelope() -> None:
    arguments = {"query": "needle"}
    admit_scoped_tool_call(
        runtime=_runtime(lambda **_kwargs: {"schema_version": 1}),
        call=SimpleNamespace(call_id="call_10", tool_id="external_search"),
        descriptor=SimpleNamespace(server_name="external"),
        tool_arguments=arguments,
        visible_arguments=dict(arguments),
        builtin_server_name="jenny_builtin",
        timeout_seconds=None,
    )
    assert arguments == {"query": "needle"}


def test_scoped_dispatch_fails_closed_for_a_malformed_admission_envelope() -> None:
    with pytest.raises(ToolExecutionFailure, match="malformed"):
        admit_scoped_tool_call(
            runtime=_runtime(lambda **_kwargs: None),
            call=SimpleNamespace(call_id="call_11", tool_id="read_file"),
            descriptor=SimpleNamespace(server_name="jenny_builtin"),
            tool_arguments={"path": "note.txt"},
            visible_arguments={"path": "note.txt"},
            builtin_server_name="jenny_builtin",
            timeout_seconds=None,
        )
