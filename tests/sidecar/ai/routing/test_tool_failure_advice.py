"""W1: replace the class-blind retry advice behind the envelope flag.

Today every recovered `ToolExecutionFailure` appends "Review the error and
retry with corrected arguments if applicable." — actively wrong for denied,
unavailable, and precondition_unmet. Flag ON: the sentence is gone (the
envelope's retry/fix lines carry the per-class advice; envelope text never
persists, and this sentence lives in persisted output_text). Flag OFF (or no
config on the kernel): byte-identical to today.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_call_execution import execute_tool_calls_sequentially
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import ToolCallRequest

_CLASS_BLIND_SENTENCE = "Review the error and retry with corrected arguments if applicable."


class _Contract:
    def entry(self, _name: str) -> Any | None:
        return None


class _Kernel:
    def __init__(self, failure: ToolExecutionFailure, config: Any | None = None) -> None:
        self._failure = failure
        if config is not None:
            self._config = config

    def _assert_valid_tool_call(self, _call: ToolCallRequest) -> None:
        return

    def _assistant_tool_call_message(self, _result: Any, call: ToolCallRequest) -> dict[str, object]:
        return {"role": "assistant", "tool": call.tool_id}

    def _tool_result_message(
        self, call: ToolCallRequest, _outcome: ToolExecutionOutcome
    ) -> dict[str, object]:
        return {"role": "tool", "tool": call.tool_id}

    def _execute_tool(self, call: ToolCallRequest, **_kwargs: Any) -> ToolExecutionOutcome:
        raise self._failure

    def _update_read_snapshot_cache(self, _cache: dict[str, Any], **_kwargs: Any) -> None:
        return


def _run_failure(kernel: _Kernel) -> ToolExecutionOutcome:
    runtime = LoopRuntime(
        emit=lambda _event: None,
        request_id="req-1",
        session_id="session-1",
        streaming=False,
        tool_call_limit=20,
    )
    outcomes: list[ToolExecutionOutcome] = []
    call = ToolCallRequest(tool_id="write_file", arguments={"path": "a"}, call_id="c1")
    execute_tool_calls_sequentially(
        indexed_calls=[(call, 1)],
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
        tool_contract=_Contract(),
    )
    assert len(outcomes) == 1
    return outcomes[0]


def _denied_failure() -> ToolExecutionFailure:
    return ToolExecutionFailure(
        code="CMP-TOOL-0003",
        message="write outside the workspace is not permitted",
        retryable=False,
        error_details={"failure_class": "denied", "effects": "none"},
    )


def test_flag_off_keeps_todays_sentence_byte_identical() -> None:
    outcome = _run_failure(_Kernel(_denied_failure()))
    assert outcome.output == (
        "Tool 'write_file' failed: write outside the workspace is not permitted. "
        + _CLASS_BLIND_SENTENCE
    )


def test_flag_on_drops_the_class_blind_sentence_but_keeps_the_message() -> None:
    config = SimpleNamespace(tool_result_envelope_enabled=True)
    outcome = _run_failure(_Kernel(_denied_failure(), config=config))
    assert _CLASS_BLIND_SENTENCE not in outcome.output
    assert "write outside the workspace is not permitted" in outcome.output
    assert outcome.success is False
    assert outcome.error_code == "CMP-TOOL-0003"


def test_failure_metadata_still_routes_through_blocked_outcome() -> None:
    config = SimpleNamespace(tool_result_envelope_enabled=True)
    outcome = _run_failure(_Kernel(_denied_failure(), config=config))
    assert outcome.metadata.get("failure_class") == "denied"
    assert outcome.metadata.get("effects") == "none"
