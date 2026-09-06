from __future__ import annotations

import sys
from types import SimpleNamespace

from sidecar.ai.config import RuntimeConfig, parse_runtime_config
from sidecar.ai.context.builder import WorkspaceStatus
from sidecar.ai.engines.catalog import ModelCatalogResult
from sidecar.runtime.capabilities import (
    _runtime_initialize_config,
    initialize_response,
    models_list_result,
)
from sidecar.runtime.provider_capabilities import (
    available_engine_types,
    build_provider_capabilities,
    is_engine_available,
)
from sidecar.runtime.provider_capability_profile import (
    ProviderCapabilityFeatures,
    ProviderCapabilityObserved,
    ProviderCapabilityProfileStore,
)


def test_build_provider_capabilities_exposes_local_runtime_engines_plus_codex_cli_opt_in() -> None:
    capabilities = build_provider_capabilities(RuntimeConfig())

    assert set(capabilities) == {
        "ollama",
        "vllm",
        "openai-compatible",
        "codex-cli",
        "chatgpt",
        "plugin_host",
        "replay",
        "mock",
    }
    assert capabilities["ollama"].available is True
    assert capabilities["vllm"].available is True
    assert capabilities["openai-compatible"].available is True
    assert capabilities["codex-cli"].available is False
    assert "disabled" in str(capabilities["codex-cli"].reason)
    assert capabilities["chatgpt"].available is False
    assert "not signed in" in str(capabilities["chatgpt"].reason)
    assert capabilities["plugin_host"].available is False
    assert capabilities["plugin_host"].reason == "plugin host engine unavailable"
    assert capabilities["mock"].available is True
    assert capabilities["vllm"].reasoning_effort_support == "supported"
    assert capabilities["openai-compatible"].reasoning_effort_support == "supported"
    assert capabilities["ollama"].reasoning_effort_support == "supported"


def test_plugin_host_capability_requires_an_active_generation_binding() -> None:
    configured = RuntimeConfig(engine_type="plugin_host", model="plugin:publisher/plugin/engine")
    assert build_provider_capabilities(configured)["plugin_host"].available is True
    listed = models_list_result(
        {
            "engine_type": "plugin_host",
            "_plugin_engine_models": ["plugin:publisher/plugin/engine"],
        },
        models_for_engine=lambda _engine: [],
    )
    assert listed == {
        "engine_type": "plugin_host",
        "models": ["plugin:publisher/plugin/engine"],
        "stale": False,
        "available": True,
        "reason": None,
    }


def test_initialize_response_exposes_active_model_reasoning_capabilities() -> None:
    stack = SimpleNamespace(
        config=RuntimeConfig(
            engine_type="ollama",
            model="qwen3.5:9b",
            resolved_app_profile_family="gemma4",
            resolved_app_profile_variant="e4b",
            resolved_app_profile_temperature=1.0,
            resolved_app_profile_top_k=40,
            resolved_app_profile_reasoning_parser_start="<|channel>thought",
            resolved_app_profile_reasoning_parser_end="<channel|>",
        ),
        engine=SimpleNamespace(
            capabilities={"text": True, "thinking": True},
            get_model_context_length=lambda: None,
        ),
        router=SimpleNamespace(
            available_tools=[],
            tools_status={
                "read_file": {
                    "available": True,
                    "reason": None,
                    "display_name": "Read File",
                    "source_kind": "builtin",
                    "tool_family": "filesystem",
                }
            },
        ),
        mcp_client=SimpleNamespace(diagnostics=lambda: SimpleNamespace(connected=(), failures=())),
        context_builder=SimpleNamespace(
            workspace_status=lambda: WorkspaceStatus(
                root=None,
                exists=False,
                skills_loaded=0,
                bootstrap_loaded=0,
                instruction_file_name=None,
                instruction_file_present=False,
            )
        ),
        memory_store=SimpleNamespace(db_path=":memory:", journal_mode="wal"),
        engine_fallback_from=None,
        engine_fallback_reason=None,
    )
    brain_container = SimpleNamespace(configure=lambda _raw, **_kwargs: stack)

    response = initialize_response(
        1,
        {"config": {"engine_type": "ollama", "model": "qwen3.5:9b"}},
        api_version="2026-03-06",
        brain_container=brain_container,
    )

    assert response["result"]["active_model_capabilities"] == {"text": True, "thinking": True}
    assert response["result"]["active_model_reasoning_support"] == "supported"
    assert response["result"]["active_app_profile"] == {
        "family": "gemma4",
        "variant": "e4b",
        "temperature": 1.0,
        "top_k": 40,
        "reasoning_parser": {
            "start": "<|channel>thought",
            "end": "<channel|>",
        },
    }
    assert response["result"]["tools_status"]["read_file"]["source_kind"] == "builtin"
    assert response["result"]["tools_status"]["read_file"]["tool_family"] == "filesystem"


def test_initialize_response_preserves_explicit_blank_ollama_model_for_lazy_load() -> None:
    captured_raw_config: dict[str, object] = {}
    stack = SimpleNamespace(
        config=RuntimeConfig(engine_type="ollama", model=""),
        engine=SimpleNamespace(
            capabilities={"text": True},
            get_model_context_length=lambda: None,
        ),
        router=SimpleNamespace(available_tools=[]),
        mcp_client=SimpleNamespace(diagnostics=lambda: SimpleNamespace(connected=(), failures=())),
        context_builder=SimpleNamespace(
            workspace_status=lambda: WorkspaceStatus(
                root=None,
                exists=False,
                skills_loaded=0,
                bootstrap_loaded=0,
                instruction_file_name=None,
                instruction_file_present=False,
            )
        ),
        memory_store=SimpleNamespace(db_path=":memory:", journal_mode="wal"),
        engine_fallback_from=None,
        engine_fallback_reason=None,
    )

    def configure(raw: object, **_kwargs: object) -> object:
        if isinstance(raw, dict):
            captured_raw_config.update(raw)
        return stack

    brain_container = SimpleNamespace(configure=configure)

    response = initialize_response(
        1,
        {"config": {"engine_type": "ollama", "model": ""}},
        api_version="2026-03-06",
        brain_container=brain_container,
    )

    assert captured_raw_config == {"engine_type": "ollama", "model": ""}
    assert response["result"]["active_engine"] == "ollama"
    assert response["result"]["active_model"] == ""


def test_initialize_response_exposes_web_tools_when_enabled() -> None:
    tools_status = {
        "edit_file": {
            "available": True,
            "reason": None,
            "display_name": "edit_file",
            "source_kind": None,
            "tool_family": None,
            "server_name": None,
        },
        "fetch_url": {
            "available": True,
            "reason": None,
            "display_name": "fetch_url",
            "source_kind": None,
            "tool_family": None,
            "server_name": None,
        },
        "read_file": {
            "available": True,
            "reason": None,
            "display_name": "read_file",
            "source_kind": None,
            "tool_family": None,
            "server_name": None,
        },
        "web_search": {
            "available": True,
            "reason": None,
            "display_name": "web_search",
            "source_kind": None,
            "tool_family": None,
            "server_name": None,
        },
    }
    stack = SimpleNamespace(
        config=RuntimeConfig(
            engine_type="ollama",
            model="qwen3.5:9b",
            tools_web_enabled=True,
        ),
        engine=SimpleNamespace(
            capabilities={"text": True},
            get_model_context_length=lambda: None,
        ),
        router=SimpleNamespace(
            available_tools=["edit_file", "fetch_url", "read_file", "web_search"],
            tools_status=tools_status,
        ),
        mcp_client=SimpleNamespace(diagnostics=lambda: SimpleNamespace(connected=(), failures=())),
        context_builder=SimpleNamespace(
            workspace_status=lambda: WorkspaceStatus(
                root=None,
                exists=False,
                skills_loaded=0,
                bootstrap_loaded=0,
                instruction_file_name=None,
                instruction_file_present=False,
            )
        ),
        memory_store=SimpleNamespace(db_path=":memory:", journal_mode="wal"),
        engine_fallback_from=None,
        engine_fallback_reason=None,
    )
    brain_container = SimpleNamespace(configure=lambda _raw, **_kwargs: stack)

    response = initialize_response(
        1,
        {"config": {"tools_web_enabled": True}},
        api_version="2026-03-06",
        brain_container=brain_container,
    )

    assert response["result"]["tools_available"] == [
        "edit_file",
        "fetch_url",
        "read_file",
        "web_search",
    ]
    assert response["result"]["tools_status"] == tools_status
    assert response["result"]["mcp_tools_available"] == [
        "edit_file",
        "fetch_url",
        "read_file",
        "web_search",
    ]


def test_initialize_response_omits_web_tools_when_disabled() -> None:
    tools_status = {
        "edit_file": {
            "available": True,
            "reason": None,
            "display_name": "edit_file",
            "source_kind": None,
            "tool_family": None,
            "server_name": None,
        },
        "read_file": {
            "available": True,
            "reason": None,
            "display_name": "read_file",
            "source_kind": None,
            "tool_family": None,
            "server_name": None,
        },
        "fetch_url": {
            "available": False,
            "reason": "config disabled",
            "display_name": "fetch_url",
            "source_kind": None,
            "tool_family": None,
            "server_name": None,
        },
        "web_search": {
            "available": False,
            "reason": "config disabled",
            "display_name": "web_search",
            "source_kind": None,
            "tool_family": None,
            "server_name": None,
        },
    }
    stack = SimpleNamespace(
        config=RuntimeConfig(engine_type="ollama", model="qwen3.5:9b"),
        engine=SimpleNamespace(
            capabilities={"text": True},
            get_model_context_length=lambda: None,
        ),
        router=SimpleNamespace(
            available_tools=["edit_file", "read_file"],
            tools_status=tools_status,
        ),
        mcp_client=SimpleNamespace(diagnostics=lambda: SimpleNamespace(connected=(), failures=())),
        context_builder=SimpleNamespace(
            workspace_status=lambda: WorkspaceStatus(
                root=None,
                exists=False,
                skills_loaded=0,
                bootstrap_loaded=0,
                instruction_file_name=None,
                instruction_file_present=False,
            )
        ),
        memory_store=SimpleNamespace(db_path=":memory:", journal_mode="wal"),
        engine_fallback_from=None,
        engine_fallback_reason=None,
    )
    brain_container = SimpleNamespace(configure=lambda _raw, **_kwargs: stack)

    response = initialize_response(
        1,
        {"config": {"tools_web_enabled": False}},
        api_version="2026-03-06",
        brain_container=brain_container,
    )

    assert response["result"]["tools_available"] == ["edit_file", "read_file"]
    assert response["result"]["tools_status"] == tools_status
    assert response["result"]["mcp_tools_available"] == ["edit_file", "read_file"]


def test_initialize_response_can_expose_python_runtime_tool_when_enabled() -> None:
    stack = SimpleNamespace(
        config=RuntimeConfig(
            engine_type="ollama",
            model="qwen3.5:9b",
            tools_python_runtime_enabled=True,
        ),
        engine=SimpleNamespace(
            capabilities={"text": True},
            get_model_context_length=lambda: None,
        ),
        router=SimpleNamespace(
            available_tools=["edit_file", "python_execute", "read_file"]
            if sys.platform == "win32"
            else ["edit_file", "read_file"]
        ),
        mcp_client=SimpleNamespace(diagnostics=lambda: SimpleNamespace(connected=(), failures=())),
        context_builder=SimpleNamespace(
            workspace_status=lambda: WorkspaceStatus(
                root=None,
                exists=False,
                skills_loaded=0,
                bootstrap_loaded=0,
                instruction_file_name=None,
                instruction_file_present=False,
            )
        ),
        memory_store=SimpleNamespace(db_path=":memory:", journal_mode="wal"),
        engine_fallback_from=None,
        engine_fallback_reason=None,
    )
    brain_container = SimpleNamespace(configure=lambda _raw, **_kwargs: stack)

    response = initialize_response(
        1,
        {"config": {"tools_python_runtime_enabled": True}},
        api_version="2026-03-06",
        brain_container=brain_container,
    )

    expected_tools = (
        ["edit_file", "python_execute", "read_file"]
        if sys.platform == "win32"
        else ["edit_file", "read_file"]
    )
    assert response["result"]["tools_available"] == expected_tools


def test_available_engine_types_uses_expected_order_and_includes_mock() -> None:
    capabilities = build_provider_capabilities(RuntimeConfig())

    assert available_engine_types(capabilities) == [
        "ollama",
        "vllm",
        "openai-compatible",
        "replay",
        "mock",
    ]


def test_codex_cli_capability_becomes_available_when_enabled(tmp_path) -> None:
    capabilities = build_provider_capabilities(
        RuntimeConfig(
            codex_cli_enabled=True,
            codex_cli_runtime_root=str(tmp_path),
            codex_cli_auth_ready=True,
        )
    )

    assert capabilities["codex-cli"].available is True
    assert capabilities["codex-cli"].requires_secret is False
    assert capabilities["codex-cli"].reason is None
    assert available_engine_types(capabilities) == [
        "ollama",
        "vllm",
        "openai-compatible",
        "codex-cli",
        "replay",
        "mock",
    ]


def test_codex_cli_capability_stays_unavailable_until_auth_ready(tmp_path) -> None:
    capabilities = build_provider_capabilities(
        RuntimeConfig(
            codex_cli_enabled=True,
            codex_cli_runtime_root=str(tmp_path),
            codex_cli_auth_ready=False,
            codex_cli_auth_reason="Codex CLI auth status has not been checked yet.",
        )
    )

    assert capabilities["codex-cli"].available is False
    assert "not been checked" in str(capabilities["codex-cli"].reason)
    assert "codex-cli" not in available_engine_types(capabilities)


def test_is_engine_available_has_safe_fallbacks() -> None:
    capabilities = build_provider_capabilities(RuntimeConfig())

    assert is_engine_available(capabilities, "mock") is True
    assert is_engine_available(capabilities, "unknown") is False
    assert is_engine_available(capabilities, "codex-cli") is False


def test_models_list_result_returns_unavailable_for_archived_provider() -> None:
    result = models_list_result(
        {
            "engine_type": "openai",
            "_runtime_config": RuntimeConfig(),
        },
        models_for_engine=lambda _engine: ["unused"],
    )

    assert result["available"] is False
    assert result["models"] == []
    assert "archived" in str(result["reason"])


def test_models_list_result_returns_models_for_mock_engine() -> None:
    runtime_config = RuntimeConfig()
    result = models_list_result(
        {"engine_type": "mock", "_runtime_config": runtime_config},
        models_for_engine=lambda _engine: ["mock-v1", "mock-v2"],
    )

    assert result == {
        "engine_type": "mock",
        "models": ["mock-v1", "mock-v2"],
        "stale": False,
        "available": True,
    }


def _codex_model_entries(*models: str) -> list[dict[str, object]]:
    return [
        {
            "id": model,
            "capabilities": {
                "reasoning_effort": True,
                "reasoning_efforts": ["none", "minimal", "low", "medium", "high", "xhigh"],
                "default_reasoning_effort": "default",
            },
        }
        for model in models
    ]


def test_models_list_result_returns_codex_cli_models_even_when_disabled() -> None:
    runtime_config = RuntimeConfig(codex_cli_models=("codex-cli/gpt-5.5",))
    result = models_list_result(
        {"engine_type": "codex-cli", "_runtime_config": runtime_config},
        models_for_engine=lambda _engine: ["codex-cli/default"],
    )

    assert result == {
        "engine_type": "codex-cli",
        "models": _codex_model_entries("codex-cli/default", "codex-cli/gpt-5.5"),
        "stale": False,
        "available": False,
        "reason": "Codex CLI integration is disabled.",
    }


def test_models_list_result_returns_available_codex_cli_models_when_enabled(tmp_path) -> None:
    runtime_config = RuntimeConfig(
        codex_cli_enabled=True,
        codex_cli_runtime_root=str(tmp_path),
        codex_cli_auth_ready=True,
        codex_cli_models=("codex-cli/gpt-5.5", "codex-cli/o4-mini"),
    )
    result = models_list_result(
        {"engine_type": "codex-cli", "_runtime_config": runtime_config},
        models_for_engine=lambda _engine: ["codex-cli/default"],
    )

    assert result == {
        "engine_type": "codex-cli",
        "models": _codex_model_entries(
            "codex-cli/default", "codex-cli/gpt-5.5", "codex-cli/o4-mini"
        ),
        "stale": False,
        "available": True,
        "reason": "",
    }


def test_models_list_result_normalizes_engine_type_tokens() -> None:
    runtime_config = RuntimeConfig()
    captured: dict[str, str] = {}

    def _models_for_engine(engine_type: str) -> list[str]:
        captured["engine_type"] = engine_type
        return [engine_type]

    result = models_list_result(
        {"engine_type": "  Mock  ", "_runtime_config": runtime_config},
        models_for_engine=_models_for_engine,
    )

    assert captured["engine_type"] == "mock"
    assert result == {
        "engine_type": "mock",
        "models": ["mock"],
        "stale": False,
        "available": True,
    }


def test_models_list_result_returns_ollama_discovery_failure_reason(monkeypatch) -> None:
    runtime_config = RuntimeConfig(engine_type="ollama", model="qwen3.5:9b")

    monkeypatch.setattr(
        "sidecar.runtime.capabilities.discover_ollama_models",
        lambda **kwargs: ModelCatalogResult(
            models=[],
            available=False,
            reason=f"Could not query Ollama at {kwargs.get('api_url') or 'http://localhost:11434'}: ConnectError",
        ),
    )

    result = models_list_result(
        {"engine_type": "ollama", "_runtime_config": runtime_config},
        models_for_engine=lambda _engine: ["unused"],
    )

    assert result == {
        "engine_type": "ollama",
        "models": [],
        "stale": False,
        "available": False,
        "reason": "Could not query Ollama at http://localhost:11434: ConnectError",
    }


def test_models_list_result_preserves_ollama_capability_metadata(monkeypatch) -> None:
    runtime_config = RuntimeConfig(
        engine_type="ollama",
        model="gemma3:4b",
        electron_state_root="G:/Users/Jenny/AppData/Roaming/jenny",
    )
    captured_kwargs: dict[str, object] = {}

    def _discover_ollama_models(**kwargs: object) -> ModelCatalogResult:
        captured_kwargs.update(kwargs)
        return ModelCatalogResult(
            models=[
                {"id": "gemma3:4b", "capabilities": {"vision": True}},
                {"id": "qwen3.5:9b", "capabilities": {"thinking": True}},
            ],
            available=True,
            reason="",
            source="cache",
            cached_at="2026-05-06T12:00:00Z",
            expires_at="2026-05-07T12:00:00Z",
            stale=True,
            last_error="connection_error",
            daemon_version="0.12.6",
        )

    monkeypatch.setattr(
        "sidecar.runtime.capabilities.discover_ollama_models",
        _discover_ollama_models,
    )

    result = models_list_result(
        {"engine_type": "ollama", "_runtime_config": runtime_config},
        models_for_engine=lambda _engine: ["unused"],
    )

    assert result == {
        "engine_type": "ollama",
        "models": [
            {"id": "gemma3:4b", "capabilities": {"vision": True}},
            {"id": "qwen3.5:9b", "capabilities": {"thinking": True}},
        ],
        "stale": True,
        "available": True,
        "reason": "",
        "source": "cache",
        "cached_at": "2026-05-06T12:00:00Z",
        "expires_at": "2026-05-07T12:00:00Z",
        "last_error": "connection_error",
        "daemon_version": "0.12.6",
    }
    assert captured_kwargs["state_root"] == "G:/Users/Jenny/AppData/Roaming/jenny"


def test_models_list_result_adds_exact_ollama_inspection_without_exposing_payload(
    monkeypatch,
) -> None:
    runtime_config = RuntimeConfig(engine_type="ollama", model="ornith15:9b-q6-256k")
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        "sidecar.runtime.capabilities.discover_ollama_models",
        lambda **_kwargs: ModelCatalogResult(
            models=[{"id": "ornith15:9b-q6-256k"}], available=True
        ),
    )

    def _inspect(**kwargs: object) -> dict[str, object]:
        captured.update(kwargs)
        return {
            "model_id": "ornith15:9b-q6-256k",
            "available": True,
            "native_context_length": 262_144,
            "reason": "",
        }

    monkeypatch.setattr("sidecar.runtime.capabilities.inspect_ollama_model", _inspect)

    result = models_list_result(
        {
            "engine_type": "ollama",
            "inspect_model_id": "ornith15:9b-q6-256k",
            "_runtime_config": runtime_config,
        },
        models_for_engine=lambda _engine: ["unused"],
    )

    assert captured == {
        "host": "http://127.0.0.1:11434",
        "model_id": "ornith15:9b-q6-256k",
    }
    assert result["models"] == [{"id": "ornith15:9b-q6-256k"}]
    assert result["model_inspection"] == {
        "model_id": "ornith15:9b-q6-256k",
        "available": True,
        "native_context_length": 262_144,
        "reason": "",
    }


def test_models_list_result_keeps_non_ollama_list_when_inspection_is_unsupported(
    monkeypatch,
) -> None:
    def _unexpected_inspection(**_kwargs: object) -> dict[str, object]:
        raise AssertionError("must not inspect a non-Ollama engine")

    monkeypatch.setattr(
        "sidecar.runtime.capabilities.inspect_ollama_model",
        _unexpected_inspection,
    )
    result = models_list_result(
        {"engine_type": "mock", "inspect_model_id": "model:latest"},
        models_for_engine=lambda _engine: ["mock-v1"],
    )

    assert result["models"] == ["mock-v1"]
    assert result["available"] is True
    assert result["model_inspection"] == {
        "model_id": "model:latest",
        "available": False,
        "native_context_length": None,
        "reason": "unsupported_engine",
    }


def test_models_list_result_keeps_ollama_catalog_when_inspection_fails(monkeypatch) -> None:
    monkeypatch.setattr(
        "sidecar.runtime.capabilities.discover_ollama_models",
        lambda **_kwargs: ModelCatalogResult(models=[{"id": "model:latest"}], available=True),
    )
    monkeypatch.setattr(
        "sidecar.runtime.capabilities.inspect_ollama_model",
        lambda **_kwargs: {
            "model_id": "model:latest",
            "available": False,
            "native_context_length": None,
            "reason": "provider_unavailable",
        },
    )

    result = models_list_result(
        {"engine_type": "ollama", "inspect_model_id": "model:latest"},
        models_for_engine=lambda _engine: ["unused"],
    )

    assert result["models"] == [{"id": "model:latest"}]
    assert result["available"] is True
    assert result["model_inspection"]["reason"] == "provider_unavailable"


def test_models_list_result_does_not_reuse_non_ollama_api_url_for_ollama_catalog(
    monkeypatch,
) -> None:
    runtime_config = RuntimeConfig(
        engine_type="openai-compatible",
        model="Qwen/Qwen3.6-35B-A3B",
        api_url="http://127.0.0.1:8033",
        ollama_models_dir="G:/llmmodels/ollama",
    )
    captured_kwargs: dict[str, object] = {}

    def _discover_ollama_models(**kwargs: object) -> ModelCatalogResult:
        captured_kwargs.update(kwargs)
        return ModelCatalogResult(
            models=[{"id": "qwen3.5:9b", "capabilities": {"thinking": True}}],
            available=True,
            reason="",
        )

    monkeypatch.setattr(
        "sidecar.runtime.capabilities.discover_ollama_models",
        _discover_ollama_models,
    )

    result = models_list_result(
        {"engine_type": "ollama", "_runtime_config": runtime_config},
        models_for_engine=lambda _engine: ["unused"],
    )

    assert captured_kwargs["api_url"] is None
    assert captured_kwargs["models_dir"] == "G:/llmmodels/ollama"
    assert result["models"] == [
        {"id": "qwen3.5:9b", "capabilities": {"thinking": True}},
    ]


def test_models_list_result_preserves_vllm_capability_metadata(monkeypatch) -> None:
    runtime_config = RuntimeConfig(
        engine_type="vllm", model="Qwen/Qwen3.5-9B", api_url="http://localhost:8000"
    )

    monkeypatch.setattr(
        "sidecar.runtime.capabilities.discover_vllm_models",
        lambda **_kwargs: ModelCatalogResult(
            models=[
                {"id": "Qwen/Qwen2.5-VL-7B-Instruct", "capabilities": {"vision": True}},
                {"id": "Qwen/Qwen3.5-9B", "capabilities": {"thinking": True}},
            ],
            available=True,
            reason="",
        ),
    )

    result = models_list_result(
        {"engine_type": "vllm", "_runtime_config": runtime_config},
        models_for_engine=lambda _engine: ["unused"],
    )

    assert result == {
        "engine_type": "vllm",
        "models": [
            {"id": "Qwen/Qwen2.5-VL-7B-Instruct", "capabilities": {"vision": True}},
            {"id": "Qwen/Qwen3.5-9B", "capabilities": {"thinking": True}},
        ],
        "stale": False,
        "available": True,
        "reason": "",
    }


def test_parse_runtime_config_normalizes_invalid_context_length_to_none() -> None:
    assert parse_runtime_config({"context_length": 0}).context_length is None
    assert parse_runtime_config({"context_length": -1}).context_length is None
    assert parse_runtime_config({"context_length": "bad"}).context_length is None


def test_runtime_initialize_config_drops_archived_cloud_secrets() -> None:
    params = {
        "config": {"engine_type": "openai", "model": "gpt-4.1"},
        "secrets": {
            "openai_api_key": "  openai-secret  ",
            "gemini_api_key": " ",
            "anthropic_api_key": 9,
        },
    }

    merged = _runtime_initialize_config(params)

    assert merged["engine_type"] == "openai"
    assert merged["model"] == "gpt-4.1"
    assert "openai_api_key" not in merged
    assert "gemini_api_key" not in merged
    assert "anthropic_api_key" not in merged


def test_runtime_initialize_config_ignores_invalid_payload_shapes() -> None:
    assert _runtime_initialize_config(None) == {}
    assert _runtime_initialize_config({"config": "bad", "secrets": "bad"}) == {}


def test_runtime_initialize_config_ignores_secret_keys_in_config_payload() -> None:
    merged = _runtime_initialize_config(
        {
            "config": {
                "engine_type": "openai",
                "openai_api_key": "config-should-not-win",
            },
            "secrets": {"openai_api_key": "runtime-secret"},
        }
    )

    assert merged["engine_type"] == "openai"
    assert "openai_api_key" not in merged


def test_initialize_response_includes_hardware_summary_field() -> None:
    """hardware_summary is present in initialize (None if not yet probed)."""
    stack = SimpleNamespace(
        config=RuntimeConfig(engine_type="mock", model="mock"),
        engine=SimpleNamespace(
            capabilities={"text": True},
            get_model_context_length=lambda: None,
        ),
        router=SimpleNamespace(available_tools=[]),
        mcp_client=SimpleNamespace(diagnostics=lambda: SimpleNamespace(connected=(), failures=())),
        context_builder=SimpleNamespace(
            workspace_status=lambda: WorkspaceStatus(
                root=None,
                exists=False,
                skills_loaded=0,
                bootstrap_loaded=0,
                instruction_file_name=None,
                instruction_file_present=False,
            )
        ),
        memory_store=SimpleNamespace(db_path=":memory:", journal_mode="wal"),
        engine_fallback_from=None,
        engine_fallback_reason=None,
    )
    brain_container = SimpleNamespace(configure=lambda _raw, **_kwargs: stack)

    response = initialize_response(
        1,
        {"config": {"engine_type": "mock"}},
        api_version="2026-03-06",
        brain_container=brain_container,
    )

    # hardware_summary key must be present (None if no probe yet, dict if cached)
    assert "hardware_summary" in response["result"]


def _stack_with_profile_store(profile_store: object) -> SimpleNamespace:
    return SimpleNamespace(
        config=RuntimeConfig(engine_type="ollama", model="qwen2.5:14b"),
        engine=SimpleNamespace(
            capabilities={"text": True},
            get_model_context_length=lambda: None,
        ),
        router=SimpleNamespace(
            available_tools=[],
            tools_status={},
        ),
        mcp_client=SimpleNamespace(diagnostics=lambda: SimpleNamespace(connected=(), failures=())),
        context_builder=SimpleNamespace(
            workspace_status=lambda: WorkspaceStatus(
                root=None,
                exists=False,
                skills_loaded=0,
                bootstrap_loaded=0,
                instruction_file_name=None,
                instruction_file_present=False,
            )
        ),
        memory_store=SimpleNamespace(db_path=":memory:", journal_mode="wal"),
        engine_fallback_from=None,
        engine_fallback_reason=None,
        provider_capability_profiles=profile_store,
    )


def test_initialize_response_includes_provider_capability_profiles_key() -> None:
    profile_store = ProviderCapabilityProfileStore()
    stack = _stack_with_profile_store(profile_store)
    brain_container = SimpleNamespace(configure=lambda _raw, **_kwargs: stack)

    response = initialize_response(
        1,
        {"config": {"engine_type": "ollama", "model": "qwen2.5:14b"}},
        api_version="2026-03-06",
        brain_container=brain_container,
    )

    assert "provider_capability_profiles" in response["result"]
    assert response["result"]["provider_capability_profiles"] == []


def test_initialize_response_provider_capability_profiles_with_populated_store() -> None:
    profile_store = ProviderCapabilityProfileStore()
    profile_store.record_probe_result(
        endpoint_id="ollama@http://localhost:11434",
        model_id="qwen2.5:14b",
        features=ProviderCapabilityFeatures(
            chat_supported=True,
            streaming_supported=True,
            native_tools_supported=True,
        ),
        observed=ProviderCapabilityObserved(max_context_advertised=32768),
        probe_status="ready",
        now=1700000000.0,
    )
    stack = _stack_with_profile_store(profile_store)
    brain_container = SimpleNamespace(configure=lambda _raw, **_kwargs: stack)

    response = initialize_response(
        1,
        {"config": {"engine_type": "ollama", "model": "qwen2.5:14b"}},
        api_version="2026-03-06",
        brain_container=brain_container,
    )

    profiles = response["result"]["provider_capability_profiles"]
    assert isinstance(profiles, list)
    assert len(profiles) == 1
    assert profiles[0]["profile_id"] == "ollama@http://localhost:11434::qwen2.5:14b"
    assert profiles[0]["selected_route"] == "native_tools"
    assert profiles[0]["features"]["native_tools_supported"] is True


def test_initialize_response_provider_capabilities_unchanged() -> None:
    profile_store = ProviderCapabilityProfileStore()
    stack = _stack_with_profile_store(profile_store)
    brain_container = SimpleNamespace(configure=lambda _raw, **_kwargs: stack)

    response = initialize_response(
        1,
        {"config": {"engine_type": "ollama", "model": "qwen2.5:14b"}},
        api_version="2026-03-06",
        brain_container=brain_container,
    )

    provider_capabilities = response["result"]["provider_capabilities"]
    assert set(provider_capabilities) == {
        "ollama",
        "vllm",
        "openai-compatible",
        "codex-cli",
        "chatgpt",
        "plugin_host",
        "replay",
        "mock",
    }
    for entry in provider_capabilities.values():
        assert "engine" in entry
        assert "available" in entry
        assert "reasoning_effort_support" in entry


def test_initialize_response_omits_profiles_when_stack_lacks_attribute() -> None:
    """Defensive: existing tests build SimpleNamespace stacks without the new
    attribute. The response must still expose an empty list rather than
    raising."""

    stack = SimpleNamespace(
        config=RuntimeConfig(engine_type="ollama", model="qwen2.5:14b"),
        engine=SimpleNamespace(
            capabilities={"text": True},
            get_model_context_length=lambda: None,
        ),
        router=SimpleNamespace(
            available_tools=[],
            tools_status={},
        ),
        mcp_client=SimpleNamespace(diagnostics=lambda: SimpleNamespace(connected=(), failures=())),
        context_builder=SimpleNamespace(
            workspace_status=lambda: WorkspaceStatus(
                root=None,
                exists=False,
                skills_loaded=0,
                bootstrap_loaded=0,
                instruction_file_name=None,
                instruction_file_present=False,
            )
        ),
        memory_store=SimpleNamespace(db_path=":memory:", journal_mode="wal"),
        engine_fallback_from=None,
        engine_fallback_reason=None,
    )
    brain_container = SimpleNamespace(configure=lambda _raw, **_kwargs: stack)

    response = initialize_response(
        1,
        {"config": {"engine_type": "ollama", "model": "qwen2.5:14b"}},
        api_version="2026-03-06",
        brain_container=brain_container,
    )

    assert response["result"]["provider_capability_profiles"] == []
