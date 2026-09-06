from __future__ import annotations

import socket
from dataclasses import dataclass
from typing import Any

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.engines.factory import create_engine


def test_create_engine_returns_mock_for_mock_type() -> None:
    selection = create_engine(RuntimeConfig(engine_type="mock", model="mock-v2"))
    assert selection.engine_type == "mock"
    assert selection.model == "mock-v2"
    assert selection.fallback_from is None
    assert selection.fallback_reason is None


def test_create_engine_unknown_type_falls_back_to_mock() -> None:
    selection = create_engine(RuntimeConfig(engine_type="unknown", model="ignored"))
    assert selection.engine_type == "mock"
    assert selection.model == "mock-v1"
    assert selection.fallback_from == "unknown"
    assert "Unknown engine type" in selection.fallback_reason


def test_create_engine_ollama_success(monkeypatch) -> None:
    @dataclass
    class _StubOllama:
        host: str | None = None
        request_timeout_seconds: int = 0
        configured_context_length: int | None = None
        profile_max_output_tokens: int | None = None
        profile_thinking_headroom: int | None = None
        loaded_model: str = ""

        def load_model(self, model_path: str) -> None:
            self.loaded_model = model_path

    monkeypatch.setattr("sidecar.ai.engines.factory.OllamaEngine", _StubOllama)

    selection = create_engine(
        RuntimeConfig(
            engine_type="ollama",
            model="llama3.2",
            api_url="http://localhost:11434",
            context_length=32768,
            ollama_request_timeout_seconds=480,
        )
    )

    assert selection.engine_type == "ollama"
    assert selection.model == "llama3.2"
    assert isinstance(selection.engine, _StubOllama)
    assert selection.engine.host == "http://localhost:11434"
    assert selection.engine.request_timeout_seconds == 480
    assert selection.engine.configured_context_length == 32768
    assert selection.engine.loaded_model == "llama3.2"
    assert selection.fallback_from is None
    assert selection.fallback_reason is None


def test_create_engine_propagates_ollama_progress_callback(monkeypatch) -> None:
    observed: list[object] = []

    class _StubOllama:
        def __init__(self, **_: Any) -> None:
            pass

        def load_model(self, model_path: str, *, progress_callback=None) -> None:
            observed.append(model_path)
            observed.append(progress_callback)

    def callback(_payload) -> None:
        pass
    monkeypatch.setattr("sidecar.ai.engines.factory.OllamaEngine", _StubOllama)

    selection = create_engine(
        RuntimeConfig(engine_type="ollama", model="ornith:9b"),
        progress_callback=callback,
    )

    assert selection.engine_type == "ollama"
    assert observed == ["ornith:9b", callback]


def test_create_engine_ollama_blank_model_stays_unloaded(monkeypatch) -> None:
    @dataclass
    class _StubOllama:
        host: str | None = None
        request_timeout_seconds: int = 0
        configured_context_length: int | None = None
        profile_max_output_tokens: int | None = None
        profile_thinking_headroom: int | None = None
        loaded_model: str = ""

        def load_model(self, model_path: str) -> None:
            self.loaded_model = model_path

    monkeypatch.setattr("sidecar.ai.engines.factory.OllamaEngine", _StubOllama)

    selection = create_engine(
        RuntimeConfig(engine_type="ollama", model="", api_url="http://localhost:11434")
    )

    assert selection.engine_type == "ollama"
    assert selection.model == ""
    assert isinstance(selection.engine, _StubOllama)
    assert selection.engine.host == "http://localhost:11434"
    assert selection.engine.loaded_model == ""
    assert selection.fallback_from is None
    assert selection.fallback_reason is None


def test_create_engine_ollama_failure_falls_back_to_mock(monkeypatch) -> None:
    class _FailingOllama:
        def __init__(self, **_: Any) -> None:
            pass

        def load_model(self, model_path: str) -> None:  # noqa: ARG002
            raise RuntimeError("boom")

    monkeypatch.setattr("sidecar.ai.engines.factory.OllamaEngine", _FailingOllama)

    selection = create_engine(RuntimeConfig(engine_type="ollama", model="llama3.2"))

    assert selection.engine_type == "mock"
    assert selection.model == "mock-v1"
    assert selection.fallback_from == "ollama"
    assert "RuntimeError" in selection.fallback_reason


def test_create_engine_closes_partially_initialized_provider_before_fallback(monkeypatch) -> None:
    instances: list[Any] = []

    class _FailingOllama:
        def __init__(self, **_: Any) -> None:
            self.unload_count = 0
            self.close_count = 0
            instances.append(self)

        def load_model(self, model_path: str) -> None:  # noqa: ARG002
            raise RuntimeError("boom")

        def unload_model(self) -> None:
            self.unload_count += 1

        def close(self) -> None:
            self.close_count += 1

    monkeypatch.setattr("sidecar.ai.engines.factory.OllamaEngine", _FailingOllama)

    selection = create_engine(RuntimeConfig(engine_type="ollama", model="llama3.2"))

    assert selection.engine_type == "mock"
    assert instances[0].unload_count == 1
    assert instances[0].close_count == 1


def test_create_engine_vllm_success(monkeypatch) -> None:
    @dataclass
    class _StubVLLM:
        host: str | None = None
        loaded_model: str = ""

        def load_model(self, model_path: str) -> None:
            self.loaded_model = model_path

    monkeypatch.setattr("sidecar.ai.engines.factory.VLLMEngine", _StubVLLM)

    selection = create_engine(
        RuntimeConfig(engine_type="vllm", model="Qwen/Qwen3.5-9B", api_url="http://localhost:8000")
    )

    assert selection.engine_type == "vllm"
    assert selection.model == "Qwen/Qwen3.5-9B"
    assert isinstance(selection.engine, _StubVLLM)
    assert selection.engine.host == "http://localhost:8000"
    assert selection.engine.loaded_model == "Qwen/Qwen3.5-9B"
    assert selection.fallback_from is None
    assert selection.fallback_reason is None


def test_create_engine_vllm_failure_falls_back_to_mock(monkeypatch) -> None:
    class _FailingVLLM:
        def __init__(self, **_: Any) -> None:
            pass

        def load_model(self, model_path: str) -> None:  # noqa: ARG002
            raise RuntimeError("vllm not running")

    monkeypatch.setattr("sidecar.ai.engines.factory.VLLMEngine", _FailingVLLM)

    selection = create_engine(RuntimeConfig(engine_type="vllm", model="Qwen/Qwen3.5-9B"))

    assert selection.engine_type == "mock"
    assert selection.model == "mock-v1"
    assert selection.fallback_from == "vllm"
    assert "RuntimeError" in selection.fallback_reason


def test_create_engine_archived_cloud_types_are_unknown() -> None:
    for engine_type in ("anthropic", "openai", "gemini"):
        selection = create_engine(RuntimeConfig(engine_type=engine_type, model="ignored"))

        assert selection.engine_type == "mock"
        assert selection.model == "mock-v1"
        assert selection.fallback_from == engine_type
        assert f"Unknown engine type '{engine_type}'" == selection.fallback_reason


def test_create_engine_openai_compatible_success(monkeypatch) -> None:
    @dataclass
    class _StubOpenAICompat:
        host: str | None = None
        api_key: str | None = None
        configured_context_length: int | None = None
        profile_max_output_tokens: int | None = None
        profile_thinking_headroom: int | None = None
        loaded_model: str = ""

        def load_model(self, model_path: str) -> None:
            self.loaded_model = model_path

    monkeypatch.setattr(
        "sidecar.ai.engines.factory.OpenAICompatibleEngine",
        _StubOpenAICompat,
    )

    selection = create_engine(
        RuntimeConfig(
            engine_type="openai-compatible",
            model="qwen3.8:27b-q3-k-s",
            api_url="http://127.0.0.1:8033",
            context_length=131_072,
            resolved_app_profile_max_output_tokens=32_768,
            resolved_app_profile_thinking_token_headroom=32_768,
        )
    )

    assert selection.engine_type == "openai-compatible"
    assert selection.model == "qwen3.8:27b-q3-k-s"
    assert isinstance(selection.engine, _StubOpenAICompat)
    assert selection.engine.host == "http://127.0.0.1:8033"
    assert selection.engine.loaded_model == "qwen3.8:27b-q3-k-s"
    assert selection.engine.configured_context_length == 131_072
    assert selection.engine.profile_max_output_tokens == 32_768
    assert selection.engine.profile_thinking_headroom == 32_768
    assert selection.fallback_from is None
    assert selection.fallback_reason is None


def test_create_engine_openai_compatible_rejects_public_ip_before_init(monkeypatch) -> None:
    class _UnexpectedOpenAICompat:
        def __init__(self, **_: Any) -> None:
            raise AssertionError("public OpenAI-compatible hosts must not be initialized")

    monkeypatch.setattr(
        "sidecar.ai.engines.factory.OpenAICompatibleEngine",
        _UnexpectedOpenAICompat,
    )

    selection = create_engine(
        RuntimeConfig(
            engine_type="openai-compatible",
            model="gpt-4.1",
            api_url="https://8.8.8.8/v1",
        )
    )

    assert selection.engine_type == "mock"
    assert selection.fallback_from == "openai-compatible"
    assert "local-only" in str(selection.fallback_reason or "")


def test_create_engine_openai_compatible_rejects_public_dns_resolution(monkeypatch) -> None:
    class _UnexpectedOpenAICompat:
        def __init__(self, **_: Any) -> None:
            raise AssertionError("public OpenAI-compatible hosts must not be initialized")

    monkeypatch.setattr(
        "sidecar.ai.engines.factory.OpenAICompatibleEngine",
        _UnexpectedOpenAICompat,
    )
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(None, None, None, "", ("93.184.216.34", 443))],
    )

    selection = create_engine(
        RuntimeConfig(
            engine_type="openai-compatible",
            model="gpt-4.1",
            api_url="https://api.openai.com/v1",
        )
    )

    assert selection.engine_type == "mock"
    assert selection.fallback_from == "openai-compatible"
    assert "api.openai.com" in str(selection.fallback_reason or "")


def test_create_engine_openai_compatible_failure_falls_back_to_mock(monkeypatch) -> None:
    class _FailingOpenAICompat:
        def __init__(self, **_: Any) -> None:
            pass

        def load_model(self, model_path: str) -> None:  # noqa: ARG002
            raise RuntimeError("llama-server not running")

    monkeypatch.setattr(
        "sidecar.ai.engines.factory.OpenAICompatibleEngine",
        _FailingOpenAICompat,
    )

    selection = create_engine(
        RuntimeConfig(engine_type="openai-compatible", model="Qwen/Qwen3.6-35B-A3B")
    )

    assert selection.engine_type == "mock"
    assert selection.model == "mock-v1"
    assert selection.fallback_from == "openai-compatible"
    assert "RuntimeError" in selection.fallback_reason


def test_create_engine_codex_cli_success(monkeypatch, tmp_path) -> None:
    @dataclass
    class _StubCodexCli:
        command: str | None = None
        runtime_root: object | None = None
        request_timeout_seconds: int = 0
        loaded_model: str = ""

        def load_model(self, model_path: str) -> None:
            self.loaded_model = model_path

    monkeypatch.setattr("sidecar.ai.engines.factory.CodexCliEngine", _StubCodexCli)

    selection = create_engine(
        RuntimeConfig(
            engine_type="codex-cli",
            model="codex-cli/gpt-5.5",
            codex_cli_enabled=True,
            codex_cli_command="C:/Tools/codex.exe",
            codex_cli_runtime_root=str(tmp_path),
            codex_cli_request_timeout_seconds=777,
            codex_cli_auth_ready=True,
        )
    )

    assert selection.engine_type == "codex-cli"
    assert selection.model == "codex-cli/gpt-5.5"
    assert isinstance(selection.engine, _StubCodexCli)
    assert selection.engine.command == "C:/Tools/codex.exe"
    assert str(selection.engine.runtime_root) == str(tmp_path)
    assert selection.engine.request_timeout_seconds == 777
    assert selection.engine.loaded_model == "codex-cli/gpt-5.5"
    assert selection.fallback_from is None
    assert selection.fallback_reason is None


def test_create_engine_codex_cli_disabled_falls_back_to_mock(tmp_path) -> None:
    selection = create_engine(
        RuntimeConfig(
            engine_type="codex-cli",
            model="codex-cli/default",
            codex_cli_enabled=False,
            codex_cli_runtime_root=str(tmp_path),
        )
    )

    assert selection.engine_type == "mock"
    assert selection.model == "mock-v1"
    assert selection.fallback_from == "codex-cli"
    assert "disabled" in str(selection.fallback_reason)


def test_create_engine_codex_cli_auth_unready_falls_back_to_mock(tmp_path) -> None:
    selection = create_engine(
        RuntimeConfig(
            engine_type="codex-cli",
            model="codex-cli/default",
            codex_cli_enabled=True,
            codex_cli_runtime_root=str(tmp_path),
            codex_cli_auth_ready=False,
            codex_cli_auth_reason="Sign in with ChatGPT using codex login.",
        )
    )

    assert selection.engine_type == "mock"
    assert selection.model == "mock-v1"
    assert selection.fallback_from == "codex-cli"
    assert "ChatGPT" in str(selection.fallback_reason)
