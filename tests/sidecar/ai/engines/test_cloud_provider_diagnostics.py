"""Cloud and CLI provider ledger regressions using only fake transports."""

from __future__ import annotations

import json
from contextlib import contextmanager
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest

from sidecar.ai.engines.codex_cli import CodexCliEngine, CodexCliProcessResult
from sidecar.ai.engines.provider_http import ProviderHttpError
from sidecar.ai.exceptions import GenerationError
from sidecar.ai.tools.models import StreamingEvent
from sidecar.runtime.local_engine.request_context import scoped_chat_request_context
from sidecar.runtime.local_engine.snapshot import build_local_runtime_payload
from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.turn_diagnostics import TurnDiagnosticsStore
from tests.sidecar.ai.engines.test_chatgpt_subscription import (
    _TOKEN,
    _completed,
    _drain_stream,
    _engine,
    _FakeSSEStream,
    _sse,
)
from tests.sidecar.ai.engines.test_codex_cli import _jsonl

PRIVATE_TEXT = "private-response-sentinel"


@contextmanager
def _binding(engine: Any, store: TurnDiagnosticsStore):
    store.begin_turn(request_id="cloud-request", session_id="session", mode="assist")
    context = scoped_chat_request_context(
        engine,
        request_context=SimpleNamespace(request_id="cloud-request", mode="assist"),
        runtime_config=SimpleNamespace(),
        diagnostics_store=store,
    )
    with patch.object(store, "complete_provider_request", wraps=store.complete_provider_request) as end:
        with context:
            yield
        assert end.call_count == 1


def _snapshot(store: TurnDiagnosticsStore) -> tuple[dict[str, Any], dict[str, Any]]:
    snapshot = store.get_snapshot_for_request("cloud-request")
    assert snapshot is not None
    assert len(snapshot.get("provider_calls", [])) == 1
    serialized = json.dumps(snapshot)
    assert PRIVATE_TEXT not in serialized
    assert _TOKEN not in serialized
    assert "private-prompt-sentinel" not in serialized
    call = snapshot["provider_calls"][0]
    assert call["duration_ms"] is not None
    return snapshot, call


def test_chatgpt_provider_call_success(monkeypatch: pytest.MonkeyPatch) -> None:
    engine, _ = _engine(monkeypatch, _FakeSSEStream([
        _sse({"type": "response.output_text.delta", "delta": PRIVATE_TEXT}),
        _completed(input_tokens=12, output_tokens=7),
    ]))
    store = TurnDiagnosticsStore()
    with _binding(engine, store):
        _, result = _drain_stream(engine.stream_with_tools("private-prompt-sentinel", []))
    snapshot, call = _snapshot(store)
    assert result.content == PRIVATE_TEXT
    assert call["outcome"] == "completed"
    assert call["finish_reason"] == "stop"
    assert call["time_to_first_chunk_ms"] is not None
    assert call["visible_output_chars"] == len(PRIVATE_TEXT)
    assert snapshot["time_to_first_visible_token_ms"] is not None
    assert call["usage"] == {"prompt_eval_count": 12, "eval_count": 7}
    assert snapshot["provider_usage_source"] == "chatgpt"


@pytest.mark.parametrize("exit_path", ["eof", "close", "failure", "cancel", "incomplete"])
def test_chatgpt_partial_call_keeps_counters(
    monkeypatch: pytest.MonkeyPatch, exit_path: str,
) -> None:
    lines = [_sse({"type": "response.output_text.delta", "delta": PRIVATE_TEXT})]
    if exit_path == "failure":
        lines.append(_sse({"type": "response.failed", "response": {"error": {"code": "unknown"}}}))
    if exit_path == "incomplete":
        lines.append(_sse({"type": "response.incomplete", "response": {
            "incomplete_details": {"reason": "max_output_tokens"},
            "usage": {"output_tokens": 3},
        }}))
    response = _FakeSSEStream(lines)
    engine, _ = _engine(monkeypatch, response)
    store = TurnDiagnosticsStore()
    handle = TurnCancellationHandle(request_id="cloud-request")
    with _binding(engine, store):
        stream = engine.stream_with_tools("private-prompt-sentinel", [], cancel_handle=handle)
        chunk = next(stream)
        assert isinstance(chunk, StreamingEvent)
        assert chunk.text == PRIVATE_TEXT
        if exit_path == "close":
            stream.close()
        elif exit_path == "cancel":
            handle.cancel(reason="chat_cancel")
            with pytest.raises(Exception, match="cancel"):
                next(stream)
        elif exit_path == "incomplete":
            _drain_stream(stream)
        else:
            with pytest.raises(GenerationError):
                next(stream)
    snapshot, call = _snapshot(store)
    expected = {"eof": "incomplete", "close": "cancelled", "failure": "failed",
                "cancel": "cancelled", "incomplete": "incomplete"}[exit_path]
    assert call["outcome"] == expected
    assert snapshot["provider_completion_shape"]["output_text_delta_count"] == 1
    assert snapshot["provider_completion_shape"]["output_text_delta_chars"] == len(PRIVATE_TEXT)
    assert response.closed
    if exit_path == "incomplete":
        assert call["finish_reason"] == "length"
        assert call["usage"] == {"eval_count": 3}
        assert "provider_prompt_eval_count" not in snapshot
    else:
        assert call["usage"] is None


def test_chatgpt_http_failure_keeps_earlier_call_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    engine, _ = _engine(
        monkeypatch,
        _FakeSSEStream([
            _sse({"type": "response.output_text.delta", "delta": PRIVATE_TEXT}),
            _completed(input_tokens=12, output_tokens=7),
        ]),
        _FakeSSEStream([], status_code=429),
    )
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="cloud-request", session_id="session", mode="assist")
    with scoped_chat_request_context(
        engine,
        request_context=SimpleNamespace(request_id="cloud-request", mode="assist"),
        runtime_config=SimpleNamespace(),
        diagnostics_store=store,
    ):
        _drain_stream(engine.stream_with_tools("private-prompt-sentinel", []))
        with pytest.raises(ProviderHttpError):
            _drain_stream(engine.stream_with_tools("private-prompt-sentinel", []))
    snapshot = store.get_snapshot_for_request("cloud-request")
    assert [call["outcome"] for call in snapshot["provider_calls"]] == ["completed", "failed"]
    assert snapshot["provider_completion_shape"]["output_text_delta_count"] == 1
    assert snapshot["provider_completion_shape"]["output_text_delta_chars"] == len(PRIVATE_TEXT)


@pytest.mark.parametrize("exit_path", ["success", "cancel", "failure", "no_usage", "plain"])
def test_codex_provider_call_with_fake_process(tmp_path, exit_path: str) -> None:
    handle = TurnCancellationHandle(request_id="cloud-request")

    def run_process(**kwargs: Any) -> CodexCliProcessResult:
        assert kwargs["cancel_handle"] is handle
        if exit_path == "cancel":
            handle.cancel(reason="chat_cancel")
            raise RuntimeError("Codex CLI request cancelled")
        events: list[dict[str, Any]] = [{"type": "agent_message", "message": PRIVATE_TEXT}]
        if exit_path in {"success", "failure"}:
            events.append({"type": "turn.completed", "usage": {
                "input_tokens": 12, "output_tokens": 7, "cached_input_tokens": 4,
            }})
        return CodexCliProcessResult(exit_code=1 if exit_path == "failure" else 0,
                                     stdout=PRIVATE_TEXT if exit_path == "plain" else _jsonl(*events))

    engine = CodexCliEngine(runtime_root=tmp_path, run_process=run_process)
    store = TurnDiagnosticsStore()
    with _binding(engine, store):
        stream = engine.stream_with_tools("private-prompt-sentinel", [], cancel_handle=handle)
        if exit_path in {"cancel", "failure"}:
            with pytest.raises(RuntimeError):
                _drain_stream(stream)
        else:
            _, result = _drain_stream(stream)
            assert result.content == PRIVATE_TEXT
    snapshot, call = _snapshot(store)
    assert call["outcome"] == {"cancel": "cancelled", "failure": "failed"}.get(exit_path, "completed")
    if exit_path in {"success", "no_usage", "plain"}:
        assert call["time_to_first_chunk_ms"] is not None
        assert call["finish_reason"] == "stop"
        assert snapshot["buffered_visible_output_chars"] == len(PRIVATE_TEXT)
        assert snapshot["buffered_visible_output_disposition"] == "flushed"
        assert call["visible_output_chars"] == 0
        assert "time_to_first_visible_token_ms" not in snapshot
    if exit_path in {"success", "failure"}:
        assert call["time_to_first_chunk_ms"] is not None
        assert call["usage"] == {"prompt_eval_count": 12, "eval_count": 7, "cached_tokens": 4}
        assert snapshot["provider_usage_source"] == "codex-cli"
    else:
        assert call["usage"] is None


@pytest.mark.parametrize("streaming", [True, False])
def test_codex_tool_call_records_tools_and_visible_text_only(tmp_path, streaming: bool) -> None:
    markup = '<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</tool_call>'

    def run_process(**_kwargs: Any) -> CodexCliProcessResult:
        return CodexCliProcessResult(exit_code=0, stdout=_jsonl(
            {"type": "agent_message", "message": "Reading. " + markup},
        ))

    engine = CodexCliEngine(runtime_root=tmp_path, run_process=run_process)
    store = TurnDiagnosticsStore()
    tools = [{"name": "read_file"}, {"name": "list_dir"}]
    with _binding(engine, store):
        if streaming:
            _, result = _drain_stream(engine.stream_with_tools("private-prompt-sentinel", tools))
        else:
            result = engine.generate_with_tools("private-prompt-sentinel", tools)
    assert result.finish_reason == "tool_calls"
    snapshot, call = _snapshot(store)
    assert snapshot["provider_tool_count"] == 2
    assert snapshot["provider_tool_capable"] is True
    assert call["finish_reason"] == "tool_calls"
    assert snapshot["buffered_visible_output_chars"] == len(result.content)


@pytest.mark.parametrize("kind", ["cli", "remote", "local"])
def test_snapshot_separates_configuration_from_residency(monkeypatch, tmp_path, kind) -> None:
    engine: Any
    if kind == "cli":
        engine = CodexCliEngine(runtime_root=tmp_path)
        engine.load_model("x")
    elif kind == "remote":
        engine, _ = _engine(monkeypatch)
        engine.load_model("x")
    else:
        engine = SimpleNamespace(model_name="x", _ready=True)
    snapshot = build_local_runtime_payload(
        runtime_config=SimpleNamespace(engine_type=kind, model="stale-selection"), engine=engine,
    )
    assert snapshot["model"] == {
        "id": "x", "configured": True, "residency": kind,
        "loaded": True if kind == "local" else None,
    }
    assert snapshot["readiness"]["status"] == "ready"
    assert snapshot["readiness"]["ready"] is True
