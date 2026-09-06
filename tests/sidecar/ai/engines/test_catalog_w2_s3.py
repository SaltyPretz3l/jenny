from __future__ import annotations

import logging
from collections.abc import Callable

import pytest

from sidecar.ai.engines import catalog


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        (
            "http://LOCALHOST:8000/models?limit=1#catalog",
            "http://127.0.0.1:8000/models?limit=1#catalog",
        ),
        ("http://localhost", "http://127.0.0.1"),
    ],
)
def test_force_ipv4_localhost_handles_case_and_no_port(url: str, expected: str) -> None:
    assert catalog._force_ipv4_localhost(url) == expected  # noqa: SLF001


@pytest.mark.parametrize(
    "discover",
    [
        catalog.discover_vllm_models,
        catalog.discover_openai_compatible_models,
    ],
)
@pytest.mark.parametrize("payload", [{}, {"data": {}}])
def test_model_discovery_rejects_malformed_payload(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    discover: Callable[..., catalog.ModelCatalogResult],
    payload: dict[str, object],
) -> None:
    monkeypatch.setattr(catalog, "_get_provider_json", lambda **_kwargs: payload)

    with caplog.at_level(logging.WARNING, logger=catalog.__name__):
        result = discover()

    assert result.models == []
    assert result.available is False
    assert result.reason == "invalid_payload"
    assert any("invalid payload" in record.getMessage().lower() for record in caplog.records)
