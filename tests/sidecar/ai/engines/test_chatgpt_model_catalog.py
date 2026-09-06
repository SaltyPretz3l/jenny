"""Provenance and conservatism guards for the static ChatGPT model catalog.

The catalog is a hand-maintained floor, not a value read from the provider: no
authenticated model-discovery call ships. These tests exist so a future edit that
raises a context length has to be a deliberate act with fresh provenance, rather
than drift nobody notices until requests start failing.
"""

from __future__ import annotations

from sidecar.ai.engines.chatgpt_subscription import (
    _DEFAULT_CHATGPT_CONTEXT_LENGTH,
    CHATGPT_MODEL_CONTEXT_LENGTHS,
    CHATGPT_MODEL_REASONING_PROFILES,
)


def test_no_catalog_entry_exceeds_the_conservative_default() -> None:
    # Every consumer of get_model_context_length() treats the window as a CEILING
    # (token_budget compaction threshold, chat_decision tool deferral, the renderer
    # context meter). A value that is too low only compacts earlier; one that is too
    # high produces hard request failures. So the catalog may never exceed the
    # conservative default without an owner-captured response justifying it.
    too_high = {
        model: length
        for model, length in CHATGPT_MODEL_CONTEXT_LENGTHS.items()
        if length > _DEFAULT_CHATGPT_CONTEXT_LENGTH
    }
    assert not too_high, (
        "catalog entries exceed the conservative floor without provenance: "
        f"{too_high}. Raising one requires an owner-captured response."
    )


def test_the_five_six_family_matches_the_pinned_first_party_evidence() -> None:
    # Pinned Codex release rust-v0.146.0 (peeled commit e363b08c) lists 272k for all
    # three. That is comparison evidence for the public CLI, not a contract for the
    # private endpoint -- but it is the only first-party number we have.
    for model in ("gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"):
        assert CHATGPT_MODEL_CONTEXT_LENGTHS[model] == 272_000


def test_codex_spark_matches_the_owner_captured_first_party_catalog() -> None:
    assert CHATGPT_MODEL_CONTEXT_LENGTHS["gpt-5.3-codex-spark"] == 128_000
    assert CHATGPT_MODEL_REASONING_PROFILES["gpt-5.3-codex-spark"] == {
        "default_reasoning_effort": "high",
        "reasoning_efforts": ["low", "medium", "high", "xhigh"],
    }


def test_every_catalog_value_is_a_positive_int() -> None:
    for model, length in CHATGPT_MODEL_CONTEXT_LENGTHS.items():
        assert isinstance(length, int) and length > 0, f"{model} -> {length!r}"
