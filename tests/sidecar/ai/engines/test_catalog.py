from __future__ import annotations

import json
import logging
import time

from sidecar.ai.engines import catalog
from sidecar.ai.engines.provider_http import ProviderHttpError

QWEN35_CATALOG_ENTRY = {
    "id": "qwen3.5:9b",
    "capabilities": {
        "thinking": True,
        "reasoning_effort": True,
        "reasoning_efforts": ["none"],
        "default_reasoning_effort": "default",
    },
}


def _catalog_cache_path(state_root) -> object:
    return state_root / "ollama-catalog.json"


def test_discover_ollama_models_parses_tags_response(tmp_path, monkeypatch, caplog) -> None:
    def _fake_get_json(self, path: str):
        # Resolver default is 127.0.0.1, not localhost — see _force_ipv4_localhost
        # in sidecar/ai/engines/catalog.py (Windows IPv6 SYN-stall fix).
        assert self.base_url == "http://127.0.0.1:11434"
        if path == "/api/version":
            return {"version": "0.12.6"}
        assert path == "/api/tags"
        return {
            "models": [
                {"name": "qwen3.5:9b"},
                {"name": "gemma3:4b", "details": {"families": ["gemma3"]}},
                {"name": "llama3.2"},
                {"digest": "missing-name"},
            ]
        }

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _fake_get_json)

    with caplog.at_level(logging.DEBUG):
        result = catalog.discover_ollama_models(state_root=str(tmp_path))

    assert result.available is True
    assert result.reason == ""
    assert result.source == "api"
    assert result.stale is False
    assert result.models == [
        QWEN35_CATALOG_ENTRY,
        {"id": "gemma3:4b", "capabilities": {"vision": True}, "template_family": "gemma"},
        "llama3.2",
    ]
    records = [
        record for record in caplog.records
        if getattr(record, "event", "") == "ai.engines.catalog.ollama_discovery_succeeded"
    ]
    assert len(records) == 1
    assert records[0].levelno == logging.DEBUG


def test_parse_ollama_tags_payload_preserves_valid_model_sizes() -> None:
    models = catalog._parse_ollama_tags_payload(
        {
            "models": [
                {"name": "qwen3.5:9b", "size": 1_024.0},
                {"name": "llama3.2", "size": "2048"},
            ]
        }
    )

    assert models == [
        {**QWEN35_CATALOG_ENTRY, "size": 1_024},
        {"id": "llama3.2", "size": 2_048},
    ]


def test_parse_ollama_tags_payload_omits_invalid_model_sizes() -> None:
    models = catalog._parse_ollama_tags_payload(
        {
            "models": [
                {"name": "plain-absent"},
                {"name": "plain-zero", "size": 0},
                {"name": "plain-negative", "size": -1},
                {"name": "plain-garbage", "size": "not-a-size"},
                {"name": "plain-bool", "size": True},
                {"name": "plain-fractional", "size": 1024.5},
            ]
        }
    )

    assert models == [
        "plain-absent",
        "plain-zero",
        "plain-negative",
        "plain-garbage",
        "plain-bool",
        "plain-fractional",
    ]


def test_discover_ollama_models_preserves_size_through_cache_round_trip(
    tmp_path,
    monkeypatch,
) -> None:
    def _live_get_json(self, path: str):
        del self
        if path == "/api/version":
            return {"version": "0.12.6"}
        assert path == "/api/tags"
        return {"models": [{"name": "llama3.2", "size": 4_096}]}

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _live_get_json)
    live_result = catalog.discover_ollama_models(state_root=str(tmp_path))

    def _failing_get_json(self, path: str):
        del self
        if path == "/api/version":
            return {"version": "0.12.6"}
        assert path == "/api/tags"
        raise ProviderHttpError(
            provider="ollama",
            status_code=None,
            code="CMP-CLOUD-1001",
            message="boom",
            retryable=False,
            classification="connection_error",
        )

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _failing_get_json)
    cached_result = catalog.discover_ollama_models(state_root=str(tmp_path))

    expected_models = [{"id": "llama3.2", "size": 4_096}]
    assert live_result.models == expected_models
    assert cached_result.source == "cache"
    assert cached_result.models == expected_models


def test_discover_ollama_models_uses_runtime_api_url(tmp_path, monkeypatch) -> None:
    def _fake_get_json(self, path: str):
        assert self.base_url == "http://127.0.0.1:11434"
        if path == "/api/version":
            return {"version": "0.12.6"}
        assert path == "/api/tags"
        return {"models": []}

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _fake_get_json)

    result = catalog.discover_ollama_models(
        api_url="http://127.0.0.1:11434/",
        state_root=str(tmp_path),
    )

    assert result.available is True
    assert result.models == []


def test_discover_ollama_models_retries_transient_api_failure(tmp_path, monkeypatch) -> None:
    attempts = {"count": 0}

    def _flaky_get_json(self, path: str):
        del self
        if path == "/api/version":
            return {"version": "0.12.6"}
        attempts["count"] += 1
        assert path == "/api/tags"
        if attempts["count"] == 1:
            raise ProviderHttpError(
                provider="ollama",
                status_code=None,
                code="CMP-CLOUD-1001",
                message="timed out",
                retryable=True,
                classification="api_timeout",
            )
        return {"models": [{"name": "qwen3.5:9b"}]}

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _flaky_get_json)
    monkeypatch.setattr(catalog.time, "sleep", lambda _seconds: None)

    result = catalog.discover_ollama_models(state_root=str(tmp_path))

    assert attempts["count"] == 2
    assert result.available is True
    assert result.models == [QWEN35_CATALOG_ENTRY]


def test_discover_ollama_models_writes_versioned_cache_on_api_success(
    tmp_path,
    monkeypatch,
) -> None:
    def _fake_get_json(self, path: str):
        assert self.base_url == "http://127.0.0.1:11434"
        if path == "/api/version":
            return {"version": "0.12.6"}
        assert path == "/api/tags"
        return {"models": [{"name": "qwen3.5:9b"}]}

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _fake_get_json)

    result = catalog.discover_ollama_models(state_root=str(tmp_path))

    assert result.available is True
    assert result.source == "api"
    assert result.stale is False
    assert result.daemon_version == "0.12.6"
    assert result.cached_at
    assert result.expires_at
    assert result.models == [QWEN35_CATALOG_ENTRY]

    payload = json.loads(_catalog_cache_path(tmp_path).read_text(encoding="utf-8"))
    assert payload["schema_version"] == 1
    assert payload["catalogs"] == [
        {
            "base_url": "http://127.0.0.1:11434",
            "daemon_version": "0.12.6",
            "models": [QWEN35_CATALOG_ENTRY],
            "cached_at": result.cached_at,
            "expires_at": result.expires_at,
        }
    ]


def test_discover_ollama_models_returns_stale_cache_after_api_failure(
    tmp_path,
    monkeypatch,
) -> None:
    def _seed_get_json(self, path: str):
        del self
        if path == "/api/version":
            return {"version": "0.12.6"}
        assert path == "/api/tags"
        return {"models": [{"name": "qwen3.5:9b"}]}

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _seed_get_json)
    seeded = catalog.discover_ollama_models(state_root=str(tmp_path))
    assert seeded.source == "api"

    def _failing_get_json(self, path: str):
        del self
        if path == "/api/version":
            return {"version": "0.12.6"}
        assert path == "/api/tags"
        raise ProviderHttpError(
            provider="ollama",
            status_code=None,
            code="CMP-CLOUD-1001",
            message="boom",
            retryable=False,
            classification="connection_error",
        )

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _failing_get_json)

    result = catalog.discover_ollama_models(state_root=str(tmp_path))

    assert result.available is True
    assert result.source == "cache"
    assert result.stale is True
    assert str(tmp_path) not in result.reason
    assert result.last_error == "connection_error"
    assert result.daemon_version == "0.12.6"
    assert result.cached_at == seeded.cached_at
    assert result.expires_at == seeded.expires_at
    assert result.models == [QWEN35_CATALOG_ENTRY]


def test_discover_ollama_models_ignores_expired_cache_after_api_failure(
    tmp_path,
    monkeypatch,
) -> None:
    _catalog_cache_path(tmp_path).write_text(
        json.dumps(
            {
                "schema_version": 1,
                "catalogs": [
                    {
                        "base_url": "http://127.0.0.1:11434",
                        "daemon_version": "0.12.6",
                        "models": ["expired-model"],
                        "cached_at": "2000-01-01T00:00:00Z",
                        "expires_at": "2000-01-02T00:00:00Z",
                    }
                ],
            },
            ensure_ascii=True,
        ),
        encoding="utf-8",
    )

    def _failing_get_json(self, path: str):
        del self
        if path == "/api/version":
            return {"version": "0.12.6"}
        assert path == "/api/tags"
        raise ProviderHttpError(
            provider="ollama",
            status_code=None,
            code="CMP-CLOUD-1001",
            message="boom",
            retryable=False,
            classification="connection_error",
        )

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _failing_get_json)

    result = catalog.discover_ollama_models(state_root=str(tmp_path))

    assert result.available is False
    assert result.source == "api"
    assert result.stale is False
    assert result.models == []
    assert result.last_error == "connection_error"


def test_discover_ollama_models_does_not_reuse_cache_for_known_version_mismatch(
    tmp_path,
    monkeypatch,
) -> None:
    def _seed_get_json(self, path: str):
        del self
        if path == "/api/version":
            return {"version": "0.12.6"}
        assert path == "/api/tags"
        return {"models": [{"name": "qwen3.5:9b"}]}

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _seed_get_json)
    catalog.discover_ollama_models(state_root=str(tmp_path))

    def _failing_new_version_get_json(self, path: str):
        del self
        if path == "/api/version":
            return {"version": "0.12.7"}
        assert path == "/api/tags"
        raise ProviderHttpError(
            provider="ollama",
            status_code=None,
            code="CMP-CLOUD-1001",
            message="boom",
            retryable=False,
            classification="connection_error",
        )

    monkeypatch.setattr(
        catalog.ProviderHttpService,
        "get_json",
        _failing_new_version_get_json,
    )

    result = catalog.discover_ollama_models(state_root=str(tmp_path))

    assert result.available is False
    assert result.source == "api"
    assert result.stale is False
    assert result.last_error == "connection_error"
    assert result.models == []


def test_discover_ollama_models_preserves_future_cache_schema(
    tmp_path,
    monkeypatch,
) -> None:
    future_payload = {
        "schema_version": 99,
        "sentinel": "preserve-newer-cache",
        "catalogs": [],
    }
    _catalog_cache_path(tmp_path).write_text(
        json.dumps(future_payload, ensure_ascii=True),
        encoding="utf-8",
    )

    def _fake_get_json(self, path: str):
        del self
        if path == "/api/version":
            return {"version": "0.12.6"}
        assert path == "/api/tags"
        return {"models": [{"name": "qwen3.5:9b"}]}

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _fake_get_json)

    result = catalog.discover_ollama_models(state_root=str(tmp_path))

    assert result.available is True
    assert result.source == "api"
    assert result.models == [QWEN35_CATALOG_ENTRY]
    assert json.loads(_catalog_cache_path(tmp_path).read_text(encoding="utf-8")) == future_payload


def test_discover_ollama_models_ignores_boolean_cache_schema_version(
    tmp_path,
    monkeypatch,
) -> None:
    _catalog_cache_path(tmp_path).write_text(
        json.dumps(
            {
                "schema_version": True,
                "catalogs": [
                    {
                        "base_url": "http://localhost:11434",
                        "daemon_version": "0.12.6",
                        "models": ["stale-from-bool-schema"],
                        "cached_at": "2026-05-06T12:00:00Z",
                        "expires_at": "2026-05-07T12:00:00Z",
                    }
                ],
            },
            ensure_ascii=True,
        ),
        encoding="utf-8",
    )

    def _failing_get_json(self, path: str):
        del self
        if path == "/api/version":
            return {"version": "0.12.6"}
        assert path == "/api/tags"
        raise ProviderHttpError(
            provider="ollama",
            status_code=None,
            code="CMP-CLOUD-1001",
            message="boom",
            retryable=False,
            classification="connection_error",
        )

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _failing_get_json)

    result = catalog.discover_ollama_models(state_root=str(tmp_path))

    assert result.available is False
    assert result.source == "api"
    assert result.models == []


def test_discover_ollama_models_ignores_decimal_cache_schema_version(
    tmp_path,
    monkeypatch,
) -> None:
    _catalog_cache_path(tmp_path).write_text(
        json.dumps(
            {
                "schema_version": 1.9,
                "catalogs": [
                    {
                        "base_url": "http://localhost:11434",
                        "daemon_version": "0.12.6",
                        "models": ["stale-from-decimal-schema"],
                        "cached_at": "2026-05-06T12:00:00Z",
                        "expires_at": "2026-05-07T12:00:00Z",
                    }
                ],
            },
            ensure_ascii=True,
        ),
        encoding="utf-8",
    )

    def _failing_get_json(self, path: str):
        del self
        if path == "/api/version":
            return {"version": "0.12.6"}
        assert path == "/api/tags"
        raise ProviderHttpError(
            provider="ollama",
            status_code=None,
            code="CMP-CLOUD-1001",
            message="boom",
            retryable=False,
            classification="connection_error",
        )

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _failing_get_json)

    result = catalog.discover_ollama_models(state_root=str(tmp_path))

    assert result.available is False
    assert result.source == "api"
    assert result.models == []


def test_discover_ollama_models_skips_version_probe_when_cache_is_absent(
    tmp_path,
    monkeypatch,
) -> None:
    requested_paths: list[str] = []

    def _failing_get_json(self, path: str):
        del self
        requested_paths.append(path)
        assert path == "/api/tags"
        raise ProviderHttpError(
            provider="ollama",
            status_code=None,
            code="CMP-CLOUD-1001",
            message="boom",
            retryable=False,
            classification="connection_error",
        )

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _failing_get_json)

    result = catalog.discover_ollama_models(state_root=str(tmp_path))

    assert result.available is False
    assert result.models == []
    assert requested_paths == ["/api/tags"]


def test_discover_ollama_models_sanitizes_cached_model_entries(
    tmp_path,
    monkeypatch,
) -> None:
    _catalog_cache_path(tmp_path).write_text(
        json.dumps(
            {
                "schema_version": 1,
                "catalogs": [
                    {
                        "base_url": "http://127.0.0.1:11434",
                        "daemon_version": "0.12.6",
                        "models": [
                            {
                                "id": "gemma3:4b",
                                "capabilities": {"vision": True, "secret_flag": True},
                                "template_family": "gemma",
                                "raw_provider_payload": "drop",
                            },
                            {"secret": "drop"},
                            "  ",
                        ],
                        "cached_at": "2026-05-06T12:00:00Z",
                        "expires_at": "2099-05-07T12:00:00Z",
                    }
                ],
            },
            ensure_ascii=True,
        ),
        encoding="utf-8",
    )

    def _failing_get_json(self, path: str):
        del self
        if path == "/api/version":
            return {"version": "0.12.6"}
        assert path == "/api/tags"
        raise ProviderHttpError(
            provider="ollama",
            status_code=None,
            code="CMP-CLOUD-1001",
            message="boom",
            retryable=False,
            classification="connection_error",
        )

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _failing_get_json)

    result = catalog.discover_ollama_models(state_root=str(tmp_path))

    assert result.available is True
    assert result.source == "cache"
    assert result.models == [
        {
            "id": "gemma3:4b",
            "capabilities": {"vision": True},
            "template_family": "gemma",
        }
    ]


def test_discover_ollama_models_bounds_cached_model_entries(
    tmp_path,
    monkeypatch,
) -> None:
    oversized_model_id = f"model-{'x' * 280}"
    oversized_template_family = "template-" + ("y" * 80)
    cached_models = [
        oversized_model_id,
        {
            "id": "oversized-template:latest",
            "capabilities": {"vision": True},
            "template_family": oversized_template_family,
        },
    ]
    cached_models.extend(f"model-{index}:latest" for index in range(520))
    _catalog_cache_path(tmp_path).write_text(
        json.dumps(
            {
                "schema_version": 1,
                "catalogs": [
                    {
                        "base_url": "http://127.0.0.1:11434",
                        "daemon_version": "0.12.6",
                        "models": cached_models,
                        "cached_at": "2026-05-06T12:00:00Z",
                        "expires_at": "2099-05-07T12:00:00Z",
                    }
                ],
            },
            ensure_ascii=True,
        ),
        encoding="utf-8",
    )

    def _failing_get_json(self, path: str):
        del self
        if path == "/api/version":
            return {"version": "0.12.6"}
        assert path == "/api/tags"
        raise ProviderHttpError(
            provider="ollama",
            status_code=None,
            code="CMP-CLOUD-1001",
            message="boom",
            retryable=False,
            classification="connection_error",
        )

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _failing_get_json)

    result = catalog.discover_ollama_models(state_root=str(tmp_path))

    assert result.available is True
    assert result.source == "cache"
    assert len(result.models) == 512
    assert oversized_model_id not in result.models
    assert {
        "id": "oversized-template:latest",
        "capabilities": {"vision": True},
    } in result.models


def test_discover_ollama_models_sanitizes_rewritten_cache_entries(
    tmp_path,
    monkeypatch,
) -> None:
    # Seed under a port that doesn't collide with the resolver default
    # (127.0.0.1:11434) so the new write appends rather than overwrites,
    # exercising the sanitize-during-rewrite path on the seeded entry.
    _catalog_cache_path(tmp_path).write_text(
        json.dumps(
            {
                "schema_version": 1,
                "catalogs": [
                    {
                        "base_url": "http://127.0.0.1:11500",
                        "daemon_version": "0.12.6",
                        "models": [
                            {
                                "id": "other:latest",
                                "capabilities": {"vision": True, "secret_flag": True},
                                "raw_provider_payload": "drop",
                            }
                        ],
                        "cached_at": "2026-05-05T12:00:00Z",
                        "expires_at": "2099-05-06T12:00:00Z",
                        "extra": "drop",
                    }
                ],
            },
            ensure_ascii=True,
        ),
        encoding="utf-8",
    )

    def _fake_get_json(self, path: str):
        del self
        if path == "/api/version":
            return {"version": "0.12.6"}
        assert path == "/api/tags"
        return {"models": [{"name": "qwen3.5:9b"}]}

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _fake_get_json)

    catalog.discover_ollama_models(state_root=str(tmp_path))

    payload = json.loads(_catalog_cache_path(tmp_path).read_text(encoding="utf-8"))
    # Sorted by (base_url, daemon_version): 127.0.0.1:11434 (new) < 127.0.0.1:11500 (seed).
    assert payload["catalogs"][1] == {
        "base_url": "http://127.0.0.1:11500",
        "daemon_version": "0.12.6",
        "models": [{"id": "other:latest", "capabilities": {"vision": True}}],
        "cached_at": "2026-05-05T12:00:00Z",
        "expires_at": "2099-05-06T12:00:00Z",
    }


def test_discover_vllm_models_parses_v1_models_response(monkeypatch) -> None:
    def _fake_get_json(self, path: str):
        assert self.base_url == "http://127.0.0.1:8000"
        assert path == "/v1/models"
        return {
            "data": [
                {"id": "Qwen/Qwen3.5-9B", "object": "model"},
                {"id": "meta-llama/Llama-3.1-8B", "object": "model"},
                {"not_id": "bad-entry"},
            ]
        }

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _fake_get_json)

    result = catalog.discover_vllm_models()

    assert result.available is True
    assert result.models == [
        {"id": "Qwen/Qwen3.5-9B", "capabilities": {"thinking": True}},
        "meta-llama/Llama-3.1-8B",
    ]


def test_discover_vllm_models_handles_unreachable_server(monkeypatch) -> None:
    def _failing_get_json(self, path: str):
        del self, path
        raise ProviderHttpError(
            provider="vllm",
            status_code=None,
            code="CMP-CLOUD-1001",
            message="connection refused",
            retryable=True,
            classification="connection_error",
        )

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _failing_get_json)

    result = catalog.discover_vllm_models()

    assert result.available is False
    assert result.models == []
    assert "Could not query vLLM" in result.reason


def test_discover_vllm_models_uses_custom_api_url(monkeypatch) -> None:
    def _fake_get_json(self, path: str):
        assert self.base_url == "http://192.168.1.100:9000"
        assert path == "/v1/models"
        return {"data": []}

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _fake_get_json)

    result = catalog.discover_vllm_models(api_url="http://192.168.1.100:9000/")

    assert result.available is True
    assert result.models == []


def test_discover_vllm_models_annotates_vision_models(monkeypatch) -> None:
    def _fake_get_json(self, path: str):
        del self, path
        return {"data": [{"id": "Qwen/Qwen2.5-VL-7B-Instruct"}]}

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _fake_get_json)

    result = catalog.discover_vllm_models()

    assert result.available is True
    assert result.models == [
        {"id": "Qwen/Qwen2.5-VL-7B-Instruct", "capabilities": {"vision": True}}
    ]


def test_discover_openai_compatible_models_uses_shared_transport(monkeypatch) -> None:
    def _fake_get_json(self, path: str):
        assert self.base_url == "http://127.0.0.1:8033"
        assert path == "/v1/models"
        return {
            "data": [
                {"id": "qwen3.8:27b-q3-k-s"},
                {"id": "Qwen/Qwen3.6-35B-A3B"},
            ]
        }

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _fake_get_json)

    result = catalog.discover_openai_compatible_models()

    assert result.available is True
    assert result.models == [
        {
            "id": "qwen3.8:27b-q3-k-s",
            "capabilities": {
                "thinking": True,
                "reasoning_effort": True,
                "reasoning_efforts": ["none", "low", "medium", "xhigh"],
                "default_reasoning_effort": "medium",
            },
        },
        {
            "id": "Qwen/Qwen3.6-35B-A3B",
            "capabilities": {
                "thinking": True,
                "reasoning_effort": True,
                "reasoning_efforts": ["none"],
                "default_reasoning_effort": "default",
            },
        },
    ]


def test_discover_openai_compatible_models_sends_bearer_header_when_keyed(monkeypatch) -> None:
    seen_headers: list[dict[str, str]] = []
    original_init = catalog.ProviderHttpService.__init__

    def _capturing_init(self, *args, **kwargs):
        seen_headers.append(dict(kwargs.get("headers") or {}))
        original_init(self, *args, **kwargs)

    monkeypatch.setattr(catalog.ProviderHttpService, "__init__", _capturing_init)
    monkeypatch.setattr(
        catalog.ProviderHttpService,
        "get_json",
        lambda self, path: {"data": [{"id": "gemma4:12b"}]},
    )

    keyed = catalog.discover_openai_compatible_models(api_key="abc123")
    unkeyed = catalog.discover_openai_compatible_models()

    assert keyed.available is True and unkeyed.available is True
    assert seen_headers[0] == {"Accept": "application/json", "Authorization": "Bearer abc123"}
    assert seen_headers[1] == {"Accept": "application/json", "Authorization": "Bearer abc123"}
    assert seen_headers[2] == {"Accept": "application/json"}
    assert seen_headers[3] == {"Accept": "application/json"}


def test_openai_compatible_props_vision_true_promotes_all_models(monkeypatch) -> None:
    monkeypatch.setattr(
        catalog,
        "_get_provider_json",
        lambda **_kwargs: {"data": [{"id": "plain-one"}, {"id": "plain-two"}]},
    )
    monkeypatch.setattr(
        catalog,
        "probe_server_modalities",
        lambda **_kwargs: {"modalities": {"vision": True}},
    )

    result = catalog.discover_openai_compatible_models()

    assert result.models == [
        {"id": "plain-one", "capabilities": {"vision": True}},
        {"id": "plain-two", "capabilities": {"vision": True}},
    ]


def test_openai_compatible_props_vision_false_stamps_evidence_over_name_heuristic(
    monkeypatch,
) -> None:
    model = "Qwen/Qwen2.5-VL-7B-Instruct"
    monkeypatch.setattr(
        catalog,
        "_get_provider_json",
        lambda **_kwargs: {"data": [{"id": model}]},
    )
    monkeypatch.setattr(
        catalog,
        "probe_server_modalities",
        lambda **_kwargs: {"modalities": {"vision": False}},
    )

    result = catalog.discover_openai_compatible_models()

    # An authoritative False is evidence the renderer must block on; an absent
    # flag would only earn the soft "may not support images" notice.
    assert result.models == [{"id": model, "capabilities": {"vision": False}}]


def test_openai_compatible_missing_props_keeps_name_heuristic(monkeypatch) -> None:
    model = "Qwen/Qwen2.5-VL-7B-Instruct"
    monkeypatch.setattr(
        catalog,
        "_get_provider_json",
        lambda **_kwargs: {"data": [{"id": model}]},
    )
    monkeypatch.setattr(catalog, "probe_server_modalities", lambda **_kwargs: None)

    result = catalog.discover_openai_compatible_models()

    assert result.models == [
        {"id": model, "capabilities": {"vision": True}},
    ]


def test_discover_openai_compatible_models_reports_transport_classification(
    monkeypatch,
) -> None:
    def _failing_get_json(self, path: str):
        del self, path
        raise ProviderHttpError(
            provider="openai-compatible",
            status_code=None,
            code="CMP-CLOUD-1001",
            message="connection refused",
            retryable=True,
            classification="connection_error",
        )

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _failing_get_json)

    result = catalog.discover_openai_compatible_models()

    assert result.available is False
    assert result.models == []
    assert result.reason.endswith(": connection_error")


def test_is_vllm_vision_model_detects_known_patterns() -> None:
    assert catalog.is_vllm_vision_model("Qwen/Qwen2.5-VL-7B-Instruct") is True
    assert catalog.is_vllm_vision_model("llava-hf/llava-1.5-7b-hf") is True
    assert catalog.is_vllm_vision_model("meta-llama/Llama-3.1-8B") is False


def test_discover_ollama_models_falls_back_to_local_manifests(tmp_path, monkeypatch) -> None:
    manifest_dir = tmp_path / "manifests" / "registry.ollama.ai" / "library"
    (manifest_dir / "qwen3.5").mkdir(parents=True)
    (manifest_dir / "qwen3.5" / "9b").write_text("{}", encoding="utf-8")
    (manifest_dir / "gemma3").mkdir(parents=True)
    (manifest_dir / "gemma3" / "4b").write_text("{}", encoding="utf-8")

    def _failing_get_json(self, path: str):
        del self, path
        raise ProviderHttpError(
            provider="ollama",
            status_code=None,
            code="CMP-CLOUD-1001",
            message="boom",
            retryable=True,
            classification="connection_error",
        )

    monkeypatch.setattr(catalog.ProviderHttpService, "get_json", _failing_get_json)
    # The injected error is retryable, so discovery walks its backoff and sleeps
    # for real. The retry branch is what this test wants, not the wall-clock wait.
    monkeypatch.setattr(catalog.time, "sleep", lambda _seconds: None)

    result = catalog.discover_ollama_models(
        models_dir=str(tmp_path),
        state_root=str(tmp_path),
    )

    assert result.available is True
    assert result.models == [
        {"id": "gemma3:4b", "capabilities": {"vision": True}},
        {
            "id": "qwen3.5:9b",
            "capabilities": {
                "thinking": True,
                "reasoning_effort": True,
                "reasoning_efforts": ["none"],
                "default_reasoning_effort": "default",
            },
        },
    ]
    assert "Using local Ollama manifests" in result.reason


def test_entry_supports_fim_from_insert_capability() -> None:
    # Ollama /api/tags reports FIM models with an "insert" capability token.
    entry = {"name": "qwen2.5-coder:1.5b-base", "capabilities": ["completion", "insert"]}
    assert catalog._entry_supports_fim("qwen2.5-coder:1.5b-base", entry) is True
    normalized = catalog._normalize_ollama_catalog_entry(entry)
    assert normalized == {
        "id": "qwen2.5-coder:1.5b-base",
        "capabilities": {"insert": True},
    }


def test_entry_supports_fim_from_details_capabilities() -> None:
    entry = {"name": "custom:tag", "details": {"capabilities": ["insert"]}}
    assert catalog._entry_supports_fim("custom:tag", entry) is True


def test_entry_supports_fim_name_fallback_for_base_coder_families() -> None:
    # No capability token (e.g. manifest scan / older daemon) -> name heuristic.
    assert catalog._is_likely_fim_model("qwen2.5-coder:1.5b-base") is True
    assert catalog._is_likely_fim_model("deepseek-coder:6.7b-base") is True
    assert catalog._is_likely_fim_model("starcoder2:3b") is True
    assert catalog._is_likely_fim_model("codegemma:2b") is True
    assert (
        catalog._entry_supports_fim("qwen2.5-coder:1.5b-base", {"name": "qwen2.5-coder:1.5b-base"})
        is True
    )


def test_entry_does_not_mark_chat_models_as_fim() -> None:
    # A chat model with no "insert" capability and a non-coder name stays bare.
    entry = {"name": "gemma4-vision:12b", "capabilities": ["completion", "tools", "vision"]}
    assert catalog._entry_supports_fim("gemma4-vision:12b", entry) is False
    normalized = catalog._normalize_ollama_catalog_entry(entry)
    assert isinstance(normalized, dict)
    assert "insert" not in normalized.get("capabilities", {})
    assert catalog._is_likely_fim_model("llama3.2") is False
    assert catalog._is_likely_fim_model("") is False


def test_normalize_ollama_catalog_entry_carries_parameter_and_quant_fields() -> None:
    # Name deliberately avoids the vision/thinking/fim heuristics so the
    # normalized dict isolates just the new parameter/quant/digest fields.
    entry = {
        "name": "batiai/plainchat-12b:q6",
        "size": 9_800_000_000,
        "digest": "sha256:" + "a" * 64,
        "details": {"parameter_size": "12.0B", "quantization_level": "Q6_K"},
    }
    normalized = catalog._normalize_ollama_catalog_entry(entry)
    assert normalized == {
        "id": "batiai/plainchat-12b:q6",
        "size": 9_800_000_000,
        "parameter_size": "12.0B",
        "quantization_level": "Q6_K",
        "digest": "sha256:" + "a" * 64,
    }


def test_normalize_ollama_catalog_entry_bounds_and_omits_blank_fit_fields() -> None:
    entry = {
        "name": "custom:tag",
        "digest": "d" * 200,
        "details": {"parameter_size": "", "quantization_level": "p" * 64},
    }
    normalized = catalog._normalize_ollama_catalog_entry(entry)
    assert isinstance(normalized, dict)
    assert "parameter_size" not in normalized
    assert normalized["quantization_level"] == "p" * 32
    assert normalized["digest"] == "d" * 128


def test_normalize_ollama_catalog_entry_stays_bare_string_without_fit_fields() -> None:
    # No capabilities/template/size/fit fields at all -> collapses to the bare id.
    assert catalog._normalize_ollama_catalog_entry({"name": "plain:latest"}) == "plain:latest"


def test_is_likely_thinking_model_qwen36_variants() -> None:
    assert catalog._is_likely_thinking_model("qwen3.6-35b-a3b") is True
    assert catalog._is_likely_thinking_model("qwen3.6:35b-a3b") is True
    assert catalog._is_likely_thinking_model("qwen36:35b") is True
    assert catalog._is_likely_thinking_model("Qwen3.6-35B-A3B") is True
    assert catalog._is_likely_thinking_model("meta-llama/Llama-3.1-8B") is False
    assert catalog._is_likely_thinking_model("") is False


def test_qwen38_catalog_entry_advertises_native_ollama_effort_levels() -> None:
    normalized = catalog._normalize_ollama_catalog_entry(
        {"name": "hf.co/unsloth/Qwen3.8-27B-GGUF:Q3_K_S"}
    )

    assert normalized == {
        "id": "hf.co/unsloth/Qwen3.8-27B-GGUF:Q3_K_S",
        "capabilities": {
            "thinking": True,
            "reasoning_effort": True,
            "reasoning_efforts": ["none", "low", "medium", "high", "max"],
            "default_reasoning_effort": "medium",
        },
    }


def test_name_heuristics_strip_registry_namespace() -> None:
    # HF-pulled Ollama tags carry an hf.co/<org>/ prefix; the bare family in the
    # final path segment must still drive vision/thinking/FIM detection.
    assert catalog._is_likely_thinking_model("hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ4_XS") is True
    assert (
        catalog._is_likely_vision_model("hf.co/unsloth/Qwen2.5-VL-7B-Instruct-GGUF:Q4_K_M") is True
    )
    assert catalog._is_likely_fim_model("hf.co/unsloth/Qwen2.5-Coder-1.5B-Base-GGUF:Q4_K_M") is True
    assert catalog.is_vllm_vision_model("hf.co/unsloth/Qwen2.5-VL-7B-Instruct-GGUF") is True
    # A namespaced non-matching family stays unrecognized after the strip.
    assert catalog._is_likely_thinking_model("hf.co/unsloth/Llama-3.1-8B-Instruct-GGUF") is False


def test_resolve_base_url_defaults_contain_no_localhost() -> None:
    for value in (None, ""):
        assert "localhost" not in catalog.resolve_ollama_base_url(value)
        assert "localhost" not in catalog.resolve_vllm_base_url(value)
        assert "localhost" not in catalog.resolve_openai_compatible_base_url(value)


def test_resolve_base_url_rewrites_user_supplied_localhost_to_ipv4() -> None:
    assert catalog.resolve_ollama_base_url("http://localhost:11434") == "http://127.0.0.1:11434"
    assert catalog.resolve_vllm_base_url("http://localhost:8000") == "http://127.0.0.1:8000"
    assert (
        catalog.resolve_openai_compatible_base_url("http://localhost:8033/v1")
        == "http://127.0.0.1:8033"
    )


def test_resolve_base_url_preserves_non_host_occurrences_of_localhost() -> None:
    # localhost.example.com is a real hostname (localhost as a DNS label), and
    # /localhost in a path is a literal path segment — the rewrite is narrow on
    # purpose so a future "just .replace('localhost', '127.0.0.1')" simplification
    # can't silently break either case.
    assert "localhost" in catalog.resolve_ollama_base_url("http://localhost.example.com:8080")
    assert "localhost" in catalog.resolve_vllm_base_url("http://example.com/localhost")
    assert "localhost" in catalog.resolve_openai_compatible_base_url(
        "http://localhost.example.com:8080"
    )


def test_resolve_base_url_strips_trailing_slash_alongside_rewrite() -> None:
    result = catalog.resolve_ollama_base_url("http://localhost:11434/")
    assert not result.endswith("/")
    assert "localhost" not in result


def test_resolve_openai_compatible_base_url_strips_v1_suffix_alongside_rewrite() -> None:
    assert (
        catalog.resolve_openai_compatible_base_url("http://localhost:8033/v1")
        == "http://127.0.0.1:8033"
    )


def test_models_for_engine_includes_codex_cli_default() -> None:
    assert catalog.models_for_engine("codex-cli") == ["codex-cli/default"]


def test_ollama_discovery_stops_at_its_total_wall_clock_budget(monkeypatch, tmp_path) -> None:
    """The per-request timeout is not a ceiling; the steps summed past 10s.

    Electron abandons models.list at 10s. Unbudgeted, a slow daemon costs
    tags 2s + one retry 2s + 0.2s backoff + version 2s, and capabilities.py then
    spends another 2s on the per-model inspection -- past the client deadline
    before the manifest walk is even reached. So discovery must bound its whole
    network phase, not each socket independently.

    The stub sleeps for the FULL timeout it is handed, so the assertion below
    separates the two designs: clamped to the remaining budget it finishes in
    well under a second, unclamped it spends 2s per call.
    """
    monkeypatch.setattr(catalog, "_OLLAMA_DISCOVERY_TOTAL_BUDGET_SECONDS", 0.3)
    observed_timeouts: list[float] = []

    def _slow_get(*, provider, base_url, path, timeout_seconds):
        observed_timeouts.append(timeout_seconds)
        time.sleep(timeout_seconds)
        raise ProviderHttpError(
            provider="ollama",
            status_code=None,
            code="CMP-CLOUD-1001",
            message="unreachable",
            retryable=True,
            classification="connection_error",
        )

    monkeypatch.setattr(catalog, "_get_provider_json", _slow_get)
    started_at = time.monotonic()
    result = catalog.discover_ollama_models(
        api_url="http://127.0.0.1:11434",
        models_dir=str(tmp_path / "models"),
        state_root=str(tmp_path / "state"),
    )
    elapsed = time.monotonic() - started_at

    assert result is not None
    # Generous ceiling: the point is that it is bounded, not four full 2s steps.
    # Unbudgeted this is >4s (2s tags + 2s retry + backoff); budgeted it is ~0.3s.
    assert elapsed < 1.5, f"discovery ran {elapsed:.2f}s past its 0.3s budget"
    assert observed_timeouts, "discovery never issued a network call"
    assert all(t <= 0.3 + 1e-6 for t in observed_timeouts), observed_timeouts
