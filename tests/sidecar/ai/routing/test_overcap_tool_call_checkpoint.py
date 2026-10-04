"""A cap-rejected tool call under a clean finish continues or fails, never completes.

Sweep W3-B1 (1.2.0 gate follow-up, row B1): the engine side lives in
``tests/sidecar/ai/engines/test_vllm_engine_overcap_clean_finish.py``. Here the
checkpoint predicate, the continuation note, and the loop finalize: a result
whose only tool call was rejected at the argument-bytes or tool-call-count cap
continues from a checkpoint with a note naming the limit, or fails retryably
with CMP-STREAM-INCOMPLETE when continuation cannot run. A text-only ``stop``
answer stays final.
"""

from __future__ import annotations

from typing import Any

import pytest

from sidecar.ai.routing.provider_tool_limits import (
    MAX_PROVIDER_TOOL_CALLS,
    MAX_TOOL_CALL_ARGUMENT_BYTES,
)
from sidecar.ai.routing.thinking_checkpoint import (
    build_checkpoint_messages,
    is_thinking_budget_checkpoint,
)
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from tests.sidecar.ai.engines.test_thinking_budget_abort import (
    _drain as _drain_engine,
)
from tests.sidecar.ai.engines.test_thinking_budget_abort import _patch_vllm_stream
from tests.sidecar.ai.engines.test_vllm_engine_overcap_clean_finish import (
    _over_bytes_lines,
    _over_count_lines,
)
from tests.sidecar.ai.engines.test_vllm_engine_truncated_tool_call import _B1_PREAMBLE
from tests.sidecar.ai.routing.test_thinking_budget_checkpoint import (
    _CHECKPOINT_LIMIT,
    _result,
    _run_results,
)

_BYTE_LIMIT_TEXT = f"{MAX_TOOL_CALL_ARGUMENT_BYTES:,}-byte per-call argument limit"
_COUNT_LIMIT_TEXT = f"more than {MAX_PROVIDER_TOOL_CALLS} tool calls"
_TOKEN_LIMIT_TEXT = "cut off at the output-token limit"


def _rejected(finish_reason: str, reason: str, **kwargs: Any) -> GenerationResult:
    kwargs.setdefault("thinking_text", "I will write the whole tutorial in one call.")
    return GenerationResult(
        content=_B1_PREAMBLE,
        finish_reason=finish_reason,
        tool_call_truncated=True,
        tool_call_rejected_reason=reason,
        **kwargs,
    )


def _system_notes(run: object) -> list[str]:
    return [
        str(message.get("content", ""))
        for message in getattr(run, "working_messages", [])
        if message.get("role") == "system"
    ]


# -- predicate ---------------------------------------------------------------


@pytest.mark.parametrize("finish_reason", ["stop", "tool_calls", "length"])
@pytest.mark.parametrize("reason", ["argument_bytes", "tool_call_count"])
def test_a_cap_rejection_is_a_checkpoint_under_any_clean_finish(
    finish_reason: str, reason: str
) -> None:
    assert is_thinking_budget_checkpoint(_rejected(finish_reason, reason)) is True


def test_a_cap_rejection_beside_a_runnable_call_is_not_a_checkpoint() -> None:
    call = ToolCallRequest(tool_id="read_file", arguments={"path": "a.md"}, call_id="c1")
    result = _rejected("tool_calls", "argument_bytes", tool_calls=(call,))

    assert is_thinking_budget_checkpoint(result) is False


@pytest.mark.parametrize("finish_reason", ["incomplete", "error"])
def test_a_cap_rejection_on_a_broken_stream_keeps_the_cut_off_path(
    finish_reason: str,
) -> None:
    assert is_thinking_budget_checkpoint(_rejected(finish_reason, "argument_bytes")) is False


def test_a_text_only_stop_is_not_a_checkpoint() -> None:
    assert is_thinking_budget_checkpoint(_result("stop", content="The answer.")) is False


# -- continuation note ---------------------------------------------------------


def test_the_note_names_the_byte_limit_by_value() -> None:
    notes = [
        str(message["content"])
        for message in build_checkpoint_messages(
            "reasoning",
            tool_call_truncated=True,
            tool_call_rejected_reason="argument_bytes",
        )
        if message["role"] == "system"
    ]

    assert any(_BYTE_LIMIT_TEXT in note and "split" in note for note in notes), notes
    assert not any(_TOKEN_LIMIT_TEXT in note for note in notes), notes


def test_the_note_names_the_call_count_limit_by_value() -> None:
    notes = [
        str(message["content"])
        for message in build_checkpoint_messages(
            "reasoning",
            tool_call_truncated=True,
            tool_call_rejected_reason="tool_call_count",
        )
        if message["role"] == "system"
    ]

    assert any(_COUNT_LIMIT_TEXT in note for note in notes), notes


def test_the_token_limit_note_is_unchanged_without_a_rejection() -> None:
    notes = [
        str(message["content"])
        for message in build_checkpoint_messages("reasoning", tool_call_truncated=True)
        if message["role"] == "system"
    ]

    assert any(_TOKEN_LIMIT_TEXT in note for note in notes), notes


# -- loop finalize -------------------------------------------------------------


@pytest.mark.parametrize(
    ("lines", "note_text"),
    [
        (_over_bytes_lines("stop"), _BYTE_LIMIT_TEXT),
        (_over_count_lines("stop"), _COUNT_LIMIT_TEXT),
    ],
    ids=["argument_bytes", "tool_call_count"],
)
def test_engine_result_under_a_clean_stop_continues_with_the_limit_note(
    monkeypatch: pytest.MonkeyPatch,
    lines: list[str],
    note_text: str,
) -> None:
    engine, _response = _patch_vllm_stream(monkeypatch, lines)
    _events, dropped = _drain_engine(
        engine.stream_with_tools(prompt="write", tools=[], max_tokens=16_384)
    )

    decision, run, _runtime, sequence = _run_results(
        monkeypatch,
        [dropped, _result("stop", content="Decisive answer.")],
        max_iterations=4,
    )

    assert decision.response_text != _B1_PREAMBLE, "the preamble was finalized as the answer"
    assert run.thinking_budget_checkpoints == 1
    assert len(sequence.calls) == 2
    assert decision.response_text == "Decisive answer."
    assert decision.terminal_error_code is None
    assert any(note_text in note for note in _system_notes(run)), _system_notes(run)


@pytest.mark.parametrize("finish_reason", ["stop", "tool_calls"])
@pytest.mark.parametrize(
    ("max_iterations", "continuation_enabled"),
    # A checkpoint on the last iteration now continues (TR-005), so only the
    # kill switch leaves a checkpoint that cannot continue.
    [(4, False)],
    ids=["continuation_disabled"],
)
def test_a_clean_finish_cap_rejection_that_cannot_continue_fails_retryably(
    monkeypatch: pytest.MonkeyPatch,
    max_iterations: int,
    continuation_enabled: bool,
    finish_reason: str,
) -> None:
    if not continuation_enabled:
        monkeypatch.setenv("JENNY_ENABLE_THINKING_BUDGET_CONTINUATION", "0")

    decision, _run, _runtime, _sequence = _run_results(
        monkeypatch,
        [_rejected(finish_reason, "argument_bytes")],
        max_iterations=max_iterations,
    )

    assert decision.terminal_error_code == "CMP-STREAM-INCOMPLETE"
    assert decision.terminal_error_retryable is True
    assert decision.response_text != _B1_PREAMBLE
    assert "tool call" in decision.response_text


def test_a_text_only_stop_answer_stays_final(monkeypatch: pytest.MonkeyPatch) -> None:
    decision, run, _runtime, sequence = _run_results(
        monkeypatch,
        [_result("stop", content="Plain answer.")],
        max_iterations=4,
    )

    assert decision.response_text == "Plain answer."
    assert decision.terminal_error_code is None
    assert run.thinking_budget_checkpoints == 0
    assert len(sequence.calls) == 1


def test_repeated_reasoning_free_cap_rejections_stay_bounded_by_the_ladder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An empty carry does not stop a dropped call's continuation; the ladder does."""
    dropped = _rejected("stop", "argument_bytes", thinking_text="")

    decision, run, _runtime, sequence = _run_results(
        monkeypatch,
        [
            *(dropped for _cycle in range(_CHECKPOINT_LIMIT + 1)),
            _result("stop", content="I could not fit the file in one call."),
        ],
        max_iterations=_CHECKPOINT_LIMIT + 4,
    )

    assert run.thinking_budget_checkpoints == _CHECKPOINT_LIMIT
    assert len(sequence.calls) == _CHECKPOINT_LIMIT + 2
    assert sequence.calls[-1]["tools"] == []
    assert decision.response_text == "I could not fit the file in one call."
