"""Provider lifecycle fidelity through real engines and a retained turn store."""

from __future__ import annotations

import io
import json
import logging
import urllib.request
from unittest.mock import Mock

import pytest

from sidecar.ai.engines.ollama import OllamaEngine
from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine
from sidecar.ai.exceptions import EngineConnectionError, GenerationError
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.diagnostics import StructuredLogFormatter
from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.turn_diagnostics import TurnDiagnosticsStore
from tests.sidecar.ai.engines import test_vllm_engine as vllm_test


@pytest.fixture
def ollama_engine():
    engine = OllamaEngine(host="http://localhost:11434")
    engine.model_name = "gemma"
    engine._ready = True
    yield engine
    engine.clear_request_context()


def _bind(engine):
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req-fidelity", session_id="sess", mode="chat")
    engine.begin_request_context(request_id="req-fidelity", diagnostics_store=store)
    store.complete_provider_request = Mock(wraps=store.complete_provider_request)  # type: ignore[method-assign]
    return store


def _call(store):
    snapshot = store.get_snapshot_for_request("req-fidelity")
    assert snapshot is not None
    assert snapshot["provider_call_count"] == 1
    assert store.complete_provider_request.call_count == 1
    return snapshot["provider_calls"][0]


def _ollama_response(monkeypatch, chunks):
    response = io.BytesIO(b"".join(json.dumps(chunk).encode() + b"\n" for chunk in chunks))
    monkeypatch.setattr(urllib.request, "urlopen", lambda *_a, **_kw: response)
    return response


def _stream(engine, with_tools, **kwargs):
    if with_tools:
        return engine.stream_with_tools(prompt="hi", tools=[], **kwargs)
    return engine.stream(prompt="hi", **kwargs)


@pytest.mark.parametrize("with_tools", [False, True])
def test_ollama_closed_stream_finalizes_once_as_cancelled(monkeypatch, ollama_engine, with_tools):
    store = _bind(ollama_engine)
    response = _ollama_response(monkeypatch, [{"message": {"content": "hello"}}])
    generator = _stream(ollama_engine, with_tools)
    assert next(generator).text == "hello"
    generator.close()
    assert response.closed
    assert _call(store)["outcome"] == "cancelled"
    generator.close()
    assert store.complete_provider_request.call_count == 1
    if with_tools:
        assert _call(store)["stream_counters"]["visible_text_delta_count"] == 1


@pytest.mark.parametrize("with_tools", [False, True])
@pytest.mark.parametrize("terminal_case", [
    ([], "incomplete", "incomplete"),
    ([{"error": "provider failure"}], "failed", "error"),
    ([{"done": True, "done_reason": "stop"}], "completed", "stop"),
    ([{"done": True, "done_reason": "length"}], "completed", "length"),
])
def test_ollama_resolved_terminal_is_retained(monkeypatch, ollama_engine, with_tools, terminal_case):
    terminal, outcome, reason = terminal_case
    store = _bind(ollama_engine)
    _ollama_response(monkeypatch, [{"message": {"content": "hello"}}, *terminal])
    list(_stream(ollama_engine, with_tools))
    call = _call(store)
    assert call["outcome"] == outcome
    assert call["finish_reason"] == reason


@pytest.mark.parametrize("with_tools", [False, True])
def test_ollama_partial_transport_failure_publishes_counters(monkeypatch, ollama_engine, with_tools):
    store = _bind(ollama_engine)

    class BrokenResponse(io.BytesIO):
        def read1(self, size=-1):
            if self.tell():
                raise ConnectionResetError("connection reset")
            return super().read1(size)

    response = BrokenResponse(b'{"message":{"content":"hello"}}\n')
    monkeypatch.setattr(urllib.request, "urlopen", lambda *_a, **_kw: response)
    generator = _stream(ollama_engine, with_tools)
    assert next(generator).text == "hello"
    with pytest.raises((EngineConnectionError, GenerationError)):
        list(generator)
    call = _call(store)
    assert call["outcome"] == "failed"
    if with_tools:
        assert call["stream_counters"]["visible_text_delta_count"] == 1


@pytest.mark.parametrize("with_tools", [False, True])
def test_ollama_explicit_cancellation_is_retained(monkeypatch, ollama_engine, with_tools):
    store = _bind(ollama_engine)
    _ollama_response(monkeypatch, [{"message": {"content": "hello"}}])
    cancel = TurnCancellationHandle(request_id="req-fidelity")
    generator = _stream(ollama_engine, with_tools, cancel_handle=cancel)
    next(generator)
    cancel.cancel()
    with pytest.raises(TerminalChatStateError):
        next(generator)
    assert _call(store)["outcome"] == "cancelled"


@pytest.mark.parametrize("with_tools", [False, True])
def test_synchronous_ollama_records_usage_and_terminal(monkeypatch, ollama_engine, with_tools):
    store = _bind(ollama_engine)
    body = {"message": {"content": "hello"}, "done": True, "prompt_eval_count": 12, "eval_count": 3}
    monkeypatch.setattr(urllib.request, "urlopen", lambda *_a, **_kw: io.BytesIO(json.dumps(body).encode()))
    if with_tools:
        result = ollama_engine.generate_with_tools(prompt="hi", tools=[])
        assert result.content == "hello"
    else:
        assert ollama_engine.generate(prompt="hi") == "hello"
    call = _call(store)
    assert call["usage"] == {"prompt_eval_count": 12, "eval_count": 3, "prompt_tokens_evaluated": 12}
    assert call["outcome"] == "completed"
    assert call["finish_reason"] == "stop"


@pytest.fixture(params=["vllm", "openai-compatible"])
def sse_engine(request, monkeypatch):
    if request.param == "vllm":
        engine = vllm_test._make_streaming_engine(monkeypatch)
    else:
        engine = OpenAICompatibleEngine(host="http://localhost:8080")
        engine.model_name = "gemma"
        engine._ready = True
    yield engine
    engine.clear_request_context()
    engine.close()


@pytest.mark.parametrize("with_tools", [False, True])
def test_sse_closed_stream_is_cancelled(monkeypatch, sse_engine, with_tools):
    store = _bind(sse_engine)
    vllm_test._patch_stream_response(monkeypatch, vllm_test._FakeSSEStream([vllm_test._sse_chunk({"content": "hello"})]))
    generator = _stream(sse_engine, with_tools)
    assert next(generator).text == "hello"
    generator.close()
    assert _call(store)["outcome"] == "cancelled"


@pytest.mark.parametrize("with_tools", [False, True])
@pytest.mark.parametrize("terminal_case", [
    ([], "incomplete", "incomplete"),
    (["data: " + json.dumps({"object": "error", "error": "provider failure"})], "failed", "error"),
    (["data: [DONE]"], "completed", "stop"),
])
def test_sse_terminal_outcome_matches_evidence(monkeypatch, sse_engine, with_tools, terminal_case):
    terminal, outcome, reason = terminal_case
    store = _bind(sse_engine)
    vllm_test._patch_stream_response(monkeypatch, vllm_test._FakeSSEStream([vllm_test._sse_chunk({"content": "hello"}), *terminal]))
    list(_stream(sse_engine, with_tools))
    call = _call(store)
    assert call["outcome"] == outcome
    assert call["finish_reason"] == reason


def test_ollama_completion_measurements_survive_formatter_and_interleaving(monkeypatch, ollama_engine, caplog):
    store = _bind(ollama_engine)
    ollama_engine._record_provider_request(think_enabled=False, num_predict=8, temperature=0.7, message_count=1, tool_count=0, tool_capable=False)
    ollama_engine._record_visible_output("hello")
    store.begin_turn(request_id="req-other", session_id="sess", mode="chat")
    with caplog.at_level(logging.INFO):
        ollama_engine._complete_provider_request()
    entry = json.loads(StructuredLogFormatter().format(caplog.records[-1]))
    assert entry["data"]["model"] == "gemma"
    assert entry["data"]["visible_output_chars"] == 5
    visible_ms = entry["data"]["time_to_first_visible_token_ms"]
    assert isinstance(visible_ms, (int, float)) and not isinstance(visible_ms, bool)


def test_token_named_measurements_pass_but_secret_strings_do_not(caplog):
    logger = logging.getLogger("tests.sidecar.token_measurements")
    with caplog.at_level(logging.INFO, logger=logger.name):
        logger.info("measure", extra={"data": {
            "time_to_first_token_ms": 42, "token_count": 3,
            "time_to_first_token_ms_note": "sk-syntheticsecret123", "token": 123456,
        }})
    data = json.loads(StructuredLogFormatter().format(caplog.records[-1]))["data"]
    assert data["time_to_first_token_ms"] == 42
    assert data["token_count"] == 3
    assert data["time_to_first_token_ms_note"] == "[redacted]"
    assert data["token"] == "[redacted]"


def test_vllm_request_measurements_survive_formatter(sse_engine, caplog):
    _bind(sse_engine)
    with caplog.at_level(logging.INFO):
        sse_engine._record_provider_request(think_enabled=False, num_predict=8, temperature=0.7, message_count=1, tool_count=0, tool_capable=False)
    entry = json.loads(StructuredLogFormatter().format(caplog.records[-1]))
    assert entry["data"]["model"] == sse_engine.model_name
    assert entry["data"]["num_predict"] == 8


@pytest.mark.parametrize("mode", ["generate", "stream", "tool-stream"])
def test_diagnostic_completion_failure_does_not_escape_or_retry(monkeypatch, ollama_engine, caplog, mode):
    store = _bind(ollama_engine)
    store.complete_provider_request.side_effect = RuntimeError("diagnostic failure")
    _ollama_response(monkeypatch, [{"message": {"content": "hello"}, "done": True}])
    with caplog.at_level(logging.WARNING):
        if mode == "generate":
            assert ollama_engine.generate(prompt="hi") == "hello"
        else:
            list(_stream(ollama_engine, mode == "tool-stream"))
    assert store.complete_provider_request.call_count == 1
    entries = [json.loads(StructuredLogFormatter().format(record)) for record in caplog.records]
    assert any(entry["data"].get("diagnostic_recording_error_count") == 1 for entry in entries)


@pytest.mark.parametrize("with_tools", [False, True])
def test_sse_parser_setup_failure_finalizes_started_call(monkeypatch, sse_engine, with_tools):
    store = _bind(sse_engine)
    monkeypatch.setattr(sse_engine, "_create_request_reasoning_parser", Mock(side_effect=RuntimeError("parser setup failed")))
    with pytest.raises((RuntimeError, GenerationError)):
        list(_stream(sse_engine, with_tools))
    assert _call(store)["outcome"] == "failed"


def test_ollama_terminal_delivery_finalizes_before_close(monkeypatch, ollama_engine):
    store = _bind(ollama_engine)
    _ollama_response(monkeypatch, [{"done": True}])
    generator = ollama_engine.stream(prompt="hi")
    assert next(generator).kind == "done"
    assert _call(store)["outcome"] == "completed"
    generator.close()
    assert _call(store)["outcome"] == "completed"


@pytest.mark.parametrize("with_tools", [False, True])
def test_sse_terminal_delivery_finalizes_before_close(monkeypatch, sse_engine, with_tools):
    store = _bind(sse_engine)
    vllm_test._patch_stream_response(monkeypatch, vllm_test._FakeSSEStream(["data: [DONE]"]))
    generator = _stream(sse_engine, with_tools)
    assert next(generator).kind == "done"
    assert _call(store)["outcome"] == "completed"
    generator.close()
    assert _call(store)["outcome"] == "completed"


@pytest.mark.parametrize("with_tools", [False, True])
@pytest.mark.parametrize("terminal_case", [
    ({"done": True, "done_reason": "length"}, "completed", "length"),
    ({"error": "provider failure"}, "failed", "error"),
])
def test_synchronous_ollama_terminal_evidence_is_retained(monkeypatch, ollama_engine, with_tools, terminal_case):
    body, outcome, reason = terminal_case
    store = _bind(ollama_engine)
    monkeypatch.setattr(urllib.request, "urlopen", lambda *_a, **_kw: io.BytesIO(json.dumps(body).encode()))
    if with_tools:
        ollama_engine.generate_with_tools(prompt="hi", tools=[])
    else:
        ollama_engine.generate(prompt="hi")
    call = _call(store)
    assert call["outcome"] == outcome
    assert call["finish_reason"] == reason


class _RecordingEngine:
    def __init__(self):
        self.completions = []

    def _complete_provider_request(self, **kwargs):
        self.completions.append(kwargs)


class _CancelHandle:
    cancelled = True


def test_reasoning_only_clean_stop_is_a_completed_call():
    from sidecar.ai.engines.provider_call_finalize import ProviderCallFinalizer

    engine = _RecordingEngine()
    finalizer = ProviderCallFinalizer(engine)
    finalizer.finish_reason = "reasoning_only"
    finalizer.finalize()
    assert engine.completions == [{"outcome": "completed", "finish_reason": "reasoning_only"}]


def test_cancel_that_ends_the_transport_as_eof_is_cancelled_not_incomplete():
    from sidecar.ai.engines.provider_call_finalize import ProviderCallFinalizer

    engine = _RecordingEngine()
    finalizer = ProviderCallFinalizer(engine)
    finalizer.finish_reason = "incomplete"
    finalizer.finalize(cancel_handle=_CancelHandle())
    assert engine.completions == [{"outcome": "cancelled", "finish_reason": "incomplete"}]


def test_ollama_closed_stream_completion_record_states_its_outcome(monkeypatch, ollama_engine, caplog):
    _bind(ollama_engine)
    _ollama_response(monkeypatch, [{"message": {"content": "hello"}}])
    generator = _stream(ollama_engine, False)
    next(generator)
    with caplog.at_level(logging.INFO):
        generator.close()
    records = [r for r in caplog.records if getattr(r, "event", "") == "ai.engines.ollama.request_completed"]
    entry = json.loads(StructuredLogFormatter().format(records[-1]))
    assert entry["level"] == "WARNING"
    assert entry["status"] == "cancelled"
    assert entry["data"]["outcome"] == "cancelled"


@pytest.mark.parametrize("body", [
    {"error": {"message": "synthetic provider error"}},
    {"choices": []},
    {"choices": ["not-a-choice"]},
])
def test_synchronous_tool_body_without_a_choice_is_a_failed_call(monkeypatch, sse_engine, body):
    store = _bind(sse_engine)
    monkeypatch.setattr(sse_engine._service, "post_json", lambda _path, _payload: body)
    result = sse_engine.generate_with_tools(prompt="hi", tools=[])
    assert result.content == ""
    call = _call(store)
    assert call["outcome"] == "failed"
    assert "finish_reason" not in call

