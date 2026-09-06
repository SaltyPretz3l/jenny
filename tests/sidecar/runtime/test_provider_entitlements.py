"""Entitlement-filtering seam for the ChatGPT model catalog.

No authenticated model-discovery call ships today, so this hook must behave as a
strict no-op for every current caller. These tests pin both halves: that it changes
nothing without entitlement data, and that when data eventually arrives it fails
open rather than emptying the renderer's model picker.
"""

from __future__ import annotations

from sidecar.runtime.provider_capabilities import (
    ProviderCapability,
    entitled_chatgpt_models,
)

_CATALOG = [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.3-codex-spark",
    "gpt-5.5",
    "gpt-5.4",
]


def _capability(*, available: bool, secret_configured: bool) -> ProviderCapability:
    return ProviderCapability(
        engine="chatgpt",
        available=available,
        requires_secret=True,
        secret_configured=secret_configured,
        reason=None,
        reasoning_effort_support="supported",
    )


def test_is_a_no_op_without_entitlement_data() -> None:
    assert entitled_chatgpt_models(_CATALOG) == _CATALOG


def test_preserves_catalog_order() -> None:
    assert entitled_chatgpt_models(_CATALOG)[0] == "gpt-5.6-sol"
    assert entitled_chatgpt_models(_CATALOG)[-1] == "gpt-5.4"


def test_a_signed_out_capability_still_receives_the_full_catalog() -> None:
    # Availability is not entitlement data. A signed-out account must still see the
    # catalog so the connect card can offer models before sign-in.
    capability = _capability(available=False, secret_configured=False)
    assert entitled_chatgpt_models(_CATALOG, capability=capability) == _CATALOG


def test_a_signed_in_capability_still_receives_the_full_catalog() -> None:
    capability = _capability(available=True, secret_configured=True)
    assert entitled_chatgpt_models(_CATALOG, capability=capability) == _CATALOG


def test_filters_to_the_supplied_allow_set() -> None:
    result = entitled_chatgpt_models(_CATALOG, entitlements=frozenset({"gpt-5.5"}))
    assert result == ["gpt-5.5"]


def test_filtering_preserves_catalog_order_not_entitlement_order() -> None:
    result = entitled_chatgpt_models(
        _CATALOG, entitlements=frozenset({"gpt-5.4", "gpt-5.6-sol"})
    )
    assert result == ["gpt-5.6-sol", "gpt-5.4"]


def test_falls_back_to_the_full_catalog_on_an_empty_intersection() -> None:
    # Fail open: a malformed or stale entitlement payload must never leave the user
    # with no selectable model.
    result = entitled_chatgpt_models(_CATALOG, entitlements=frozenset({"nope"}))
    assert result == _CATALOG


def test_ignores_non_string_and_blank_entitlement_entries() -> None:
    entitlements = frozenset({"gpt-5.5", "", "   "})
    assert entitled_chatgpt_models(_CATALOG, entitlements=entitlements) == ["gpt-5.5"]


def test_ignores_non_string_and_blank_catalog_entries() -> None:
    messy = ["gpt-5.5", "", "   ", "gpt-5.4"]
    assert entitled_chatgpt_models(messy) == ["gpt-5.5", "gpt-5.4"]


def test_an_empty_catalog_stays_empty() -> None:
    assert entitled_chatgpt_models([]) == []
    assert entitled_chatgpt_models([], entitlements=frozenset({"gpt-5.5"})) == []
