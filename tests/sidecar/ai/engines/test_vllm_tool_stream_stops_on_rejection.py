"""The vLLM tool stream stops reading once tool input is rejected (dogfood MQ-033).

A cap rejection used to drop the call's fragments but keep reading SSE lines
until the provider ended, so the local model kept generating up to its output
limit (three minutes for one runaway ``delete_file`` call in a dogfood run).
The stream now returns on the rejecting chunk; closing the response stops
llama-server, and the result takes the existing clean-stop rejection path.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import pytest

from sidecar.ai.engines.provider_http import ProviderHttpService
from sidecar.ai.engines.vllm_engine import VLLMEngine
from sidecar.ai.routing.provider_tool_limits import (
    MAX_TOOL_CALL_ARGUMENT_BYTES,
    PATH_ONLY_TOOL_ARGUMENT_BYTES,
)
from sidecar.ai.routing.thinking_checkpoint import is_thinking_budget_checkpoint
from tests.sidecar.ai.engines.test_thinking_budget_abort import _drain, _vllm_chunk

# A ceiling so the red run (no stop on rejection) ends instead of hanging.
_LINE_CEILING = 5_000
_PREAMBLE = "Removing the stale scratch files now."


def _tool_line(arguments: str, *, name: str = "") -> str:
    call: dict[str, Any] = {"index": 0, "function": {"arguments": arguments}}
    if name:
        call.update(id="call-1", type="function")
        call["function"]["name"] = name
    return f'data: {json.dumps({"choices": [{"delta": {"tool_calls": [call]}}]})}'


class _EndlessToolCallStream:
    """A preamble, one call's opening fragment, then the same fragment forever."""

    def __init__(self, name: str, fragment: str) -> None:
        self._name = name
        self._fragment = fragment
        self.consumed = 0

    def _lines(self) -> Iterator[str]:
        yield _vllm_chunk({"content": _PREAMBLE})
        yield _tool_line('{"path": "', name=self._name)
        while True:
            yield _tool_line(self._fragment)

    def iter_raw(self, *, chunk_size: int) -> Iterator[bytes]:
        _ = chunk_size
        for line in self._lines():
            if self.consumed >= _LINE_CEILING:
                return
            self.consumed += 1
            yield f"{line}\n".encode()

    def raise_for_status(self) -> None:
        return None


def _engine_reading(
    monkeypatch: pytest.MonkeyPatch, response: _EndlessToolCallStream
) -> VLLMEngine:
    @contextmanager
    def _stream_response(
        _self: ProviderHttpService, _method: str, _path: str, **_kwargs: Any
    ):
        yield response

    monkeypatch.setattr(ProviderHttpService, "stream_response", _stream_response)
    engine = VLLMEngine(host="http://localhost:8000")
    engine.model_name = "Qwen/Qwen3.5-9B"
    engine._ready = True
    return engine


@pytest.mark.parametrize(
    ("name", "fragment", "cap", "reason"),
    [
        ("delete_file", "a" * 512, PATH_ONLY_TOOL_ARGUMENT_BYTES, "tool_argument_bytes"),
        ("write_file", "b" * 1024, MAX_TOOL_CALL_ARGUMENT_BYTES, "argument_bytes"),
    ],
    ids=["path_only_cap", "generic_cap"],
)
def test_a_runaway_tool_call_stops_reading_at_its_cap(
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    fragment: str,
    cap: int,
    reason: str,
) -> None:
    response = _EndlessToolCallStream(name, fragment)
    engine = _engine_reading(monkeypatch, response)
    try:
        _events, result = _drain(
            engine.stream_with_tools(prompt="clean up", tools=[], max_tokens=16_384)
        )
    finally:
        engine.close()

    # Preamble + opening fragment + the fragments that fit + the rejecting one,
    # with a few lines of slack for read-ahead.
    upper_bound = 2 + cap // len(fragment) + 4
    observed = (
        f"consumed={response.consumed} finish={result.finish_reason!r} "
        f"reason={result.tool_call_rejected_reason!r} tool_calls={len(result.tool_calls)}"
    )
    assert response.consumed <= upper_bound, observed
    assert result.tool_calls == (), observed
    assert result.tool_call_rejected_reason == reason, observed
    assert result.tool_call_truncated is True, observed
    # The existing clean-finish rejection mapping: the turn continues from a
    # checkpoint with the cap's note instead of ending as incomplete.
    assert result.finish_reason == "stop", observed
    assert result.content == _PREAMBLE, observed
    assert is_thinking_budget_checkpoint(result) is True, observed


class _CompletedCallThenRunaway(_EndlessToolCallStream):
    """One call completed from parsed dict arguments, then a runaway call."""

    def _lines(self) -> Iterator[str]:
        yield _vllm_chunk({"content": _PREAMBLE})
        first = {
            "index": 0,
            "id": "call-0",
            "type": "function",
            "function": {"name": "read_file", "arguments": {"path": "notes.txt"}},
        }
        yield f'data: {json.dumps({"choices": [{"delta": {"tool_calls": [first]}}]})}'
        opening = {
            "index": 1,
            "id": "call-1",
            "type": "function",
            "function": {"name": self._name, "arguments": '{"path": "'},
        }
        yield f'data: {json.dumps({"choices": [{"delta": {"tool_calls": [opening]}}]})}'
        while True:
            runaway = {"index": 1, "function": {"arguments": self._fragment}}
            yield f'data: {json.dumps({"choices": [{"delta": {"tool_calls": [runaway]}}]})}'


def test_a_rejection_drops_the_calls_already_completed_in_the_same_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    response = _CompletedCallThenRunaway("delete_file", "a" * 512)
    engine = _engine_reading(monkeypatch, response)
    try:
        _events, result = _drain(
            engine.stream_with_tools(prompt="clean up", tools=[], max_tokens=16_384)
        )
    finally:
        engine.close()

    observed = (
        f"consumed={response.consumed} finish={result.finish_reason!r} "
        f"reason={result.tool_call_rejected_reason!r} tool_calls={result.tool_calls!r}"
    )
    assert response.consumed < _LINE_CEILING, observed
    # The model is told nothing in this response ran, so nothing may run.
    assert result.tool_calls == (), observed
    assert result.tool_call_rejected_reason == "tool_argument_bytes", observed
    assert result.finish_reason == "stop", observed
    assert is_thinking_budget_checkpoint(result) is True, observed
