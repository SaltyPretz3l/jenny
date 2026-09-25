"""Provider-call outcomes and length-cut native tool calls on the Ollama runtime.

Split from ``test_ollama_runtime.py`` (over the raw-line cap)."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

import pytest

from sidecar.ai.engines.ollama_runtime import (
    generate,
    generate_with_tools_impl,
    stream,
    stream_with_tools,
)
from sidecar.ai.exceptions import EngineConnectionError, GenerationError
from tests.sidecar.ai.engines.test_ollama_runtime import (
    FakeEngine,
    _patch_urlopen,
    _raising_post,
)

# ---------------------------------------------------------------------------
# Land review 2026-09-20: every Ollama exception handler completed the provider
# call with the default ``outcome="completed"``, so a connection drop was
# recorded as a clean call in the per-call ledger. Streaming and non-streaming,
# with and without tools, must all record ``failed``.
# ---------------------------------------------------------------------------


def _boom(_req, timeout=None):
    raise urllib.error.URLError("refused")


def _drain(gen):
    try:
        while True:
            next(gen)
    except StopIteration as stop:
        return stop.value


@pytest.mark.parametrize(
    "run",
    [
        pytest.param(lambda engine: list(stream(engine, prompt="hi")), id="stream"),
        pytest.param(
            lambda engine: _drain(stream_with_tools(engine, prompt="hi", tools=[])),
            id="stream_with_tools",
        ),
    ],
)
def test_streaming_transport_failure_records_a_failed_outcome(monkeypatch, run) -> None:
    monkeypatch.setattr(urllib.request, "urlopen", _boom)
    engine = FakeEngine()
    with pytest.raises((EngineConnectionError, GenerationError)):
        run(engine)
    assert engine.outcomes == ["failed"]


@pytest.mark.parametrize(
    "run",
    [
        pytest.param(lambda engine: generate(engine, prompt="hi"), id="generate"),
        pytest.param(
            lambda engine: generate_with_tools_impl(
                engine,
                prompt="hi",
                tools=[],
                max_tokens=8,
                temperature=0.0,
                reasoning_effort=None,
                prompt_cache_enabled=False,
                system="",
                messages=None,
                response_format=None,
            ),
            id="generate_with_tools",
        ),
    ],
)
def test_non_streaming_transport_failure_records_a_failed_outcome(run) -> None:
    engine = FakeEngine(post_response=_raising_post(urllib.error.URLError("down")))
    with pytest.raises((EngineConnectionError, GenerationError)):
        run(engine)
    assert engine.outcomes == ["failed"]


def test_non_streaming_success_still_records_completed() -> None:
    engine = FakeEngine(post_response={"message": {"content": "ok"}, "done": True})
    generate(engine, prompt="hi")
    assert engine.outcomes == ["completed"]


# ---------------------------------------------------------------------------
# The normalizer classifies a ``done_reason: length`` call with unparseable
# string arguments as ``tool_call_incomplete``, but the runtime built its
# executable calls from the raw chunk regardless, so the cut call ran as
# ``tool({})``. A length-cut call is dropped and the turn ends ``length`` so
# the checkpoint continuation can re-ask; a clean ``stop`` keeps today's
# behavior.
# ---------------------------------------------------------------------------


def _tool_call_done_line(arguments: Any, *, done_reason: str) -> bytes:
    payload = {
        "message": {
            "tool_calls": [
                {"function": {"name": "danger", "arguments": arguments}, "id": "c1"}
            ]
        },
        "done": True,
        "done_reason": done_reason,
    }
    return json.dumps(payload).encode() + b"\n"


def test_length_cut_native_tool_call_is_dropped_not_executed(monkeypatch) -> None:
    _patch_urlopen(monkeypatch, [_tool_call_done_line('{"path": "b.', done_reason="length")])
    engine = FakeEngine()

    result = _drain(
        stream_with_tools(engine, prompt="go", tools=[{"function": {"name": "danger"}}])
    )

    assert result.tool_calls == ()
    assert result.finish_reason == "length"


def test_clean_stop_native_tool_call_with_dict_arguments_still_executes(monkeypatch) -> None:
    _patch_urlopen(monkeypatch, [_tool_call_done_line({"path": "b"}, done_reason="stop")])
    engine = FakeEngine()

    result = _drain(
        stream_with_tools(engine, prompt="go", tools=[{"function": {"name": "danger"}}])
    )

    assert [call.arguments for call in result.tool_calls] == [{"path": "b"}]
    assert result.finish_reason == "tool_calls"
