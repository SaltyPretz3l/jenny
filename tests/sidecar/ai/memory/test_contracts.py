from __future__ import annotations

import math

import pytest

from sidecar.ai.memory.contracts import (
    MAX_LESSON_TEXT_CHARS,
    build_content_digest,
    is_content_digest,
    normalize_positive_limit,
    require_bounded_text,
    require_finite_confidence,
)


def test_content_digest_is_stable_normalized_and_non_plaintext() -> None:
    first = build_content_digest(" Preference ", "The user   prefers tea")
    second = build_content_digest("preference", "the user prefers tea.")

    assert first == second
    assert is_content_digest(first)
    assert "prefers-tea" not in first


@pytest.mark.parametrize("value", [True, False, math.nan, math.inf, -math.inf, "0.8"])
def test_confidence_rejects_boolean_non_finite_and_non_numeric(value: object) -> None:
    with pytest.raises(ValueError, match="finite number"):
        require_finite_confidence(value)


def test_text_and_list_bounds_fail_closed() -> None:
    with pytest.raises(ValueError, match="exceeds"):
        require_bounded_text(
            "x" * (MAX_LESSON_TEXT_CHARS + 1),
            field="lesson_text",
            max_chars=MAX_LESSON_TEXT_CHARS,
        )
    with pytest.raises(ValueError, match="integer"):
        normalize_positive_limit(True, default=10, maximum=20)
