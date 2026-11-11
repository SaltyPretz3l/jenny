"""Admission and outcome helpers carved out of ``sidecar.ai.routing.tool_execution``."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.routing import tool_execution, tool_execution_admission, tool_execution_outcomes
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_observation import (
    KIND_TOOL_EXECUTION_FAILED,
    KIND_TOOL_EXECUTION_OBSERVED,
)
from sidecar.ai.tools.catalog import BUILTIN_MCP_SERVER_NAME
from sidecar.ai.tools.models import ToolCallRequest


class _AuditRuntime:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    def audit(self, kind: str, **fields: Any) -> None:
        self.events.append((kind, fields))


def _call(tool_id: str = "read_file", **arguments: Any) -> ToolCallRequest:
    return ToolCallRequest(tool_id=tool_id, arguments=dict(arguments), call_id="c1")


def test_hub_aliases_are_the_carved_out_functions() -> None:
    # Callers and tests resolve these through the tool_execution hub.
    assert tool_execution.assert_valid_tool_call is tool_execution_admission.assert_valid_tool_call
    assert (
        tool_execution.filter_tool_calls_by_policy
        is tool_execution_admission.filter_tool_calls_by_policy
    )
    assert (
        tool_execution._descriptor_validation_outcome
        is tool_execution_admission.descriptor_validation_outcome
    )
    assert tool_execution._blocked_outcome is tool_execution_admission.blocked_outcome
    assert tool_execution._audit_tool_event is tool_execution_outcomes.audit_tool_event


def test_runs_python_covers_python_execute_and_python_temp_scripts_only() -> None:
    assert tool_execution_admission.runs_python("python_execute", {})
    assert tool_execution_admission.runs_python("run_temp_script", {"language": "python"})
    assert not tool_execution_admission.runs_python("run_temp_script", {"language": "sh"})
    assert not tool_execution_admission.runs_python("run_command", {"language": "python"})


def test_blocked_outcome_is_a_failed_outcome_with_the_blocked_code() -> None:
    outcome = tool_execution_admission.blocked_outcome(
        ToolExecutionOutcome, _call("write_file"), "read_only", {"path": "a"}
    )
    assert outcome.success is False
    assert outcome.call_id == "c1"
    assert outcome.tool_input == {"path": "a"}
    assert outcome.error_code


def test_unexpected_failure_is_coded_retryable_and_audited() -> None:
    runtime = _AuditRuntime()
    failure = tool_execution_outcomes.unexpected_tool_failure(
        RuntimeError("boom"), call=_call("grep"), runtime=runtime, request_id="r1"
    )
    assert failure.code == CMP_TOOL_EXECUTION_FAILED
    assert failure.retryable is True
    assert failure.message == "tool 'grep' execution failed: boom"
    assert runtime.events == [
        (
            KIND_TOOL_EXECUTION_FAILED,
            {
                "tool_call_id": "c1", "tool_name": "grep",
                "error_code": CMP_TOOL_EXECUTION_FAILED,
                "summary": f"{KIND_TOOL_EXECUTION_FAILED} grep",
            },
        )
    ]


def test_mcp_failure_keeps_observed_changes_for_the_builtin_server_only() -> None:
    changes = {"diffs": [{"path": "a.txt"}]}
    error = MCPError(
        code="", message="script failed", response_received=True, observed_changes=changes
    )
    builtin = SimpleNamespace(server_name=BUILTIN_MCP_SERVER_NAME)
    external = SimpleNamespace(server_name="other")
    failure = tool_execution_outcomes.mcp_tool_failure(
        error, call=_call("python_execute"), descriptor=builtin, runtime=None, request_id="r1"
    )
    assert failure.code.startswith("CMP-TOOL-")
    assert failure.result_metadata == changes
    other = tool_execution_outcomes.mcp_tool_failure(
        error, call=_call("python_execute"), descriptor=external, runtime=None, request_id="r1"
    )
    assert getattr(other, "result_metadata", None) in (None, {})


def _result(**overrides: Any) -> SimpleNamespace:
    base: dict[str, Any] = {
        "tool_name": "read_file", "success": True, "content_type": "text",
        "ui_payload": None, "generated_artifacts": (), "error_code": None,
        "trusted_attachments": (),
    }
    return SimpleNamespace(**{**base, **overrides})


def test_finalize_marks_read_file_snapshot_scope_and_router_truncation() -> None:
    runtime = _AuditRuntime()
    outcome = tool_execution_outcomes.finalize_tool_outcome(
        call=_call("read_file", path="a.py"),
        result=_result(),
        descriptor=None,
        runtime=runtime,
        metadata={"read_snapshot": {"scope": "full"}, "attachments": [{"x": 1}]},
        sanitized_output="text",
        router_output_truncated=True,
        max_response_chars=123,
        visible_tool_arguments={"path": "a.py"},
        outcome_type=ToolExecutionOutcome,
    )
    assert outcome.success is True
    assert outcome.output == "text"
    assert outcome.metadata["snapshot_scope"] == "full"
    assert outcome.metadata["write_eligible"] is True
    assert outcome.metadata["router_output_truncated"] is True
    assert outcome.metadata["router_output_limit_chars"] == 123
    assert outcome.metadata["content_display_truncated"] is True
    assert outcome.trusted_attachments == ()
    assert [kind for kind, _ in runtime.events] == [KIND_TOOL_EXECUTION_OBSERVED]
