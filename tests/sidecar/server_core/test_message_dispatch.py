from __future__ import annotations

import logging
from types import SimpleNamespace

from sidecar import server
from sidecar.ai.engines.mock import MockEngine
from sidecar.protocol import API_VERSION, MCP_INSPECT_METHOD


def test_process_message_routes_mcp_inspect_without_publishing_notifications(monkeypatch) -> None:
    monkeypatch.setattr(
        "sidecar.runtime.request_dispatch_mcp.inspect_server",
        lambda _params, **_kwargs: {"ok": True, "tools": [], "tools_digest": "a" * 64},
    )
    monkeypatch.setattr(
        server,
        "_BRAIN_CONTAINER",
        SimpleNamespace(stack=SimpleNamespace(config=SimpleNamespace(
            tools_web_allow_private_addresses=False
        ))),
    )
    outcome = server.process_message({
        "jsonrpc": "2.0", "id": 117, "method": MCP_INSPECT_METHOD,
        "params": {"accept_version": API_VERSION, "server": {
            "name": "docs", "transport": "stdio", "command": "docs-mcp"
        }, "confirmed_stdio": True},
    }, initialized=True)

    assert outcome.response is not None
    assert outcome.response["id"] == 117
    assert outcome.response["result"]["tools_digest"] == "a" * 64
    assert outcome.notifications == []


def test_process_message_models_unload_calls_engine_unload(monkeypatch) -> None:
    state: dict[str, object] = {"unload_calls": 0, "tags": []}

    class FakeEngine:
        model_name = "qwen3.5:9b"

        def unload_model(self, name: str | None = None) -> None:
            state["unload_calls"] = int(state["unload_calls"]) + 1  # type: ignore[arg-type]
            state["tags"].append(name)  # type: ignore[union-attr]
            self.model_name = None

    fake_container = SimpleNamespace(stack=SimpleNamespace(engine=FakeEngine()))
    monkeypatch.setattr(server, "_BRAIN_CONTAINER", fake_container)

    message = {
        "jsonrpc": "2.0",
        "id": 12_2,
        "method": "models.unload",
        "params": {"accept_version": API_VERSION},
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.initialized is True
    assert outcome.shutdown_requested is False
    assert state["unload_calls"] == 1
    # An operator models.unload is an INTENTIONAL eviction, so the tag rides the
    # call explicitly: the engine's shared-daemon residency refcount must not
    # suppress it just because another generation still holds the same model.
    assert state["tags"] == ["qwen3.5:9b"]
    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "ok"
    assert outcome.response["result"]["model"] == ""
    assert outcome.response["result"]["unloaded_model"] == "qwen3.5:9b"
    assert outcome.response["result"]["api_version"] == API_VERSION


def test_process_message_models_unload_accepts_mock_engine_contract(monkeypatch) -> None:
    engine = MockEngine()
    engine.load_model("mock-v1")
    monkeypatch.setattr(
        server,
        "_BRAIN_CONTAINER",
        SimpleNamespace(stack=SimpleNamespace(engine=engine)),
    )

    outcome = server.process_message(
        {
            "jsonrpc": "2.0",
            "id": 12_21,
            "method": "models.unload",
            "params": {"accept_version": API_VERSION},
        },
        initialized=True,
    )

    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "ok"
    assert outcome.response["result"]["unloaded_model"] == "mock-v1"
    assert engine.model_name is None


def test_process_message_rejects_retired_active_turn_state_rpc() -> None:
    outcome = server.process_message(
        {
            "jsonrpc": "2.0",
            "id": 12_3,
            "method": "chat.get_active_turn_state",
            "params": {
                "accept_version": API_VERSION,
                "session_id": "session-none",
            },
        },
        initialized=True,
    )

    assert outcome.initialized is True
    assert outcome.shutdown_requested is False
    assert outcome.response is not None
    assert outcome.response["error"]["code"] == -32601


def test_process_message_hardware_vram_usage_returns_probe_payload(monkeypatch) -> None:
    monkeypatch.setattr(
        "sidecar.runtime.hardware_vram_usage.get_vram_usage",
        lambda: {
            "available": True,
            "used_mb": 2048,
            "total_mb": 8192,
            "gpu_type": "cuda",
            "source": "nvidia-smi",
            "sampled_at": "2026-01-01T00:00:00+00:00",
        },
    )

    message = {
        "jsonrpc": "2.0",
        "id": 12_3,
        "method": "hardware.vram_usage",
        "params": {"accept_version": API_VERSION},
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["result"]["available"] is True
    assert outcome.response["result"]["used_mb"] == 2048
    assert outcome.response["result"]["total_mb"] == 8192
    assert outcome.response["result"]["gpu_type"] == "cuda"
    assert outcome.response["result"]["api_version"] == API_VERSION


def test_process_message_hardware_vram_usage_rejects_version_mismatch() -> None:
    message = {
        "jsonrpc": "2.0",
        "id": 12_4,
        "method": "hardware.vram_usage",
        "params": {"accept_version": "1999-01-01"},
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["error"]["code"] == -32602
    assert outcome.response["error"]["data"]["code"] == "CMP-PROTO-0001"


def test_process_message_hardware_profile_rejects_version_mismatch(monkeypatch) -> None:
    called = False

    def probe(**_kwargs):
        nonlocal called
        called = True
        raise AssertionError("version validation must run before the probe")

    monkeypatch.setattr("sidecar.runtime.hardware_profile.get_hardware_profile", probe)
    outcome = server.process_message(
        {
            "jsonrpc": "2.0",
            "id": 12_5,
            "method": "hardware.profile",
            "params": {"accept_version": "1999-01-01"},
        },
        initialized=True,
    )

    assert called is False
    assert outcome.response is not None
    assert outcome.response["error"]["code"] == -32602
    assert outcome.response["error"]["data"]["code"] == "CMP-PROTO-0001"


def test_process_message_shutdown_rejects_version_mismatch_without_stopping() -> None:
    outcome = server.process_message(
        {
            "jsonrpc": "2.0",
            "id": 12_6,
            "method": "shutdown",
            "params": {"accept_version": "1999-01-01"},
        },
        initialized=True,
    )

    assert outcome.shutdown_requested is False
    assert outcome.response is not None
    assert outcome.response["error"]["code"] == -32602
    assert outcome.response["error"]["data"]["code"] == "CMP-PROTO-0001"


def test_process_message_models_list_returns_models(caplog) -> None:
    message = {
        "jsonrpc": "2.0",
        "id": 15,
        "method": "models.list",
        "params": {"accept_version": API_VERSION, "engine_type": "mock"},
    }

    with caplog.at_level(logging.DEBUG):
        outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["result"]["engine_type"] == "mock"
    assert "mock-v1" in outcome.response["result"]["models"]
    records = [
        record for record in caplog.records
        if getattr(record, "event", "") == "sidecar.runtime.models_list"
    ]
    assert len(records) == 1
    assert records[0].levelno == logging.DEBUG


def test_models_list_marks_archived_cloud_provider_unavailable() -> None:
    initialize = {
        "jsonrpc": "2.0",
        "id": 19,
        "method": "initialize",
        "params": {"accept_version": API_VERSION},
    }
    _ = server.process_message(initialize, initialized=False)

    models_list = {
        "jsonrpc": "2.0",
        "id": 20,
        "method": "models.list",
        "params": {"accept_version": API_VERSION, "engine_type": "openai"},
    }
    outcome = server.process_message(models_list, initialized=True)

    assert outcome.response is not None
    result = outcome.response["result"]
    assert result["available"] is False
    assert result["models"] == []
    assert result["reason"] == "provider 'openai' is archived"
