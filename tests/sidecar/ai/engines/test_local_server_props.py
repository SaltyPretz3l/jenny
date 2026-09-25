from __future__ import annotations

import logging
from unittest.mock import Mock

import pytest

from sidecar.ai.engines import local_server_props
from sidecar.ai.engines.local_server_props import (
    context_length_from_props,
    probe_server_modalities,
    props_base_url,
    vision_from_props,
)
from sidecar.ai.engines.provider_http import ProviderHttpError, ProviderHttpService


@pytest.mark.parametrize(
    ("base_url", "expected"),
    [
        ("http://127.0.0.1:8033/v1", "http://127.0.0.1:8033"),
        ("http://127.0.0.1:8033/v1/", "http://127.0.0.1:8033"),
        ("http://127.0.0.1:8033", "http://127.0.0.1:8033"),
        ("http://127.0.0.1:8033/", "http://127.0.0.1:8033"),
    ],
)
def test_props_base_url(base_url: str, expected: str) -> None:
    assert props_base_url(base_url) == expected


@pytest.mark.parametrize(
    ("props", "expected"),
    [
        ({"modalities": {"vision": True}}, True),
        ({"modalities": {"vision": False}}, False),
        ({"modalities": {}}, None),
        ({"modalities": {"vision": "true"}}, None),
        ({}, None),
        (None, None),
        ([], None),
    ],
)
def test_vision_from_props(props: object, expected: bool | None) -> None:
    assert vision_from_props(props) is expected  # type: ignore[arg-type]


# Nested n_ctx is per-slot; top-level n_ctx is the total across slots.
@pytest.mark.parametrize(
    ("props", "expected"),
    [
        ({"default_generation_settings": {"n_ctx": 32768}}, 32768),
        ({"n_ctx": 16384}, None),
        ({"default_generation_settings": {"n_ctx": 32768}, "n_ctx": 16384}, 32768),
        ({"default_generation_settings": {}}, None),
        ({"default_generation_settings": {"n_ctx": 0}}, None),
        ({"default_generation_settings": {"n_ctx": -1}}, None),
        ({"default_generation_settings": {"n_ctx": True}}, None),
        ({"default_generation_settings": {"n_ctx": "32768"}}, None),
        ({"default_generation_settings": {"n_ctx": 32768.0}}, None),
        ({"default_generation_settings": []}, None),
        ({"default_generation_settings": [], "n_ctx": 16384}, None),
        ({"default_generation_settings": {"n_ctx": 0}, "n_ctx": 16384}, None),
        ({"n_ctx": 0}, None),
        ({"n_ctx": -1}, None),
        ({"n_ctx": True}, None),
        ({"n_ctx": "32768"}, None),
        ({}, None),
        (None, None),
        ([], None),
    ],
)
def test_context_length_from_props(props: object, expected: int | None) -> None:
    assert context_length_from_props(props) == expected  # type: ignore[arg-type]


def test_probe_returns_props_and_closes_service(monkeypatch: pytest.MonkeyPatch) -> None:
    close = Mock()
    get_json = Mock(return_value={"modalities": {"vision": True}})
    monkeypatch.setattr(ProviderHttpService, "get_json", get_json)
    monkeypatch.setattr(ProviderHttpService, "close", close)

    result = probe_server_modalities(
        base_url="http://127.0.0.1:8033/v1",
        headers={"Authorization": "Bearer key"},
    )

    assert result == {"modalities": {"vision": True}}
    get_json.assert_called_once_with("/props", timeout=2.0)
    close.assert_called_once_with()


@pytest.mark.parametrize(
    "error",
    [
        ProviderHttpError(
            provider="openai-compatible",
            status_code=404,
            code="CMP-CLOUD-1003",
            message="not found",
            retryable=False,
        ),
        TimeoutError("timed out"),
        ValueError("non-JSON response"),
    ],
)
def test_probe_returns_none_on_failure_and_closes(
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
) -> None:
    close = Mock()
    monkeypatch.setattr(ProviderHttpService, "get_json", Mock(side_effect=error))
    monkeypatch.setattr(ProviderHttpService, "close", close)

    assert probe_server_modalities(base_url="http://127.0.0.1:8033/v1") is None
    close.assert_called_once_with()


def test_probe_returns_none_for_non_object_json_and_closes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    close = Mock()
    monkeypatch.setattr(ProviderHttpService, "get_json", Mock(return_value=[]))
    monkeypatch.setattr(ProviderHttpService, "close", close)

    assert probe_server_modalities(base_url="http://127.0.0.1:8033/v1") is None
    close.assert_called_once_with()


def _unauthorized() -> ProviderHttpError:
    return ProviderHttpError(
        provider="openai-compatible",
        status_code=401,
        code="CMP-CLOUD-1001",
        message="unauthorized",
        retryable=False,
    )


def test_unauthorized_probe_warns_once_per_server_and_names_the_cause(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    # Owner session 2026-09-19: a managed llama-server logged "unauthorized:
    # Invalid API Key" on every catalog refresh while the served window and
    # vision verdict silently degraded -- the probe only logged at DEBUG.
    monkeypatch.setattr(local_server_props, "_auth_failures_logged", set())
    monkeypatch.setattr(ProviderHttpService, "get_json", Mock(side_effect=_unauthorized()))
    monkeypatch.setattr(ProviderHttpService, "close", Mock())

    with caplog.at_level(logging.DEBUG):
        assert probe_server_modalities(base_url="http://127.0.0.1:8033/v1") is None
        assert probe_server_modalities(base_url="http://127.0.0.1:8033/v1") is None
        assert probe_server_modalities(
            base_url="http://127.0.0.1:9099/v1",
            headers={"Authorization": "Bearer stale"},
        ) is None

    warnings = [
        record for record in caplog.records
        if getattr(record, "event", "") == "ai.engines.local_server_props.probe_unauthorized"
    ]
    assert [record.levelno for record in warnings] == [logging.WARNING, logging.WARNING]
    assert [record.data["base_url"] for record in warnings] == [
        "http://127.0.0.1:8033",
        "http://127.0.0.1:9099",
    ]
    assert [record.data["authenticated"] for record in warnings] == [False, True]
    assert [record.data["status_code"] for record in warnings] == [401, 401]
    assert "no API key for this server" in warnings[0].getMessage()
    assert "bearer token that the server rejected" in warnings[1].getMessage()


def test_non_auth_failures_stay_at_debug(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(local_server_props, "_auth_failures_logged", set())
    monkeypatch.setattr(ProviderHttpService, "get_json", Mock(side_effect=TimeoutError("slow")))
    monkeypatch.setattr(ProviderHttpService, "close", Mock())

    with caplog.at_level(logging.DEBUG):
        assert probe_server_modalities(base_url="http://127.0.0.1:8033/v1") is None

    events = [getattr(record, "event", "") for record in caplog.records]
    assert "ai.engines.local_server_props.probe_failed" in events
    assert "ai.engines.local_server_props.probe_unauthorized" not in events

