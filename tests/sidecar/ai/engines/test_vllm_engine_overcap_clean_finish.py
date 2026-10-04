"""A tool call dropped at a provider cap under a clean finish is never an answer.

Sweep W3-B1 (1.2.0 gate follow-up, row B1). ``dcc8410b7`` flagged a dropped
tool call only when the provider finish was ``length``. The normalizer also
rejects tool input at the per-call argument-bytes cap and the tool-call-count
cap; when the model finished its call cleanly (``stop`` / ``tool_calls``) the
result carried no tool call, no flag, and the text preamble became the final
answer: no tool, no checkpoint, no error.

The Ollama engine does not share the gap: its normalizer is diagnostic-only and
the engine hands the whole calls to the loop, whose provider-limit validation
rejects them visibly as tool errors.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import pytest

from sidecar.ai.routing.provider_tool_limits import (
    MAX_PROVIDER_TOOL_CALLS,
    MAX_TOOL_CALL_ARGUMENT_BYTES,
)
from sidecar.ai.routing.thinking_checkpoint import is_thinking_budget_checkpoint
from sidecar.ai.routing.tool_call_canonicalization import (
    validate_provider_tool_call_limits,
)
from sidecar.runtime.turn_diagnostics import TurnDiagnosticsStore
from tests.sidecar.ai.engines import test_vllm_engine as vllm_test
from tests.sidecar.ai.engines.test_ollama_stream_terminal_evidence import (
    _build_engine as _build_ollama_engine,
)
from tests.sidecar.ai.engines.test_ollama_stream_terminal_evidence import (
    _drain_tool_stream,
)
from tests.sidecar.ai.engines.test_ollama_stream_terminal_evidence import (
    _patch_stream as _patch_ollama_stream,
)
from tests.sidecar.ai.engines.test_vllm_engine_truncated_tool_call import (  # noqa: F401 - autouse fixture
    _B1_PREAMBLE,
    _RecordingStore,
    _release_engines,
    _terminal_line,
    _tool_fragment_line,
)

_REJECTED_EVENT = "ai.engines.vllm.tool_call_rejected"


def _over_bytes_lines(terminal: str) -> list[str]:
    """A preamble, then one write_file call whose arguments pass the byte cap."""
    piece = "Section text about arithmetic tests. " * 100
    pieces = [piece] * (MAX_TOOL_CALL_ARGUMENT_BYTES // len(piece) + 2)
    return [
        vllm_test._sse_chunk({"content": _B1_PREAMBLE}),
        _tool_fragment_line(
            0, '{"path": "big.md", "content": "', first=True, name="write_file"
        ),
        *(_tool_fragment_line(0, fragment) for fragment in pieces),
        _tool_fragment_line(0, '"}'),
        _terminal_line(terminal),
        "data: [DONE]",
    ]


def _over_count_lines(terminal: str) -> list[str]:
    """A preamble, then one more complete read_file call than the count cap allows."""
    calls = [
        _tool_fragment_line(
            index,
            json.dumps({"path": f"notes/{index}.md"}),
            first=True,
            name="read_file",
            call_id=f"call-{index}",
        )
        for index in range(MAX_PROVIDER_TOOL_CALLS + 1)
    ]
    return [
        vllm_test._sse_chunk({"content": _B1_PREAMBLE}),
        *calls,
        _terminal_line(terminal),
        "data: [DONE]",
    ]


_STREAMS = {"argument_bytes": _over_bytes_lines, "tool_call_count": _over_count_lines}


@pytest.mark.parametrize("terminal", ["stop", "tool_calls", "length"])
@pytest.mark.parametrize("reason", ["argument_bytes", "tool_call_count"])
def test_cap_rejected_call_is_flagged_with_its_reason_under_any_finish(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    reason: str,
    terminal: str,
) -> None:
    engine = vllm_test._make_streaming_engine(monkeypatch)
    store = _RecordingStore()
    engine.begin_request_context(request_id="req-w3b1", diagnostics_store=store)
    vllm_test._patch_stream_response(
        monkeypatch,
        vllm_test._FakeSSEStream(_STREAMS[reason](terminal)),
    )

    with caplog.at_level(logging.INFO):
        _chunks, result = vllm_test._drain_stream(
            engine.stream_with_tools(prompt="write it", tools=[], max_tokens=16_384)
        )

    # Dogfood MQ-033: the stream stops reading at the rejecting chunk, so the provider's
    # own terminal is never read and every case takes the clean-stop mapping.
    expected_finish = "stop"
    observed = (
        f"finish={result.finish_reason!r} tool_calls={len(result.tool_calls)} "
        f"content={result.content!r} "
        f"tool_call_truncated={result.tool_call_truncated!r} "
        f"checkpoint={is_thinking_budget_checkpoint(result)!r}"
    )
    assert result.finish_reason == expected_finish, observed
    assert result.tool_calls == (), observed
    assert result.content == _B1_PREAMBLE, observed
    assert result.tool_call_truncated is True, observed
    assert getattr(result, "tool_call_rejected_reason", None) == reason, observed
    assert is_thinking_budget_checkpoint(result) is True, observed
    counters = store.recorded("record_stream_counters")[-1]["counters"]
    assert counters.get("tool_call_rejected_count") == 1, counters
    assert counters["tool_call_completed_count"] == 0
    records = [r for r in caplog.records if getattr(r, "event", "") == _REJECTED_EVENT]
    assert len(records) == 1
    assert records[0].levelno == logging.WARNING
    assert getattr(records[0], "data", None) == {
        "model": engine.model_name,
        "reason": reason,
        "finish_reason": expected_finish,
        "terminal_finish_reason": "",
    }


@pytest.mark.parametrize("terminal", ["stop", "length"])
def test_text_only_answer_is_not_flagged(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    terminal: str,
) -> None:
    engine = vllm_test._make_streaming_engine(monkeypatch)
    store = _RecordingStore()
    engine.begin_request_context(request_id="req-text", diagnostics_store=store)
    vllm_test._patch_stream_response(
        monkeypatch,
        vllm_test._FakeSSEStream(
            [
                vllm_test._sse_chunk({"content": "The answer is 42."}),
                _terminal_line(terminal),
                "data: [DONE]",
            ]
        ),
    )

    with caplog.at_level(logging.INFO):
        _chunks, result = vllm_test._drain_stream(
            engine.stream_with_tools(prompt="answer", tools=[], max_tokens=16_384)
        )

    assert result.content == "The answer is 42."
    assert result.tool_call_truncated is False
    assert getattr(result, "tool_call_rejected_reason", "") == ""
    assert is_thinking_budget_checkpoint(result) is False
    counters = store.recorded("record_stream_counters")[-1]["counters"]
    assert counters.get("tool_call_rejected_count", 0) == 0
    assert not [r for r in caplog.records if getattr(r, "event", "") == _REJECTED_EVENT]


def test_under_cap_call_under_a_clean_stop_runs_and_is_not_flagged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = vllm_test._make_streaming_engine(monkeypatch)
    vllm_test._patch_stream_response(
        monkeypatch,
        vllm_test._FakeSSEStream(
            [
                vllm_test._sse_chunk({"content": _B1_PREAMBLE}),
                _tool_fragment_line(
                    0, '{"path": "small.md", "content": "hi"}', first=True, name="write_file"
                ),
                _terminal_line("tool_calls"),
                "data: [DONE]",
            ]
        ),
    )

    _chunks, result = vllm_test._drain_stream(
        engine.stream_with_tools(prompt="write it", tools=[], max_tokens=16_384)
    )

    assert [call.tool_id for call in result.tool_calls] == ["write_file"]
    assert result.finish_reason == "tool_calls"
    assert result.tool_call_truncated is False
    assert is_thinking_budget_checkpoint(result) is False


def test_turn_dump_provider_call_entry_records_the_rejection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = vllm_test._make_streaming_engine(monkeypatch)
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req-dump", session_id="sess", mode="assist")
    engine.begin_request_context(request_id="req-dump", diagnostics_store=store)
    vllm_test._patch_stream_response(
        monkeypatch,
        vllm_test._FakeSSEStream(_over_bytes_lines("stop")),
    )

    vllm_test._drain_stream(
        engine.stream_with_tools(prompt="write it", tools=[], max_tokens=16_384)
    )

    snapshot = store.get_snapshot_for_request("req-dump")
    assert snapshot is not None
    calls: list[dict[str, Any]] = snapshot["provider_calls"]
    assert calls, snapshot
    assert calls[-1]["stream_counters"].get("tool_call_rejected_count") == 1
    assert snapshot["stream_counters"].get("tool_call_rejected_count") == 1


# ---------------------------------------------------------------------------
# Ollama: whole calls per chunk; the normalizer only counts. An over-cap call
# reaches the loop, whose provider-limit validation rejects it as a visible
# tool error, so the preamble is never finalized as the answer.
# ---------------------------------------------------------------------------


def test_ollama_over_cap_calls_reach_the_loop_and_are_rejected_visibly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = _build_ollama_engine()
    big = "x" * (MAX_TOOL_CALL_ARGUMENT_BYTES + 1_024)
    many = [
        {"function": {"name": "read_file", "arguments": {"path": f"n/{index}.md"}}}
        for index in range(MAX_PROVIDER_TOOL_CALLS)
    ]
    _patch_ollama_stream(
        monkeypatch,
        [
            {"message": {"content": _B1_PREAMBLE}, "done": False},
            {
                "message": {
                    "tool_calls": [
                        {"function": {"name": "write_file", "arguments": {"content": big}}},
                        *many,
                    ]
                },
                "done": False,
            },
            {"message": {"content": ""}, "done": True, "done_reason": "stop"},
        ],
    )

    _chunks, result = _drain_tool_stream(
        engine.stream_with_tools(prompt="write it", tools=[], max_tokens=16_384)
    )

    assert result.finish_reason == "tool_calls"
    assert len(result.tool_calls) == MAX_PROVIDER_TOOL_CALLS + 1
    _accepted, rejected = validate_provider_tool_call_limits(result.tool_calls)
    messages = [failure.message for _call, failure in rejected]
    assert any("per-call limit" in message for message in messages), messages
    assert any("exceeds 128 calls" in message for message in messages), messages
