from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.error_codes import CMP_LOOP_CYCLE_DETECTED
from sidecar.ai.feature_flags import FEATURE_LOOP_RESULT_AWARE_SIGNATURE
from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.loop_stop import LoopState, StopController, StopDecision, StopReason
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_loop_calls import _ToolCallPhasesMixin
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from tests.sidecar.ai.routing.test_tool_loop import (
    _build_router,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)


class _ResultClient(_StubMCPClient):
    def __init__(self, outputs: list[str]) -> None:
        super().__init__(
            (
                MCPToolDescriptor(
                    name="remote_lookup",
                    description="Look up the current value.",
                    input_schema={"type": "object", "properties": {}},
                    side_effecting=False,
                    server_name="scripted",
                ),
            )
        )
        self.outputs = iter(outputs)

    def execute_tool(self, *args: Any, **kwargs: Any) -> object:
        result = super().execute_tool(*args, **kwargs)
        assert isinstance(result, SimpleNamespace)
        result.output = next(self.outputs)
        return result


def _run_script(
    outputs: list[str],
    *,
    expect_cycle: bool = False,
    result_aware: bool | None = None,
) -> tuple[int, str]:
    client = _ResultClient(outputs)
    engine = _ToolLoopEngine(
        [
            *(
                _ToolPlan(
                    result=GenerationResult(
                        content="Checking progress.",
                        finish_reason="tool_calls",
                        tool_calls=(
                            ToolCallRequest(
                                tool_id="remote_lookup",
                                arguments={},
                                call_id=f"call-{index}",
                            ),
                        ),
                    )
                )
                for index in range(len(outputs))
            ),
            _ToolPlan(result=GenerationResult(content="Finished checking.", finish_reason="stop")),
        ]
    )
    router = _build_router(
        engine=engine,
        mcp_client=client,
        extra_snapshot_tools=("remote_lookup",),
    )
    flags = {"token_budget": False}
    if result_aware is not None:
        flags[FEATURE_LOOP_RESULT_AWARE_SIGNATURE] = result_aware
    router._config = replace(router._config, feature_flags=flags)
    decision = router.build_chat_decision(
        request_id="req-result-signature",
        messages=[{"role": "user", "content": "Check progress until finished."}],
        latest_user_content="Check progress until finished.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(request_id="req-result-signature", max_iterations=10),
    )
    assert (
        any(
            "same tool call has now run three times" in json.dumps(request)
            for request in engine.requests
        )
        is expect_cycle
    )
    return len(client.executions), decision.response_text


def test_changing_results_complete_five_real_tool_loop_iterations() -> None:
    executions, response = _run_script([f"value={index}" for index in range(5)])
    assert executions == 5
    assert response == "Finished checking."


def test_identical_results_still_hint_in_the_real_tool_loop() -> None:
    executions, response = _run_script(["same"] * 3, expect_cycle=True)
    assert executions == 3
    assert response == "Finished checking."


def test_flag_off_still_hints_for_changing_results_in_the_real_tool_loop() -> None:
    executions, response = _run_script(
        [f"value={index}" for index in range(5)],
        expect_cycle=True,
        result_aware=False,
    )
    assert executions == 5
    assert response == "Finished checking."


def test_volatile_result_fields_have_the_canonical_digest() -> None:
    from sidecar.ai.routing.tool_observation import result_digest

    expected = hashlib.sha256(b'{"items":[{"value":42}]}').hexdigest()[:16]
    outputs = [
        json.dumps(
            {
                "pid": index,
                "items": [
                    {"value": 42, "elapsed_ms": index, "timestamp": f"2026-10-15T12:00:0{index}Z"}
                ],
            }
        )
        for index in range(3)
    ]
    assert [result_digest(output) for output in outputs] == [expected] * 3


@pytest.mark.parametrize("state", ["running", "queued", "pending"])
def test_pending_polls_complete_five_real_tool_loop_iterations(state: str) -> None:
    output = json.dumps(
        {
            "schema_version": 1,
            "job_id": "job-1",
            "state": state,
            "pid": 123,
            "ledger_entry": None,
        }
    )
    executions, response = _run_script([output] * 5)
    assert executions == 5
    assert response == "Finished checking."


def _call(command: str, call_id: str = "call-1") -> ToolCallRequest:
    return ToolCallRequest(tool_id="run_command", arguments={"command": command}, call_id=call_id)


def _harness(enabled: bool = True) -> SimpleNamespace:
    return SimpleNamespace(
        feature_flags={FEATURE_LOOP_RESULT_AWARE_SIGNATURE: enabled},
        tool_call_history=(),
        error_output_history=(),
        cycle_hint_attempted=False,
    )


def _step(
    loop: SimpleNamespace,
    calls: tuple[ToolCallRequest, ...],
    outcomes: list[ToolExecutionOutcome] | tuple[ToolExecutionOutcome, ...] = (),
    error: str | None = None,
) -> StopReason | None:
    loop.tool_call_history, loop.error_output_history = _ToolCallPhasesMixin._advance_cycle_history(
        loop,
        loop.tool_call_history,
        loop.error_output_history,
        calls,
        error,
        outcomes,
    )
    controller = StopController(LoopRuntime(request_id="req-signature-unit"))
    reason = controller._check_cycle(
        LoopState(
            iteration=1,
            max_iterations=20,
            elapsed_seconds=0.1,
            last_tool_calls=calls,
            tool_call_history=loop.tool_call_history,
            error_output_history=loop.error_output_history,
            last_error_output=error,
            current_tool_signatures=loop.current_tool_signatures,
            cycle_hint_attempted=loop.cycle_hint_attempted,
        )
    )
    loop.cycle_hint_attempted |= reason is not None
    return reason


def _sequence(commands: list[str], outputs: list[str], *, enabled: bool = True) -> tuple:
    loop = _harness(enabled)
    histories, reasons = [], []
    for index, (command, output) in enumerate(zip(commands, outputs, strict=True)):
        call = _call(command, f"call-{index}")
        reasons.append(
            _step(
                loop,
                (call,),
                [
                    ToolExecutionOutcome(
                        tool_name=call.tool_id,
                        output=output,
                        success=True,
                        call_id=call.call_id,
                    )
                ],
            )
        )
        histories.append(loop.tool_call_history)
    return histories, reasons


def _repeat_reason(decision: StopDecision = StopDecision.DEGRADE) -> StopReason:
    return StopReason(
        decision=decision,
        message="Detected repeated tool calls. Please review and adjust.",
        code=CMP_LOOP_CYCLE_DETECTED,
        user_hint=(
            "The same tool call has now run three times without new information. "
            "Stop calling tools, summarize what you found so far, and tell the user "
            "what you could not resolve."
        ),
    )


def _alternating_reason() -> StopReason:
    return StopReason(
        decision=StopDecision.DEGRADE,
        message="Detected repeated tool calls. Please review and adjust.",
        code=CMP_LOOP_CYCLE_DETECTED,
        user_hint=(
            "The last several tool calls alternated between the same two requests "
            "without new information. Stop calling tools, summarize what you found "
            "so far, and tell the user what you could not resolve."
        ),
    )


def _request_signature(command: str) -> tuple[str, ...]:
    fingerprint = hashlib.sha256(
        json.dumps({"command": command}, separators=(",", ":")).encode(),
    ).hexdigest()[:16]
    return (f"run_command:{fingerprint}",)


def test_changing_results_do_not_cycle_and_history_retains_result_digests() -> None:
    outputs = [f"value={index}" for index in range(5)]
    histories, reasons = _sequence(["A"] * 5, outputs)
    expected = tuple(
        (f"{_request_signature('A')[0]}:{hashlib.sha256(output.encode()).hexdigest()[:16]}",)
        for output in outputs
    )
    assert histories == [expected[:index] for index in range(1, 6)]
    assert reasons == [None] * 5


def test_identical_results_degrade_on_third_execution() -> None:
    histories, reasons = _sequence(["A"] * 3, ["same"] * 3)
    assert len(histories[-1]) == 3
    assert reasons == [None, None, _repeat_reason()]


def test_alternation_uses_results_and_keeps_the_existing_six_execution_threshold() -> None:
    commands = ["A", "B"] * 3
    _, changing = _sequence(commands, [f"result-{index}" for index in range(6)])
    _, identical = _sequence(commands, ["same"] * 6)
    assert changing == [None] * 6
    assert identical == [None] * 5 + [_alternating_reason()]


@pytest.mark.parametrize("state", ["running", "queued", "pending"])
def test_pending_poll_batches_do_not_advance_history(state: str) -> None:
    histories, reasons = _sequence(["A"] * 8, [json.dumps({"state": state, "pid": 1})] * 8)
    assert histories == [()] * 8
    assert reasons == [None] * 8


def test_terminal_polls_repeat_at_three() -> None:
    output = '{"state":"completed","exit_code":0,"job_id":"job-1","pid":123}'
    _, reasons = _sequence(["A"] * 3, [output] * 3)
    assert reasons == [None, None, _repeat_reason()]


@pytest.mark.parametrize(
    "outputs",
    [
        [f"value={index}" for index in range(5)],
        ['{"state":"running","pid":123}'] * 5,
        ['{"state":"completed","exit_code":0}'] * 5,
    ],
)
def test_flag_off_pins_exact_repeat_histories_and_decisions(outputs: list[str]) -> None:
    histories, reasons = _sequence(["A"] * 5, outputs, enabled=False)
    signature = _request_signature("A")
    assert histories == [
        (signature,),
        (signature, signature),
        (signature, signature, signature),
        (signature, signature, signature, signature),
        (signature, signature, signature, signature, signature),
    ]
    assert reasons == [
        None,
        None,
        _repeat_reason(),
        _repeat_reason(StopDecision.STOP),
        _repeat_reason(StopDecision.STOP),
    ]


@pytest.mark.parametrize("outputs", [[f"value={index}" for index in range(6)], ["same"] * 6])
def test_flag_off_pins_exact_alternating_histories_and_decisions(outputs: list[str]) -> None:
    histories, reasons = _sequence(["A", "B"] * 3, outputs, enabled=False)
    a, b = _request_signature("A"), _request_signature("B")
    assert histories == [
        (a,),
        (a, b),
        (a, b, a),
        (a, b, a, b),
        (a, b, a, b, a),
        (a, b, a, b, a, b),
    ]
    assert reasons == [None] * 5 + [_alternating_reason()]


def test_volatile_json_and_text_results_still_cycle() -> None:
    outputs = [
        json.dumps(
            {
                "value": 42,
                "pid": index,
                "nested": [{"elapsed_ms": index}],
                "timestamp": f"2026-10-15T12:00:0{index}Z",
            }
        )
        for index in range(3)
    ]
    _, reasons = _sequence(["A"] * 3, outputs)
    assert reasons == [None, None, _repeat_reason()]
    _, reasons = _sequence(
        ["A"] * 3,
        [
            "ok at 2026-10-15T12:00:00Z in 12.3s / 450ms / 0:00:03",
            "ok at 2026-10-15T13:00:00+01:00 in 14.8s / 123ms / 0:00:05",
            "ok at 2026-10-15T14:00:00.123-02:00 in 15s / 890ms / 1:00:40",
        ],
    )
    assert reasons == [None, None, _repeat_reason()]


def test_results_match_by_call_id_and_pending_members_are_excluded() -> None:
    loop = _harness()
    a, b = _call("A", "a"), _call("B", "b")
    for index in range(5):
        assert (
            _step(
                loop,
                (a, b),
                [
                    ToolExecutionOutcome(
                        tool_name=b.tool_id, call_id="b", success=True, output='{"state":"running"}'
                    ),
                    ToolExecutionOutcome(
                        tool_name=a.tool_id, call_id="a", success=True, output=f"result-{index}"
                    ),
                ],
            )
            is None
        )
    assert all(len(batch) == 1 for batch in loop.tool_call_history)
    assert all(
        batch[0].startswith(_request_signature("A")[0] + ":") for batch in loop.tool_call_history
    )


def test_missing_outcomes_use_empty_digest_and_clear_the_previous_batch() -> None:
    loop = _harness()
    call = _call("A")
    outcome = ToolExecutionOutcome(
        tool_name=call.tool_id,
        output="first",
        success=True,
        call_id=call.call_id,
    )
    assert _step(loop, (call,), [outcome]) is None
    for _ in range(2):
        assert _step(loop, (call,)) is None
    assert _step(loop, (call,)) == _repeat_reason()
    assert loop.tool_call_history[1:] == ((_request_signature("A")[0] + ":",),) * 3


def test_wait_batch_does_not_recheck_previous_repeated_batch() -> None:
    loop = _harness()
    a, b = _call("A", "a"), _call("B", "b")
    for _ in range(3):
        _step(loop, (a,))
    previous = loop.tool_call_history
    pending = ToolExecutionOutcome(
        tool_name=b.tool_id,
        output='{"state":"running"}',
        success=True,
        call_id="b",
    )
    assert _step(loop, (b,), [pending]) is None
    assert loop.tool_call_history == previous


@pytest.mark.parametrize("enabled", [True, False])
def test_error_output_rule_is_unchanged_for_wait_batches(enabled: bool) -> None:
    loop = _harness(enabled)
    call = _call("A")
    pending = ToolExecutionOutcome(
        tool_name=call.tool_id,
        output='{"state":"running"}',
        success=False,
        call_id=call.call_id,
    )
    assert _step(loop, (call,), [pending], "failed") is None
    reason = _step(loop, (call,), [pending], "failed")
    assert reason is not None
    assert reason.decision == StopDecision.DEGRADE
    assert reason.message == "Detected repeated error output. Breaking to avoid loop."
    assert loop.error_output_history == ("failed", "failed")


def test_digest_empty_and_canonical_json() -> None:
    from sidecar.ai.routing.tool_observation import result_digest

    assert result_digest("") == ""
    assert result_digest(' { "b": [2, {"pid": 1}], "a": true } ') == result_digest(
        '{"a":true,"b":[2,{}]}',
    )
    assert result_digest("null") == hashlib.sha256(b"null").hexdigest()[:16]


def test_deep_json_that_parses_falls_back_to_a_text_digest() -> None:
    from sidecar.ai.routing.tool_observation import result_digest

    depth = 600  # parses under the default limit, but normalising it used to overflow
    deep = '{"a":' * depth + "1" + "}" * depth
    digest = result_digest(deep)
    assert len(digest) == 16
    assert digest == result_digest(deep)
