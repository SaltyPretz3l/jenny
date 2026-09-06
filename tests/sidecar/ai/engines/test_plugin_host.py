from __future__ import annotations

import pytest

from sidecar.ai.config import RuntimeConfig, parse_runtime_config
from sidecar.ai.engines.factory import create_engine
from sidecar.ai.engines.plugin_host import PluginHostEngine
from sidecar.ai.engines.plugin_host_stream import MAX_FRAME_BYTES, validate_frame
from sidecar.ai.error_codes import CMP_PLUGIN_HOST_FAILED
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import ThinkingDelta


def test_plugin_host_factory_never_falls_back_to_mock() -> None:
    calls: list[str] = []

    def invoke(request):
        calls.append(request["operation"])
        if request["operation"] == "close":
            return ()
        return (
            {"sequence": 0, "kind": "text", "text": "hello"},
            {"sequence": 1, "kind": "done"},
        )

    selection = create_engine(
        RuntimeConfig(engine_type="plugin_host", model="research"),
        plugin_host_binding={"adapter_id": "research"},
        plugin_host_invoke=invoke,
        plugin_host_authority_check=lambda: True,
    )
    assert selection.engine_type == "plugin_host"
    assert selection.fallback_from is None
    assert isinstance(selection.engine, PluginHostEngine)
    assert selection.engine.generate("prompt") == "hello"
    assert calls == ["start", "close"]


def test_plugin_host_unavailable_is_bounded_and_not_mock() -> None:
    selection = create_engine(RuntimeConfig(engine_type="plugin_host", model=""))
    assert selection.engine_type == "plugin_host"
    with pytest.raises(ToolExecutionFailure) as raised:
        list(selection.engine.stream("prompt"))
    assert raised.value.code == CMP_PLUGIN_HOST_FAILED
    parsed = parse_runtime_config({"engine_type": "plugin_host", "model": ""})
    assert parsed.model == ""


def test_plugin_host_frame_decoder_rejects_order_and_unknown_fields() -> None:
    assert validate_frame({"sequence": 0, "kind": "done"}, 0)["kind"] == "done"
    with pytest.raises(ValueError, match="plugin_host_frame_invalid"):
        validate_frame({"sequence": 1, "kind": "done"}, 0)
    with pytest.raises(ValueError, match="plugin_host_frame_invalid"):
        validate_frame({"sequence": 0, "kind": "done", "plugin_rpc": "arbitrary"}, 0)
    with pytest.raises(ValueError, match="plugin_host_frame_invalid"):
        validate_frame({"sequence": 0, "kind": []}, 0)
    with pytest.raises(ValueError, match="plugin_host_frame_too_large"):
        validate_frame({"sequence": 0, "kind": "text", "text": "x" * MAX_FRAME_BYTES}, 0)


def test_plugin_host_tool_stream_returns_structured_result_and_closes() -> None:
    calls: list[str] = []
    start_payloads = []

    def invoke(request):
        calls.append(request["operation"])
        if request["operation"] == "start":
            start_payloads.append(request["input"])
        if request["operation"] == "close":
            return ()
        return (
            {"sequence": 0, "kind": "thinking", "text": "inspect"},
            {"sequence": 1, "kind": "text", "text": "answer"},
            {
                "sequence": 2,
                "kind": "tool_call",
                "tool_id": "workspace_read",
                "arguments": {"path": "README.md"},
                "call_id": "call-1",
            },
            {"sequence": 3, "kind": "done"},
        )

    engine = PluginHostEngine(
        {"adapter_id": "research"},
        invoke,
        authority_check=lambda: True,
    )
    offered_tools = [{"id": "workspace_read", "parameters": {"type": "object"}}]
    stream = engine.stream_with_tools("prompt", offered_tools)
    chunks = []
    while True:
        try:
            chunks.append(next(stream))
        except StopIteration as stopped:
            result = stopped.value
            break

    assert isinstance(chunks[0], ThinkingDelta)
    assert chunks[1] == "answer"
    assert result.content == "answer"
    assert result.thinking_text == "inspect"
    assert result.finish_reason == "tool_calls"
    assert result.tool_calls[0].tool_id == "workspace_read"
    assert calls == ["start", "close"]
    assert start_payloads[0]["tools"] == offered_tools


def test_plugin_host_rejected_frame_still_closes_transport() -> None:
    calls: list[str] = []

    def invoke(request):
        calls.append(request["operation"])
        if request["operation"] == "close":
            return ()
        return ({"sequence": 1, "kind": "done"},)

    engine = PluginHostEngine(
        {"adapter_id": "research"},
        invoke,
        authority_check=lambda: True,
    )
    with pytest.raises(ToolExecutionFailure) as raised:
        list(engine.stream("prompt"))
    assert raised.value.code == CMP_PLUGIN_HOST_FAILED
    assert calls == ["start", "close"]


def test_plugin_host_cancellation_emits_fixed_cancel_operation() -> None:
    callbacks = []
    calls: list[str] = []

    class Handle:
        cancelled = False

        def register_cancel_callback(self, callback):
            callbacks.append(callback)
            return lambda: callbacks.remove(callback) if callback in callbacks else None

        def raise_if_cancelled(self):
            if self.cancelled:
                raise ToolExecutionFailure(
                    code=CMP_PLUGIN_HOST_FAILED,
                    message="cancelled",
                    retryable=False,
                )

    handle = Handle()

    def invoke(request):
        calls.append(request["operation"])
        if request["operation"] == "start":
            handle.cancelled = True
            callbacks[0]("owner_cancelled")
            return ({"sequence": 0, "kind": "done"},)
        return ()

    engine = PluginHostEngine(
        {"adapter_id": "research"}, invoke, authority_check=lambda: True
    )
    with pytest.raises(ToolExecutionFailure):
        list(engine.stream("prompt", cancel_handle=handle))
    assert calls == ["start", "cancel", "close"]
