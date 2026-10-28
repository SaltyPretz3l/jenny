"""A recovered tool failure's class honours the failing call's own retryable flag."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_call_execution import execute_tool_calls_sequentially
from sidecar.ai.routing.tool_execution_results import tool_result_message
from sidecar.ai.tools.contracts import ToolExecutionFailure
from tests.sidecar.ai.routing.test_tool_call_execution import (
    _call,
    _contract,
    _Kernel,
    _runtime,
)


def _recovered_outcome(failure: ToolExecutionFailure) -> ToolExecutionOutcome:
    kernel = _Kernel()
    kernel.failures["read_file"] = failure
    runtime, _events = _runtime(streaming=False)
    outcomes: list[ToolExecutionOutcome] = []
    execute_tool_calls_sequentially(
        indexed_calls=[(_call("read_file"), 1)],
        runtime=runtime,
        kernel=kernel,
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
        tool_contract=_contract({}),
    )
    assert len(outcomes) == 1
    return outcomes[0]


@pytest.mark.parametrize(
    ("retryable", "expected_class", "expected_retry"),
    [(False, "precondition_unmet", "after_fix"), (True, "transient", "same_args")],
)
def test_io_failed_class_follows_the_call_retryable_flag(
    retryable: bool, expected_class: str, expected_retry: str
) -> None:
    outcome = _recovered_outcome(
        ToolExecutionFailure(code=CMP_TOOL_IO_FAILED, message="access denied", retryable=retryable)
    )

    assert outcome.success is False
    assert outcome.error_code == CMP_TOOL_IO_FAILED
    assert outcome.metadata["failure_class"] == expected_class
    message = tool_result_message(
        _call("read_file"), outcome, SimpleNamespace(tool_result_envelope_enabled=True)
    )
    assert expected_class in str(message["content"])
    assert expected_retry in str(message["content"])


def test_explicit_failure_class_detail_still_wins() -> None:
    outcome = _recovered_outcome(
        ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED, message="gone", retryable=False,
            error_details={"failure_class": "unavailable"},
        )
    )

    assert outcome.metadata["failure_class"] == "unavailable"
