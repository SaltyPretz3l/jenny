"""Tests for sidecar.ai.context.tokenizers."""

from __future__ import annotations

import sys
import types

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
# TiktokenBackend encode/decode (stubbed tiktoken)
# ---------------------------------------------------------------------------


class _ByteEncoding:
    """Deterministic stand-in for a tiktoken ``Encoding``: one id per UTF-8 byte."""

    def encode(self, text: str) -> list[int]:
        return list(text.encode("utf-8"))

    def decode(self, token_ids: list[int]) -> str:
        return bytes(token_ids).decode("utf-8")


@pytest.fixture
def byte_encoding_tiktoken(monkeypatch: pytest.MonkeyPatch) -> types.ModuleType:
    """Inject a stub ``tiktoken`` whose encoding round-trips, so the backend's own
    encode/decode/count paths run with or without the wheel installed."""
    module = types.ModuleType("tiktoken")
    module.get_encoding = lambda _name: _ByteEncoding()  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "tiktoken", module)
    return module


def test_tiktoken_backend_encode_decode_roundtrip(
    byte_encoding_tiktoken: types.ModuleType,
) -> None:
    backend = create_tokenizer_backend()
    assert isinstance(backend, TiktokenBackend)
    text = "Hello, world! This is a test."
    ids = backend.encode(text)
    assert isinstance(ids, list)
    assert len(ids) > 0
    assert backend.count_tokens(text) == len(ids)
    decoded = backend.decode(ids)
    assert decoded == text


def test_tiktoken_backend_encode_empty(byte_encoding_tiktoken: types.ModuleType) -> None:
    backend = create_tokenizer_backend()
    assert isinstance(backend, TiktokenBackend)
    assert backend.encode("") == []
    assert backend.decode([]) == ""


def test_create_tokenizer_backend_falls_back_when_tiktoken_is_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Covers the CharEstimation fallback and its ~4 chars/token contract. Forcing
    # the ImportError keeps it deterministic on a host that does have tiktoken.
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


@pytest.fixture
def fake_tiktoken(monkeypatch: pytest.MonkeyPatch) -> types.ModuleType:
    """Inject a stub ``tiktoken`` so headroom tests run with or without the wheel.

    The headroom factor depends only on the family -> encoding resolution, never
    on real encoding data, so ``get_encoding`` can return an inert object.
    """
    module = types.ModuleType("tiktoken")
    module.get_encoding = lambda _name: object()  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "tiktoken", module)
    return module


@pytest.mark.parametrize("model_family", ["qwen", "deepseek"])
def test_headroom_factor_local_family_fallback(
    model_family: str, fake_tiktoken: types.ModuleType
) -> None:
    backend = TiktokenBackend(model_family=model_family)
    assert backend.headroom_factor == CROSS_FAMILY_HEADROOM


def test_headroom_factor_cross_family(fake_tiktoken: types.ModuleType) -> None:
    backend = TiktokenBackend(model_family="llama3")
    assert backend.headroom_factor == CROSS_FAMILY_HEADROOM


def test_cross_family_headroom_is_ten_percent() -> None:
    assert CROSS_FAMILY_HEADROOM == 0.10

# ---------------------------------------------------------------------------
# Backend cache
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _fresh_backend_cache() -> None:
    tokenizers_module.reset_tokenizer_backend_cache()
    yield
    tokenizers_module.reset_tokenizer_backend_cache()


def test_create_tokenizer_backend_shares_one_instance_per_family(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    built: list[str] = []

    class _Backend:
        def __init__(self, *, model_family: str = "") -> None:
            built.append(model_family)

    monkeypatch.setattr(tokenizers_module, "TiktokenBackend", _Backend)

    first = create_tokenizer_backend("qwen-local")
    second = create_tokenizer_backend("Qwen-Local ")
    other = create_tokenizer_backend("")

    assert first is second
    assert other is not first
    assert built == ["qwen-local", ""]


def test_a_caller_supplied_loader_bypasses_the_cache() -> None:
    loads: list[str] = []

    def loader(family: str) -> object:
        loads.append(family)
        return object()

    first = create_tokenizer_backend("qwen", local_tokenizer_loader=loader)
    second = create_tokenizer_backend("qwen", local_tokenizer_loader=loader)

    assert first is not second
    assert loads == ["qwen", "qwen"]


def test_a_transient_tiktoken_failure_is_served_but_not_pinned(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts: list[int] = []

    class _FlakyBackend:
        def __init__(self, *, model_family: str = "") -> None:
            attempts.append(1)
            if len(attempts) == 1:
                raise RuntimeError("BPE download failed")  # offline on first use

    monkeypatch.setattr(tokenizers_module, "TiktokenBackend", _FlakyBackend)

    first = create_tokenizer_backend("gamma")
    second = create_tokenizer_backend("gamma")
    third = create_tokenizer_backend("gamma")

    assert not hasattr(first, "encode"), "the first call served the char-estimation fallback"
    assert isinstance(second, _FlakyBackend), "the next call tried again and succeeded"
    assert third is second, "the real backend is the one that gets pinned"
    assert len(attempts) == 2


def test_the_tiktoken_fallback_is_logged_once_per_family(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
) -> None:
    def _no_tiktoken(**_kwargs: object) -> object:
        raise ImportError("tiktoken not installed")

    monkeypatch.setattr(tokenizers_module, "TiktokenBackend", _no_tiktoken)
    with caplog.at_level("INFO", logger=tokenizers_module.logger.name):
        create_tokenizer_backend("alpha")
        create_tokenizer_backend("beta")
        create_tokenizer_backend("alpha")

    fallback_lines = [r for r in caplog.records if "tiktoken not available" in r.getMessage()]
    assert len(fallback_lines) == 2

