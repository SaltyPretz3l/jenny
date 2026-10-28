from __future__ import annotations

from collections.abc import Iterator

import pytest

from sidecar.ai.engines.provider_http import _sanitize_error_body
from sidecar.runtime import exact_secret_redaction as registry
from sidecar.runtime.diagnostics import sanitize_diagnostic_text, sanitize_diagnostic_value

# A key with no known secret shape: only the exact-value registry catches it.
SHAPELESS_KEY = "q7Wm2ZpX9vL4tR8nB3cD6fH1jK5"


@pytest.fixture(autouse=True)
def _clean_registry() -> Iterator[None]:
    registry.clear_exact_secrets_for_tests()
    yield
    registry.clear_exact_secrets_for_tests()


def test_an_unregistered_shapeless_key_passes_the_shape_redactors() -> None:
    assert SHAPELESS_KEY in sanitize_diagnostic_text(f"provider said {SHAPELESS_KEY}")


def test_a_registered_key_is_redacted_in_logs_values_and_provider_error_bodies() -> None:
    assert registry.register_exact_secret(SHAPELESS_KEY) is True
    assert SHAPELESS_KEY not in sanitize_diagnostic_text(f"provider said {SHAPELESS_KEY}")
    assert SHAPELESS_KEY not in str(sanitize_diagnostic_value({"detail": f"x {SHAPELESS_KEY} y"}))
    assert SHAPELESS_KEY not in str(_sanitize_error_body({"error": {"message": f"bad key {SHAPELESS_KEY}"}}))


def test_short_or_non_string_values_are_not_registered() -> None:
    assert registry.register_exact_secret("short") is False
    assert registry.register_exact_secret(None) is False
    assert registry.register_exact_secret(12345678901234) is False
    assert registry.registered_exact_secret_count() == 0


def test_the_registry_is_bounded_oldest_first() -> None:
    keys = [f"key-{index:04d}-abcdefghijkl" for index in range(registry.MAX_EXACT_SECRETS + 3)]
    for key in keys:
        registry.register_exact_secret(key)
    assert registry.registered_exact_secret_count() == registry.MAX_EXACT_SECRETS
    assert registry.redact_exact_secrets(keys[0]) == keys[0]
    assert registry.redact_exact_secrets(keys[-1]) == registry.REDACTED_EXACT_SECRET


def test_a_longer_key_containing_a_shorter_one_is_redacted_whole() -> None:
    registry.register_exact_secret("abcdefghijklmnop")
    registry.register_exact_secret("abcdefghijklmnop-extended")
    assert registry.redact_exact_secrets("x abcdefghijklmnop-extended y") == f"x {registry.REDACTED_EXACT_SECRET} y"
