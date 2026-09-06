from __future__ import annotations

from sidecar.ai.reasoning_parser import (
    extract_delimited_reasoning,
    strip_known_reasoning_blocks,
    strip_known_reasoning_markers,
)


def test_strip_known_reasoning_blocks_handles_reasoning_tags() -> None:
    text = "Visible before.<reasoning>hidden chain of thought</reasoning>Visible after."

    assert strip_known_reasoning_blocks(text) == "Visible before.Visible after."


def test_strip_known_reasoning_blocks_handles_pipe_thinking_tags() -> None:
    text = "<|thinking|>private notes<|/thinking|>public answer"

    assert strip_known_reasoning_blocks(text) == "public answer"


def test_strip_known_reasoning_markers_removes_alias_markers_without_content() -> None:
    text = "<thinking>keep me</thinking>"

    assert strip_known_reasoning_markers(text) == "keep me"


def test_extract_delimited_reasoning_supports_custom_reasoning_tags() -> None:
    result = extract_delimited_reasoning(
        "A<reasoning>B</reasoning>C",
        start_token="<reasoning>",
        end_token="</reasoning>",
    )

    assert result.reasoning_text == "B"
    assert result.visible_text == "AC"
    assert result.used_markers is True
