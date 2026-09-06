from __future__ import annotations

import logging
from unittest.mock import MagicMock

import pytest

from sidecar.protocol import (
    API_VERSION,
    INLINE_COMPLETE_METHOD,
    INLINE_LOADED_MODELS_METHOD,
    INLINE_UNLOAD_METHOD,
)
from sidecar.runtime import request_dispatch_inline as dispatch_mod
from sidecar.runtime.request_dispatch_inline import process_inline_method


def test_inline_notifications_skip_all_inline_operations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        dispatch_mod,
        "generate_inline_completion",
        lambda *_args, **_kwargs: calls.append("complete") or "completion",
    )
    monkeypatch.setattr(
        dispatch_mod,
        "list_loaded_inline_models",
        lambda *_args, **_kwargs: calls.append("loaded_models") or ["model"],
    )
    monkeypatch.setattr(
        dispatch_mod,
        "unload_inline_model",
        lambda *_args, **_kwargs: calls.append("unload") or True,
    )

    for method in (INLINE_COMPLETE_METHOD, INLINE_LOADED_MODELS_METHOD, INLINE_UNLOAD_METHOD):
        result = process_inline_method(
            method,
            None,
            {"accept_version": API_VERSION, "model": "model"},
            True,
            MagicMock(),
            logging.getLogger(__name__),
        )
        assert result is not None
        assert result.response is None

    assert calls == []
