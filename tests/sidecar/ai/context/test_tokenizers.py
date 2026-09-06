"""Tests for sidecar.ai.context.tokenizers."""

from __future__ import annotations

import pytest

import sidecar.ai.context.tokenizers as tokenizers_module
from sidecar.ai.context.tokenizers import (
    CROSS_FAMILY_HEADROOM,
    LocalModelTokenizerBackend,
    TiktokenBackend,
    _resolve_encoding_name,
    create_tokenizer_backend,
)

# ---------------------------------------------------------------------------
# Encoding resolution
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("model_family", ["qwen", "deepseek"])
def test_resolve_encoding_local_family_fallback_is_approximate(model_family: str) -> None:
    name, exact = _resolve_encoding_name(model_family)
    assert name == "cl100k_base"
    assert exact is False


def test_resolve_encoding_unknown_family() -> None:
    name, exact = _resolve_encoding_name("llama3")
    assert name == "cl100k_base"
    assert exact is False


def test_resolve_encoding_empty() -> None:
    name, exact = _resolve_encoding_name("")
    assert name == "cl100k_base"
    assert exact is False


# ---------------------------------------------------------------------------
# TiktokenBackend (only runs if tiktoken is installed)
# ---------------------------------------------------------------------------


def test_tiktoken_backend_available_or_fallback() -> None:
    """create_tokenizer_backend must always return a working backend."""
    backend = create_tokenizer_backend()
    assert hasattr(backend, "count_tokens")
    count = backend.count_tokens("Hello, world!")
    assert isinstance(count, int)
    assert count > 0


def test_tiktoken_backend_empty_string() -> None:
    backend = create_tokenizer_backend()
    assert backend.count_tokens("") == 0


def test_tiktoken_backend_protocol_compliance() -> None:
    """Backend must satisfy TokenizerBackend protocol."""
    backend = create_tokenizer_backend()
    assert hasattr(backend, "count_tokens")
    assert hasattr(backend, "get_context_window")
    assert hasattr(backend, "get_max_output_tokens")
    assert backend.get_context_window("any") > 0
    assert backend.get_max_output_tokens("any") > 0


def test_tiktoken_backend_count_consistency() -> None:
    """Counting the same text twice should give the same result."""
    backend = create_tokenizer_backend()
    text = "The quick brown fox jumps over the lazy dog."
    a = backend.count_tokens(text)
    b = backend.count_tokens(text)
    assert a == b


def test_create_tokenizer_backend_with_family() -> None:
    backend = create_tokenizer_backend(model_family="qwen")
    assert backend.count_tokens("test") > 0


def test_create_tokenizer_backend_unknown_family() -> None:
    backend = create_tokenizer_backend(model_family="unknown-thing")
    assert backend.count_tokens("test") > 0


def test_create_tokenizer_backend_prefers_local_loader_for_known_family() -> None:
    class _FakeTokenizer:
        def encode(self, text: str) -> list[int]:
            return list(range(len(text.split())))

        def decode(self, token_ids: list[int]) -> str:
            return " ".join(str(token_id) for token_id in token_ids)

    calls: list[str] = []

    def _loader(model_family: str) -> object:
        calls.append(model_family)
        return _FakeTokenizer()

    backend = create_tokenizer_backend(model_family="qwen", local_tokenizer_loader=_loader)

    assert isinstance(backend, LocalModelTokenizerBackend)
    assert calls == ["qwen"]
    assert backend.count_tokens("one two three") == 3
    assert backend.headroom_factor == 0.0


def test_create_tokenizer_backend_falls_back_when_local_loader_misses() -> None:
    backend = create_tokenizer_backend(
        model_family="gemma",
        local_tokenizer_loader=lambda _family: None,
    )

    assert not isinstance(backend, LocalModelTokenizerBackend)
    assert backend.count_tokens("test") > 0


# ---------------------------------------------------------------------------
# TiktokenBackend encode/decode (when available)
# ---------------------------------------------------------------------------


def test_tiktoken_backend_encode_decode_roundtrip() -> None:
    backend = create_tokenizer_backend()
    if not hasattr(backend, "encode"):
        # A bare `return` here reported a PASS while asserting nothing. tiktoken
        # is not in requirements, so that was the outcome on every dev machine
        # and in CI -- skip so the absence of coverage is visible.
        pytest.skip("tiktoken unavailable; CharEstimationBackend has no encode()")
    text = "Hello, world! This is a test."
    ids = backend.encode(text)
    assert isinstance(ids, list)
    assert len(ids) > 0
    decoded = backend.decode(ids)
    assert decoded == text


def test_tiktoken_backend_encode_empty() -> None:
    backend = create_tokenizer_backend()
    if not hasattr(backend, "encode"):
        pytest.skip("tiktoken unavailable; CharEstimationBackend has no encode()")
    assert backend.encode("") == []
    assert backend.decode([]) == ""


def test_create_tokenizer_backend_falls_back_when_tiktoken_is_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The two tests above skip wherever tiktoken is missing, which is everywhere
    # today. This one covers the path that IS taken: the documented
    # CharEstimation fallback and its ~4 chars/token contract. Forcing the
    # ImportError keeps it deterministic on a host that does have tiktoken.
    def _no_tiktoken(**_kwargs: object) -> object:
        raise ImportError("tiktoken not installed")

    monkeypatch.setattr(tokenizers_module, "TiktokenBackend", _no_tiktoken)

    backend = create_tokenizer_backend()

    assert not hasattr(backend, "encode")
    assert backend.count_tokens("") == 0
    assert backend.count_tokens("a" * 40) == 10
    assert backend.get_context_window("any-model") > 0


# ---------------------------------------------------------------------------
# Headroom factor
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("model_family", ["qwen", "deepseek"])
def test_headroom_factor_local_family_fallback(model_family: str) -> None:
    # importorskip surfaces a visible "skipped" when tiktoken is absent rather
    # than swallowing ImportError into a silent pass that covers nothing.
    pytest.importorskip("tiktoken")
    backend = TiktokenBackend(model_family=model_family)
    assert backend.headroom_factor == CROSS_FAMILY_HEADROOM


def test_headroom_factor_cross_family() -> None:
    pytest.importorskip("tiktoken")
    backend = TiktokenBackend(model_family="llama3")
    assert backend.headroom_factor == CROSS_FAMILY_HEADROOM


def test_cross_family_headroom_is_ten_percent() -> None:
    assert CROSS_FAMILY_HEADROOM == 0.10
