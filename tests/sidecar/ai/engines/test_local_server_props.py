from __future__ import annotations

from unittest.mock import Mock

import pytest

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
