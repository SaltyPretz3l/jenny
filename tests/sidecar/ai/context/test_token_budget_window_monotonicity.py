"""A smaller context window may only compact earlier -- never overflow.

The ChatGPT model catalog was lowered from a claimed 372k to a conservative 272k
for the 5.6 family. That is only safe because every consumer treats the window as a
ceiling. This pins the direction mechanically, so the claim is a fact rather than a
review comment.
"""

from __future__ import annotations

import pytest

from sidecar.ai.context.token_budget import TokenBudget

_MAX_OUTPUT = 16_384


def _budget(context_window: int) -> TokenBudget:
    return TokenBudget(context_window=context_window, max_output_tokens=_MAX_OUTPUT)


@pytest.mark.parametrize("num_tools", [0, 8, 40])
def test_smaller_window_lowers_the_auto_compact_threshold(num_tools: int) -> None:
    wide = _budget(372_000).auto_compact_threshold(num_tools)
    narrow = _budget(272_000).auto_compact_threshold(num_tools)

    assert narrow < wide, "a narrower window must compact earlier, not later"
    assert narrow > 0, "the narrower window must still leave a usable budget"


@pytest.mark.parametrize("num_tools", [0, 8, 40])
def test_smaller_window_lowers_the_effective_context(num_tools: int) -> None:
    wide = _budget(372_000).effective_context(num_tools)
    narrow = _budget(272_000).effective_context(num_tools)

    assert narrow < wide
    assert narrow > 0


def test_effective_context_never_exceeds_the_window() -> None:
    # The overflow direction: whatever the reservations do, the budget can never
    # authorise more context than the model actually accepts.
    for window in (8_192, 128_000, 272_000, 372_000):
        assert _budget(window).effective_context(0) <= window


def test_thresholds_are_monotonic_in_the_window() -> None:
    windows = [8_192, 32_000, 128_000, 272_000, 372_000]
    thresholds = [_budget(window).auto_compact_threshold(0) for window in windows]

    assert thresholds == sorted(thresholds), (
        "auto-compact thresholds must increase with the window, so lowering a "
        f"catalog entry can only compact earlier: {list(zip(windows, thresholds))}"
    )
