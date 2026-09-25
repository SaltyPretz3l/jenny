"""Truncated native tool calls and guard verdict logging on the vLLM tool stream.

Split from ``test_vllm_engine_generation.py`` (at the 600-line test ratchet)."""

from __future__ import annotations

import contextlib
import json
import logging
from typing import Any

import pytest

from sidecar.ai.engines import vllm_engine_generation
from sidecar.ai.engines.vllm_engine import VLLMEngine
from sidecar.ai.exceptions import GenerationError
from sidecar.ai.routing.provider_stream_normalizer import FINISH_REASON_INCOMPLETE
from sidecar.ai.routing.provider_tool_limits import MAX_TOOL_CALL_ARGUMENT_BYTES
from sidecar.ai.routing.thinking_checkpoint import is_thinking_budget_checkpoint
from sidecar.ai.tools.models import StreamingEvent
from tests.sidecar.ai.engines import test_vllm_engine as vllm_test


@pytest.fixture(autouse=True)
def _release_engines(monkeypatch: pytest.MonkeyPatch):
    """Close every engine this module builds and drop its request binding."""
    built: list[VLLMEngine] = []
    original_init = VLLMEngine.__init__

    def _tracking_init(self, *args: Any, **kwargs: Any) -> None:
        original_init(self, *args, **kwargs)
        built.append(self)

    monkeypatch.setattr(VLLMEngine, "__init__", _tracking_init)
    yield
    for engine in built:
        with contextlib.suppress(Exception):
            engine.clear_request_context()
        with contextlib.suppress(Exception):
            engine.close()

# ---------------------------------------------------------------------------
# Truncated native tool call (owner turn 2026-09-20 20:21, Bonsai 2 27B on
# llama-server): call 3 hit n_predict while streaming a tool call's arguments.
# The partial JSON was finalized as "malformed" and raised CMP-AI-0005 before
# the finish reason was ever resolved, so the thinking-budget checkpoint never
# saw a ``length`` result. Never execute partial arguments; never make a clean
# ``stop`` over bad JSON look like truncation.
# ---------------------------------------------------------------------------


def _tool_fragment_line(
    index: int,
    fragment: str,
    *,
    first: bool = False,
    name: str = "create_artifact",
    call_id: str = "call-1",
) -> str:
    call: dict[str, Any] = {"index": index, "function": {"arguments": fragment}}
    if first:
        call.update(id=call_id, type="function")
        call["function"]["name"] = name
    return vllm_test._sse_chunk({"tool_calls": [call]})  # noqa: SLF001


def _terminal_line(finish_reason: str, *, with_delta: bool = True) -> str:
    choice: dict[str, Any] = {"finish_reason": finish_reason}
    if with_delta:
        choice["delta"] = {}
    return "data: " + json.dumps({"choices": [choice]})


_B1_PREAMBLE = "Now creating the tutorial file directly with a single write_file call."


def _preamble_length_cut_lines(argument_bytes: int) -> list[str]:
    head = '{"path": "gate-b1-long.md", "content": "# Tutorial\\n'
    piece = "Section text about arithmetic tests. "
    fragments = [head]
    total_bytes = len(head.encode("utf-8"))
    while total_bytes < argument_bytes:
        fragments.append(piece)
        total_bytes += len(piece.encode("utf-8"))
    return [
        vllm_test._sse_chunk(  # noqa: SLF001
            {"reasoning_content": "I will write the whole tutorial in one call."}
        ),
        vllm_test._sse_chunk({"content": _B1_PREAMBLE}),  # noqa: SLF001
        _tool_fragment_line(0, fragments[0], first=True, name="write_file"),
        *(_tool_fragment_line(0, fragment) for fragment in fragments[1:]),
        _terminal_line("length"),
        "data: [DONE]",
    ]


class _RecordingStore:
    """Minimal diagnostics store: records every call by method name."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__"):
            raise AttributeError(name)

        def _record(**kwargs: Any) -> None:
            self.calls.append((name, kwargs))

        return _record

    def recorded(self, name: str) -> list[dict[str, Any]]:
        return [kwargs for method, kwargs in self.calls if method == name]


@pytest.mark.parametrize(
    ("tail", "expected_finish_reason"),
    [
        ([_terminal_line("length"), "data: [DONE]"], "length"),
        ([_terminal_line("length", with_delta=False), "data: [DONE]"], "length"),
        ([_terminal_line("max_tokens"), "data: [DONE]"], "length"),
        ([], FINISH_REASON_INCOMPLETE),
    ],
)
def test_tool_stream_length_cut_tool_call_is_a_checkpoint_not_a_fatal_error(
    monkeypatch: pytest.MonkeyPatch,
    tail: list[str],
    expected_finish_reason: str,
) -> None:
    engine = vllm_test._make_streaming_engine(monkeypatch)  # noqa: SLF001
    vllm_test._patch_stream_response(  # noqa: SLF001
        monkeypatch,
        vllm_test._FakeSSEStream(  # noqa: SLF001
            [
                vllm_test._sse_chunk({"reasoning_content": "planning the file"}),  # noqa: SLF001
                _tool_fragment_line(0, '{"title": "Badge', first=True),
                _tool_fragment_line(0, ' spec", "content": "# Ba'),
                *tail,
            ]
        ),
    )

    chunks, result = vllm_test._drain_stream(  # noqa: SLF001
        engine.stream_with_tools(prompt="write it", tools=[], max_tokens=16_384)
    )

    assert result.finish_reason == expected_finish_reason
    assert result.tool_calls == ()
    assert result.content == ""
    assert result.thinking_text == "planning the file"
    assert chunks[-1] == StreamingEvent(kind="done", finish_reason=expected_finish_reason)
    if expected_finish_reason == "length":
        assert is_thinking_budget_checkpoint(result) is True


@pytest.mark.parametrize(
    ("argument_bytes", "over_cap"),
    [
        (2_000, False),
        (MAX_TOOL_CALL_ARGUMENT_BYTES + 4_000, True),
    ],
    ids=["under_cap", "over_cap"],
)
def test_tool_stream_preamble_then_length_cut_call_is_flagged_and_a_checkpoint(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    argument_bytes: int,
    over_cap: bool,
) -> None:
    engine = vllm_test._make_streaming_engine(monkeypatch)  # noqa: SLF001
    store = _RecordingStore()
    engine.begin_request_context(request_id="req-b1-preamble", diagnostics_store=store)
    vllm_test._patch_stream_response(  # noqa: SLF001
        monkeypatch,
        vllm_test._FakeSSEStream(_preamble_length_cut_lines(argument_bytes)),  # noqa: SLF001
    )

    with caplog.at_level(logging.INFO):
        _chunks, result = vllm_test._drain_stream(  # noqa: SLF001
            engine.stream_with_tools(prompt="write it", tools=[], max_tokens=16_384)
        )

    assert result.finish_reason == "length"
    assert result.tool_calls == ()
    assert result.content == _B1_PREAMBLE
    assert result.tool_call_truncated is True
    assert is_thinking_budget_checkpoint(result) is True
    if over_cap:
        counters = store.recorded("record_stream_counters")[-1]["counters"]
        assert counters["failed_count"] == 1
        assert counters["tool_call_incomplete_count"] == 0
        assert counters["tool_call_completed_count"] == 0
        records = [
            record
            for record in caplog.records
            if getattr(record, "event", "")
            == "ai.engines.vllm.tool_call_rejected"
        ]
        assert len(records) == 1
        assert records[0].levelno == logging.WARNING


def test_tool_stream_text_only_length_is_not_flagged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = vllm_test._make_streaming_engine(monkeypatch)  # noqa: SLF001
    vllm_test._patch_stream_response(  # noqa: SLF001
        monkeypatch,
        vllm_test._FakeSSEStream(  # noqa: SLF001
            [
                vllm_test._sse_chunk({"content": "Partial prose answer"}),  # noqa: SLF001
                _terminal_line("length"),
                "data: [DONE]",
            ]
        ),
    )

    _chunks, result = vllm_test._drain_stream(  # noqa: SLF001
        engine.stream_with_tools(prompt="explain", tools=[], max_tokens=16_384)
    )

    assert result.tool_call_truncated is False
    assert is_thinking_budget_checkpoint(result) is False


def test_tool_stream_clean_stop_over_bad_json_still_raises_and_publishes_counters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = vllm_test._make_streaming_engine(monkeypatch)  # noqa: SLF001
    store = _RecordingStore()
    engine.begin_request_context(request_id="req-malformed-stop", diagnostics_store=store)
    vllm_test._patch_stream_response(  # noqa: SLF001
        monkeypatch,
        vllm_test._FakeSSEStream(  # noqa: SLF001
            [
                _tool_fragment_line(0, '{"path":', first=True, name="read_file"),
                _terminal_line("stop"),
                "data: [DONE]",
            ]
        ),
    )

    with pytest.raises(GenerationError, match="malformed"):
        vllm_test._drain_stream(  # noqa: SLF001
            engine.stream_with_tools(prompt="read", tools=[])
        )

    counters = store.recorded("record_stream_counters")
    assert counters, "counters must be published even when the call raises"
    assert counters[-1]["counters"]["malformed_tool_arguments_count"] == 1
    assert counters[-1]["counters"]["tool_call_incomplete_count"] == 0
    completions = store.recorded("complete_provider_request")
    assert completions and completions[-1].get("outcome") == "failed"


def test_tool_stream_mixed_complete_and_truncated_calls_executes_only_the_complete_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = vllm_test._make_streaming_engine(monkeypatch)  # noqa: SLF001
    vllm_test._patch_stream_response(  # noqa: SLF001
        monkeypatch,
        vllm_test._FakeSSEStream(  # noqa: SLF001
            [
                _tool_fragment_line(
                    0, '{"path": "a.txt"}', first=True, name="read_file", call_id="c-ok"
                ),
                _tool_fragment_line(
                    1, '{"path": "b.', first=True, name="read_file", call_id="c-cut"
                ),
                _terminal_line("length"),
                "data: [DONE]",
            ]
        ),
    )

    _chunks, result = vllm_test._drain_stream(  # noqa: SLF001
        engine.stream_with_tools(prompt="read both", tools=[])
    )

    assert [(call.call_id, call.arguments) for call in result.tool_calls] == [
        ("c-ok", {"path": "a.txt"})
    ]
    assert result.finish_reason == "tool_calls"


def test_tool_stream_logs_the_truncated_tool_call(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    engine = vllm_test._make_streaming_engine(monkeypatch)  # noqa: SLF001
    vllm_test._patch_stream_response(  # noqa: SLF001
        monkeypatch,
        vllm_test._FakeSSEStream(  # noqa: SLF001
            [
                _tool_fragment_line(0, '{"title": "Badge', first=True),
                _terminal_line("length"),
                "data: [DONE]",
            ]
        ),
    )

    with caplog.at_level(logging.INFO):
        vllm_test._drain_stream(  # noqa: SLF001
            engine.stream_with_tools(prompt="write it", tools=[])
        )

    records = [
        record
        for record in caplog.records
        if getattr(record, "event", "") == "ai.engines.vllm.tool_call_truncated"
    ]
    assert len(records) == 1
    assert records[0].tool_names == ["create_artifact"]
    assert records[0].terminal_finish_reason == "length"
    assert records[0].argument_chars == len('{"title": "Badge')


# ---------------------------------------------------------------------------
# Guard verdict logging: the engine can suppress deltas before the router ever
# sees them, so the engine itself must say why and how much it counted.
# ---------------------------------------------------------------------------


def test_tool_stream_logs_the_guard_verdict_with_counted_chars_at_stream_end(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.delenv("JENNY_ENABLE_THINKING_BUDGET_ABORT", raising=False)
    monkeypatch.setattr(
        vllm_engine_generation, "resolve_thinking_budget_chars", lambda _e, _m: 4
    )
    engine = vllm_test._make_streaming_engine(monkeypatch)  # noqa: SLF001
    vllm_test._patch_stream_response(  # noqa: SLF001
        monkeypatch,
        vllm_test._FakeSSEStream(  # noqa: SLF001
            [
                vllm_test._sse_chunk({"reasoning_content": "abcdef"}),  # noqa: SLF001
                vllm_test._sse_chunk({"content": "never"}),  # noqa: SLF001
                "data: [DONE]",
            ]
        ),
    )

    with caplog.at_level(logging.INFO):
        _chunks, result = vllm_test._drain_stream(  # noqa: SLF001
            engine.stream_with_tools(prompt="think", tools=[], max_tokens=64)
        )

    assert result.finish_reason == "thinking_budget"
    records = [
        record
        for record in caplog.records
        if getattr(record, "event", "") == "ai.engines.vllm.thinking_budget_abort"
    ]
    assert len(records) == 1
    assert records[0].reason == "char_limit"
    assert records[0].counted_chars == 6
    assert records[0].max_chars == 4


def test_tool_stream_logs_a_repetition_suppression_that_never_hit_the_budget(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    engine = vllm_test._make_streaming_engine(monkeypatch)  # noqa: SLF001
    repeated = "Checking the request intent carefully. " * 50
    vllm_test._patch_stream_response(  # noqa: SLF001
        monkeypatch,
        vllm_test._FakeSSEStream(  # noqa: SLF001
            [
                *(vllm_test._sse_chunk({"reasoning_content": repeated}) for _ in range(3)),  # noqa: SLF001
                vllm_test._sse_chunk({"content": "answer"}),  # noqa: SLF001
                "data: [DONE]",
            ]
        ),
    )

    with caplog.at_level(logging.INFO):
        _chunks, result = vllm_test._drain_stream(  # noqa: SLF001
            engine.stream_with_tools(prompt="think", tools=[], max_tokens=16_384)
        )

    assert result.content == "answer"
    records = [
        record
        for record in caplog.records
        if getattr(record, "event", "") == "ai.engines.vllm.thinking_guard_suppressed"
    ]
    assert len(records) == 1
    assert records[0].reason == "repetition"
    assert records[0].counted_chars == 3 * len(repeated)
    assert records[0].max_chars == 34_076


# ---------------------------------------------------------------------------
# Land review 2026-09-20: ``stream()`` published counters and the outcome
# inline, so an abandoned or failed plain stream left the ledger entry
# ``started`` with stale counters; ``generate_with_tools`` completed with the
# default outcome from an unconditional ``finally``. Both mirror
# ``stream_with_tools`` now: counters and outcome from a ``finally``.
# ---------------------------------------------------------------------------


def test_plain_stream_abandoned_mid_stream_still_completes_the_ledger_entry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = vllm_test._make_streaming_engine(monkeypatch)  # noqa: SLF001
    store = _RecordingStore()
    engine.begin_request_context(request_id="req-abandoned", diagnostics_store=store)
    vllm_test._patch_stream_response(  # noqa: SLF001
        monkeypatch,
        vllm_test._FakeSSEStream(  # noqa: SLF001
            [
                vllm_test._sse_chunk({"content": "first"}),  # noqa: SLF001
                vllm_test._sse_chunk({"content": " second"}),  # noqa: SLF001
                _terminal_line("stop"),
                "data: [DONE]",
            ]
        ),
    )

    generator = engine.stream(prompt="hi")
    assert next(generator) == StreamingEvent(kind="content", text="first")
    generator.close()

    completions = store.recorded("complete_provider_request")
    assert completions and completions[-1].get("outcome") == "failed"
    assert store.recorded("record_stream_counters"), "counters publish even when abandoned"


def test_plain_stream_success_completes_once(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = vllm_test._make_streaming_engine(monkeypatch)  # noqa: SLF001
    store = _RecordingStore()
    engine.begin_request_context(request_id="req-plain-ok", diagnostics_store=store)
    vllm_test._patch_stream_response(  # noqa: SLF001
        monkeypatch,
        vllm_test._FakeSSEStream(  # noqa: SLF001
            [
                vllm_test._sse_chunk({"content": "hi"}),  # noqa: SLF001
                _terminal_line("stop"),
                "data: [DONE]",
            ]
        ),
    )

    list(engine.stream(prompt="hi"))

    completions = store.recorded("complete_provider_request")
    assert [c.get("outcome") for c in completions] == ["completed"]


def test_non_streaming_tool_call_failure_records_a_failed_outcome(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = vllm_test._make_streaming_engine(monkeypatch)  # noqa: SLF001
    store = _RecordingStore()
    engine.begin_request_context(request_id="req-post-fail", diagnostics_store=store)

    def _boom(*_args: Any, **_kwargs: Any) -> None:
        raise GenerationError("server exploded")

    monkeypatch.setattr(engine._service, "post_json", _boom)  # noqa: SLF001

    with pytest.raises(GenerationError, match="exploded"):
        engine.generate_with_tools(prompt="go", tools=[])

    completions = store.recorded("complete_provider_request")
    assert completions and completions[-1].get("outcome") == "failed"
