from __future__ import annotations

import pytest

from sidecar.ai.routing.thinking_checkpoint import (
    build_checkpoint_messages,
    build_reasoning_summary_messages,
    checkpoint_no_progress,
    max_thinking_budget_checkpoints,
)


@pytest.mark.parametrize(
    ("context_window", "expected"),
    [(None, 3), (32_768, 3), (65_536, 4), (131_072, 8), (262_144, 8)],
)
def test_checkpoint_limit_scales_with_context(
    context_window: int | None, expected: int
) -> None:
    assert max_thinking_budget_checkpoints(context_window) == expected


def test_checkpoint_carry_embeds_summary_and_raw_tail() -> None:
    messages = build_checkpoint_messages(
        "earlier reasoningTAIL", summarize=lambda _text: "note", carry_chars=4
    )

    assert messages[0] == {
        "role": "assistant",
        "content": (
            "(my reasoning so far, continued after a thinking-budget checkpoint)\n"
            "[progress note from earlier reasoning]\nnote\nTAIL"
        ),
    }


def test_checkpoint_carry_falls_back_when_summary_raises() -> None:
    def raise_summary(_text: str) -> str:
        raise RuntimeError("summary failed")

    messages = build_checkpoint_messages(
        "earlier reasoningTAIL", summarize=raise_summary, carry_chars=4
    )

    assert messages[0] == {
        "role": "assistant",
        "content": (
            "(my reasoning so far, continued after a thinking-budget checkpoint)\n"
            "[... earlier reasoning elided at a thinking-budget checkpoint ...]\nTAIL"
        ),
    }


def test_checkpoint_without_summarizer_preserves_legacy_output() -> None:
    reasoning = "x" * 20_000

    assert build_checkpoint_messages(reasoning, summarize=None) == [
        {
            "role": "assistant",
            "content": (
                "(my reasoning so far, continued after a thinking-budget checkpoint)\n"
                "[... earlier reasoning elided at a thinking-budget checkpoint ...]\n"
                + ("x" * 12_000)
            ),
        },
        {
            "role": "system",
            "content": (
                "You hit a thinking-budget checkpoint. Your reasoning so far is preserved "
                "above. Act now - emit your tool calls or your final answer. Be decisive; "
                "do not restart your analysis."
            ),
        },
    ]


def test_reasoning_summary_prompt_bounds_elided_text() -> None:
    messages = build_reasoning_summary_messages("a" * 20_000)

    assert messages == [
        {
            "role": "system",
            "content": (
                "Summarise reasoning-in-progress into a compact progress note: decisions "
                "made, facts established, dead ends, remaining steps. Plain prose, at most "
                "300 words, no preamble."
            ),
        },
        {"role": "user", "content": "a" * 20_000},
    ]


def test_reasoning_summary_keeps_the_head_and_tail_of_long_elided_text() -> None:
    # 2026-11-11: a 190k-char first leg was summarised from its last 24k only,
    # so the note lost the design decisions made at the start.
    elided = "H" * 50_000 + "m" * 100_000 + "T" * 50_000
    content = str(build_reasoning_summary_messages(elided)[1]["content"])

    head, marker, tail = content.partition(" [... ")
    assert head == "H" * 6_000
    assert marker
    assert "176,000 chars of reasoning omitted ...]" in tail
    assert tail.endswith("T" * 18_000)
    assert len(content) < 24_100


def test_checkpoint_no_progress_compares_bounded_carries() -> None:
    assert checkpoint_no_progress(None, "x") is False
    assert checkpoint_no_progress(
        "same detailed reasoning remains", "same detailed reasoning remains"
    ) is True
    assert checkpoint_no_progress("alpha beta", "quartz zephyr") is False
