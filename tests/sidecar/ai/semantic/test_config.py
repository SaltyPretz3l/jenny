from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.config_parsing import parse_semantic_catalog_config


def _raw(tmp_path: Path, **overrides: Any) -> dict[str, Any]:
    raw: dict[str, Any] = {
        "enabled": True,
        "db_path": str(tmp_path / "semantic-catalog.db"),
        "base_url": "http://127.0.0.1:8123/v1",
        "model_key": "embeddinggemma:q8_0:768",
        "query_template": "task: search result | query: {text}",
        "document_template": "title: {title} | text: {text}",
        "dims": 256,
    }
    raw.update(overrides)
    return raw


def test_runtime_config_parses_the_block_and_hides_the_key(tmp_path: Path) -> None:
    config = parse_runtime_config(
        {"semantic_catalog": _raw(tmp_path), "semantic_catalog_api_key": "sk-local-123"}
    )

    settings = config.semantic_catalog
    assert settings is not None
    assert settings.enabled is True
    assert settings.base_url == "http://127.0.0.1:8123/v1"
    assert settings.model_key == "embeddinggemma:q8_0:768"
    assert settings.dims == 256
    assert settings.api_key == "sk-local-123"
    assert "sk-local-123" not in repr(settings)
    assert "sk-local-123" not in repr(config)


def test_the_secret_key_is_a_known_top_level_key(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING):
        parse_runtime_config({"semantic_catalog": _raw(tmp_path), "semantic_catalog_api_key": "k"})

    assert not [record for record in caplog.records if "unknown" in record.getMessage()]


def test_key_is_optional_and_absent_or_disabled_is_none(tmp_path: Path) -> None:
    assert parse_semantic_catalog_config(_raw(tmp_path)).api_key is None  # type: ignore[union-attr]
    assert parse_runtime_config({}).semantic_catalog is None
    assert parse_semantic_catalog_config(_raw(tmp_path, enabled=False)) is None
    assert parse_semantic_catalog_config("on") is None


@pytest.mark.parametrize(
    "url",
    [
        "http://192.168.1.4:8123/v1",
        "https://127.0.0.1:8123/v1",
        "http://example.com:8123/v1",
        "http://127.0.0.1/v1",
        "http://127.0.0.1:8123/v2",
        "http://127.0.0.1:8123/v1/embeddings",
        "http://127.0.0.1:70000/v1",
        "http://user@127.0.0.1:8123/v1",
        42,
    ],
)
def test_non_loopback_or_malformed_urls_are_rejected(tmp_path: Path, url: object) -> None:
    assert parse_semantic_catalog_config(_raw(tmp_path, base_url=url)) is None


@pytest.mark.parametrize(
    "url", ["http://localhost:1/v1", "http://[::1]:65535/v1", "http://127.0.0.1:8123/v1"]
)
def test_loopback_urls_are_accepted(tmp_path: Path, url: str) -> None:
    assert parse_semantic_catalog_config(_raw(tmp_path, base_url=url)) is not None


@pytest.mark.parametrize(
    "template",
    [
        "no placeholder",
        "{title} only",
        "{text} and {query}",
        "{text} {0}",
        "{text}" + "x" * 600,
        None,
    ],
)
def test_bad_templates_are_rejected(
    tmp_path: Path, template: object, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING):
        assert parse_semantic_catalog_config(_raw(tmp_path, document_template=template)) is None
        assert parse_semantic_catalog_config(_raw(tmp_path, query_template=template)) is None
    messages = [record.getMessage() for record in caplog.records]
    assert any("document_template" in message for message in messages)
    assert not any("search result" in message for message in messages)  # no template bodies


@pytest.mark.parametrize(
    "overrides",
    [
        {"model_key": "Upper"},
        {"model_key": ""},
        {"model_key": "x" * 129},
        {"dims": -1},
        {"dims": 4097},
        {"dims": True},
        {"dims": 1.5},
        {"db_path": "relative/catalog.db"},
        {"db_path": ""},
    ],
)
def test_other_invalid_fields_are_rejected(tmp_path: Path, overrides: dict[str, Any]) -> None:
    assert parse_semantic_catalog_config(_raw(tmp_path, **overrides)) is None


def test_invalid_config_logs_one_warning_without_the_key(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING):
        parse_semantic_catalog_config(_raw(tmp_path, dims=-5), api_key="sk-secret-999")

    warnings = [record for record in caplog.records if record.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "sk-secret-999" not in warnings[0].getMessage()
