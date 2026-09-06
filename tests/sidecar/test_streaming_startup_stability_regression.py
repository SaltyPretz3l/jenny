"""Streaming + startup stability regression gate.

Locks the resolved freeze/thrash fixes behind a named test
(PARITY_CHECKLIST_UNSLOTH_STUDIO.md MUST-HAVE "Streaming + startup stability
regression gate") so the watched consistency axis can't silently regress.
This file does not add behaviour, it pins existing behaviour:

1. Streaming-freeze fix: the chunk-inactivity watchdog default was raised
   60s -> 120s and made configurable (``chunk_inactivity_seconds``).
2. Startup/model-load fix: cold model loads get a first-chunk grace window
   (``model_load_grace_seconds``, default 300s) so a legitimate slow (re)load
   no longer trips CMP-LOOP-0015. Behavioural coverage of the
   max(chunk_inactivity, model_load_grace) first-chunk semantics lives in
   tests/sidecar/ai/routing/test_generation_runtime.py.
3. GPU model-thrash fix: request ``num_ctx`` is normalized/capped before it
   reaches Ollama; the managed engine env side (OLLAMA_MAX_LOADED_MODELS=1)
   is pinned in tests/ollama-env.test.js.
"""

from __future__ import annotations

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.engines.ollama import _MAX_REQUEST_CONTEXT_LENGTH, OllamaEngine


def test_stability_watchdog_defaults_are_pinned() -> None:
    config = parse_runtime_config({})
    assert config.chunk_inactivity_seconds == 120.0
    assert config.model_load_grace_seconds == 300.0


def test_model_load_grace_never_undercuts_chunk_inactivity() -> None:
    # The runtime computes the first-chunk window as
    # max(chunk_inactivity_seconds, model_load_grace_seconds); with defaults
    # the grace window must dominate, so a cold load gets the full 300s.
    config = parse_runtime_config({})
    assert config.model_load_grace_seconds >= config.chunk_inactivity_seconds


def test_num_ctx_normalization_caps_and_rejects_garbage() -> None:
    normalize = OllamaEngine._normalize_configured_context_length
    assert _MAX_REQUEST_CONTEXT_LENGTH == 1_010_000
    assert normalize(None) is None
    assert normalize(0) is None
    assert normalize(-4096) is None
    assert normalize("garbage") is None  # type: ignore[arg-type]
    assert normalize(32_768) == 32_768
    assert normalize(_MAX_REQUEST_CONTEXT_LENGTH + 1) == _MAX_REQUEST_CONTEXT_LENGTH


def test_num_ctx_setter_applies_normalization() -> None:
    engine = OllamaEngine.__new__(OllamaEngine)
    engine.set_configured_context_length(_MAX_REQUEST_CONTEXT_LENGTH + 500_000)
    assert engine.get_configured_context_length() == _MAX_REQUEST_CONTEXT_LENGTH
    engine.set_configured_context_length(None)
    assert engine.get_configured_context_length() is None
