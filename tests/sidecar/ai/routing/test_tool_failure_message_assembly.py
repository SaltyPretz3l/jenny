"""Tool failure assembly preserves punctuation and schema repair hints."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH
from sidecar.ai.routing import tool_execution
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_call_execution import (
    execute_tool_calls_sequentially,
    prevalidate_call_arguments,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.runtime import tool_execution_support

_MISSING_PATH = (
    "path does not exist: tv20/missing.txt. Check the exact path with list_dir or glob_files"
)


class _Kernel:
    def __init__(self, failure: ToolExecutionFailure) -> None:
        self._failure = failure

    def _execute_tool(self, _call: ToolCallRequest, **_kwargs: Any) -> ToolExecutionOutcome:
        raise self._failure

    def _assistant_tool_call_message(self, _result: Any, _call: Any) -> dict[str, object]:
        return {"role": "assistant"}

    def _tool_result_message(self, _call: Any, _outcome: Any) -> dict[str, object]:
        return {"role": "tool"}

    def _update_read_snapshot_cache(self, _cache: Any, **_kwargs: Any) -> None:
        return


@pytest.mark.parametrize(
    ("message", "sentence"),
    [
        pytest.param(f"{_MISSING_PATH}.", f"{_MISSING_PATH}.", id="period"),
        pytest.param(_MISSING_PATH, f"{_MISSING_PATH}.", id="no-period"),
        pytest.param("Failed!", "Failed!", id="exclamation"),
        pytest.param("Missing?", "Missing?", id="question"),
        pytest.param(f"  {_MISSING_PATH}. \n", f"{_MISSING_PATH}.", id="whitespace"),
        pytest.param("", "", id="empty"),
        pytest.param(" \n", "", id="blank"),
    ],
)
def test_sequential_failure_message(message: str, sentence: str) -> None:
    failure = ToolExecutionFailure(code=CMP_TOOL_INVALID_PATH, message=message, retryable=False)
    call = ToolCallRequest(tool_id="read_file", arguments={"path": "tv20/missing.txt"}, call_id="c1")
    runtime = LoopRuntime(
        emit=lambda _event: None,
        request_id="req-1",
        session_id="session-1",
        streaming=False,
        tool_call_limit=20,
    )
    outcomes: list[ToolExecutionOutcome] = []

    execute_tool_calls_sequentially(
        indexed_calls=[(call, 1)],
        runtime=runtime,
        kernel=_Kernel(failure),
        result=SimpleNamespace(),
        request_id="req-1",
        session_id="session-1",
        tool_resolution_context=None,
        read_snapshot_cache={},
        outcomes=outcomes,
        working_messages=[],
        iteration_calls=[],
        streamed_event_types=set(),
        tool_payload_ref=[],
        tool_contract=SimpleNamespace(entry=lambda _name: None),
    )

    assert len(outcomes) == 1
    outcome = outcomes[0]
    assert not outcome.success
    assert outcome.error_code == CMP_TOOL_INVALID_PATH
    assert outcome.output == (
        f"Tool 'read_file' failed: {sentence}"
        " Review the error and retry with corrected arguments if applicable."
    )
    if "glob_files" in message:
        assert "glob_files." in outcome.output
    assert ".." not in outcome.output


@pytest.mark.parametrize("phase", ["preflight", "dispatch"])
@pytest.mark.parametrize("ending", [".", ""], ids=["period", "no-period"])
def test_malformed_arguments_message(
    monkeypatch: pytest.MonkeyPatch, phase: str, ending: str
) -> None:
    message = f"path must be a string{ending}"
    failure = ToolExecutionFailure(code=CMP_TOOL_INVALID_PATH, message=message, retryable=False)
    descriptor = SimpleNamespace(
        name="read_file",
        side_effecting=False,
        input_schema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
        server_name="tools",
    )
    kernel = SimpleNamespace(
        _config=SimpleNamespace(),
        _mcp_client=SimpleNamespace(tool_descriptor=lambda _name: descriptor),
    )
    call = ToolCallRequest(tool_id="read_file", arguments={"path": 42}, call_id="c1")

    def reject(**_kwargs: Any) -> None:
        raise failure

    if phase == "preflight":
        monkeypatch.setattr(tool_execution_support, "validate_tool_arguments", reject)
        refusal = prevalidate_call_arguments(kernel=kernel, call=call, tool_contract=None)
        assert refusal is not None
        output = refusal["message"]
        metadata = refusal["metadata"]
    else:
        def reject_descriptor(*_args: Any) -> None:
            raise failure

        monkeypatch.setattr(tool_execution, "validate_descriptor_arguments", reject_descriptor)
        outcome = tool_execution.execute_tool(
            kernel, call, request_id="req-1", read_snapshot_cache={}
        )
        assert not outcome.success
        output = outcome.output
        metadata = outcome.metadata

    assert output == (
        "Tool 'read_file' rejected malformed arguments: path must be a string."
        ' Required keys: path. Minimal valid arguments: {"path": "<string>"}.'
    )
    assert ".." not in output
    assert metadata["validation_error"] == message
