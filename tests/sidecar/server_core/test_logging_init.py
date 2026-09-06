from __future__ import annotations

import json
import sqlite3
from types import SimpleNamespace

from sidecar import server
from sidecar.protocol import API_VERSION
from sidecar.runtime import server_chat_workers


def test_log_path_uses_companion_logs_directory(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(server.Path, "home", classmethod(lambda cls: tmp_path))

    assert server._log_path() == tmp_path / ".companion" / "logs" / "sidecar.log"


def test_configure_logging_targets_utf8_rotating_log_file(monkeypatch, tmp_path) -> None:
    log_path = tmp_path / ".companion" / "logs" / "sidecar.log"
    captured: dict[str, object] = {}

    monkeypatch.setattr(server, "_log_path", lambda: log_path)
    monkeypatch.setattr(
        server,
        "configure_sidecar_logging",
        lambda path, **kwargs: (
            captured.setdefault("path", path),
            captured.setdefault("options", kwargs),
        ),
    )

    server.configure_logging()

    assert log_path.parent.exists()
    assert captured.get("path") == log_path
    assert captured.get("options") == {"mirror_to_stderr": True}


def test_process_message_initialize_sets_initialized_flag() -> None:
    message = {
        "jsonrpc": "2.0",
        "id": 11,
        "method": "initialize",
        "params": {"accept_version": API_VERSION},
    }

    outcome = server.process_message(message, initialized=False)

    assert outcome.initialized is True
    assert outcome.shutdown_requested is False
    assert outcome.response is not None
    assert outcome.response["result"]["active_model"] == "mock-v1"
    assert outcome.response["result"]["api_version"] == API_VERSION


def test_batch4_transport_enabled_requires_both_flags(monkeypatch) -> None:
    monkeypatch.setattr(
        server,
        "_BRAIN_CONTAINER",
        SimpleNamespace(
            stack=SimpleNamespace(
                config=SimpleNamespace(feature_flags={"multiplexer": True, "chat_cancel": True})
            )
        ),
    )
    assert server._batch4_transport_enabled() is True  # noqa: SLF001

    monkeypatch.setattr(
        server,
        "_BRAIN_CONTAINER",
        SimpleNamespace(
            stack=SimpleNamespace(
                config=SimpleNamespace(feature_flags={"multiplexer": True, "chat_cancel": False})
            )
        ),
    )
    assert server._batch4_transport_enabled() is False  # noqa: SLF001


def test_message_transport_ids_use_runtime_request_id_fallback() -> None:
    request_id, trace_id, session_id = server_chat_workers._message_transport_ids(  # noqa: SLF001
        {
            "jsonrpc": "2.0",
            "id": 77,
            "method": "chat.send",
            "params": {
                "messages": [{"role": "user", "content": "hello"}],
                "session_id": "session-fallback",
            },
        }
    )

    assert request_id == "req_77"
    assert trace_id == "req_77"
    assert session_id == "session-fallback"


def test_process_message_initialize_rejects_version_mismatch() -> None:
    message = {
        "jsonrpc": "2.0",
        "id": 12,
        "method": "initialize",
        "params": {"accept_version": "1999-01-01"},
    }

    outcome = server.process_message(message, initialized=False)

    assert outcome.initialized is False
    assert outcome.response is not None
    assert outcome.response["error"]["data"]["code"] == "CMP-PROTO-0001"


def test_process_message_shutdown_returns_acknowledgement() -> None:
    message = {
        "jsonrpc": "2.0",
        "id": 12_1,
        "method": "shutdown",
        "params": {"accept_version": API_VERSION},
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.initialized is True
    assert outcome.shutdown_requested is True
    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "shutting_down"
    assert outcome.response["result"]["api_version"] == API_VERSION


def test_initialize_includes_memory_wal_status(tmp_path) -> None:
    db_path = tmp_path / "memory.db"
    message = {
        "jsonrpc": "2.0",
        "id": 16,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {"memory_db_path": str(db_path)},
        },
    }

    outcome = server.process_message(message, initialized=False)

    assert outcome.response is not None
    memory = outcome.response["result"]["memory"]
    assert memory["journal_mode"] == "wal"

    db = sqlite3.connect(str(db_path))
    try:
        journal_mode = str(db.execute("PRAGMA journal_mode").fetchone()[0]).lower()
        assert journal_mode == "wal"
    finally:
        db.close()


def test_initialize_exposes_agent_name_only_identity_capabilities() -> None:
    """v3 retired the profile catalog; the capability payload follows."""
    message = {
        "jsonrpc": "2.0",
        "id": 17,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {
                "assistant_identity": {"agent_name": "Echo"},
                "personality_profile": "concise",
            },
        },
    }

    outcome = server.process_message(message, initialized=False)

    assert outcome.response is not None
    result = outcome.response["result"]
    assert result["assistant_identity"] == {"agent_name": "Echo"}
    assert "active_personality_profile" not in result
    assert "personality_profiles_available" not in result


def test_initialize_tolerates_a_downgraded_electron_legacy_identity_payload() -> None:
    """An older shell still sends every retired v2 personality key.

    `services/backend/managed-sidecar-config.js:758` still writes
    `personality_workspace_root`. `initialize` must succeed (no JSON-RPC
    error), keep the agent name, and drop the rest.
    """
    message = {
        "jsonrpc": "2.0",
        "id": 18,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {
                "engine_type": "mock",
                "model": "mock-v1",
                "assistant_identity": {
                    "agentName": "Echo",
                    "profile": "creative",
                    "customText": "Be theatrical.",
                },
                "personality_profile": "mentor",
                "assistant_custom_text": "Be terse.",
                "personality_workspace_root": "G:/Profiles/Jenny",
            },
        },
    }

    outcome = server.process_message(message, initialized=False)

    assert outcome.response is not None
    assert "error" not in outcome.response
    result = outcome.response["result"]
    assert result["assistant_identity"] == {"agent_name": "Echo"}
    serialized = json.dumps(result)
    for retired in ("personality_profile", "custom_text", "personality_workspace_root"):
        assert retired not in serialized
    for value in ("creative", "mentor", "theatrical", "Be terse."):
        assert value not in serialized


def test_initialize_exposes_provider_capabilities_without_secret_leak() -> None:
    message = {
        "jsonrpc": "2.0",
        "id": 18,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {
                "engine_type": "ollama",
                "model": "",
            },
            "secrets": {"anthropic_api_key": "top-secret-value"},
        },
    }

    outcome = server.process_message(message, initialized=False)

    assert outcome.response is not None
    result = outcome.response["result"]
    assert "provider_capabilities" in result
    assert set(result["provider_capabilities"]) == {
        "ollama",
        "vllm",
        "openai-compatible",
        "codex-cli",
        "chatgpt",
        "plugin_host",
        "replay",
        "mock",
    }
    assert result["provider_capabilities"]["ollama"]["available"] is True
    assert result["provider_capabilities"]["vllm"]["reasoning_effort_support"] == "supported"
    assert result["provider_capabilities"]["openai-compatible"]["requires_secret"] is False
    assert result["provider_capabilities"]["codex-cli"]["requires_secret"] is False
    assert result["provider_capabilities"]["codex-cli"]["available"] is False
    assert "ollama" in result["engines_available"]
    serialized = json.dumps(result)
    assert "top-secret-value" not in serialized


def test_initialize_exposes_feature_flags_payload() -> None:
    message = {
        "jsonrpc": "2.0",
        "id": 18_1,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {
                "feature_flags": {
                    "agent_executor": True,
                    "start_minimized_to_tray": False,
                    "ignored_non_boolean": "nope",
                }
            },
        },
    }

    outcome = server.process_message(message, initialized=False)

    assert outcome.response is not None
    result = outcome.response["result"]
    assert result["feature_flags"]["agent_executor"] is True
    assert result["feature_flags"]["start_minimized_to_tray"] is False
    assert "ignored_non_boolean" not in result["feature_flags"]


def test_initialize_exposes_context_metadata_fields() -> None:
    message = {
        "jsonrpc": "2.0",
        "id": 18_2,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {
                "context_length": 8192,
            },
        },
    }

    outcome = server.process_message(message, initialized=False)

    assert outcome.response is not None
    result = outcome.response["result"]
    assert result["configured_context_length"] == 8192
    assert result["native_context_length"] is None
    assert result["effective_context_length"] == 8192
