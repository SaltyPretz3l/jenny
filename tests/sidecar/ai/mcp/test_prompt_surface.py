"""Bounded MCP prompt metadata and rendered text."""

from typing import Any

import pytest

from sidecar.ai.mcp.prompt_surface import (
    MAX_PROMPT_TEXT_CHARS,
    prompt_text_from_messages,
    prompts_digest,
    summarize_prompts,
)
from sidecar.ai.mcp.tool_surface import ToolSurfaceError


def test_summary_bounds_duplicates_and_sorting() -> None:
    rows, malformed = summarize_prompts([
        {"name": "z-last", "description": "d" * 2049, "arguments": [
            {"name": "feature", "description": "a" * 2049, "required": True}]},
        {"name": "a_first"},
        {"name": "z-last", "description": "discarded"},
        {"name": "Upper"}, {"name": "x" * 65}, {"name": "bad name"},
        {"name": "bad_args", "arguments": {}},
        {"name": "bad_arg", "arguments": [{"name": "Upper"}]},
        {"name": "too_many", "arguments": [{"name": f"arg{i}"} for i in range(17)]},
        {"name": "dup_args", "arguments": [{"name": "x"}, {"name": "x"}]},
    ])
    assert malformed == 7
    assert rows == [
        {"name": "a_first", "description": "", "arguments": []},
        {"name": "z-last", "description": "d" * 2048, "arguments": [
            {"name": "feature", "description": "a" * 2048, "required": True}]},
    ]
    accepted, count = summarize_prompts([{"name": "a" * 64, "arguments": [
        {"name": f"arg{i}"} for i in range(16)]}])
    assert count == 0
    assert len(accepted[0]["arguments"]) == 16
    assert accepted[0]["arguments"][0]["required"] is False


def test_prompt_count_bound() -> None:
    assert len(summarize_prompts([{"name": f"prompt{i}"} for i in range(32)])[0]) == 32
    with pytest.raises(ToolSurfaceError, match="too_many_prompts"):
        summarize_prompts([{"name": f"prompt{i}"} for i in range(33)])


def test_digest_is_stable_and_empty_is_empty() -> None:
    first = summarize_prompts([{"name": "b"}, {"name": "a"}])[0]
    second = summarize_prompts([{"name": "a"}, {"name": "b"}])[0]
    assert prompts_digest(first) == prompts_digest(second)
    assert len(prompts_digest(first)) == 64
    assert prompts_digest([]) == ""
    changed = summarize_prompts([{"name": "a", "arguments": [{"name": "feature"}]}])[0]
    assert prompts_digest(changed) != prompts_digest(first)


def test_text_joins_and_truncates() -> None:
    assert prompt_text_from_messages({"messages": [
        {"role": "user", "content": {"type": "text", "text": "first"}},
        {"role": "assistant", "content": {"type": "text", "text": "second"}},
    ]}) == "first\n\nsecond"
    assert prompt_text_from_messages({"messages": [
        {"content": {"type": "text", "text": "x" * (MAX_PROMPT_TEXT_CHARS + 1)}}
    ]}) == "x" * MAX_PROMPT_TEXT_CHARS


@pytest.mark.parametrize("kind", ["image", "audio", "resource", "unknown"])
def test_non_text_is_refused_even_after_text_limit(kind: str) -> None:
    with pytest.raises(ToolSurfaceError, match="prompt_content_unsupported"):
        prompt_text_from_messages({"messages": [
            {"content": {"type": "text", "text": "x" * MAX_PROMPT_TEXT_CHARS}},
            {"content": {"type": kind, "data": "secret-value"}},
        ]})


@pytest.mark.parametrize("result", [{}, {"messages": None}, {"messages": {}}, {"messages": [None]}, {"messages": [{"content": {"type": "text"}}]}])
def test_invalid_result_is_refused(result: Any) -> None:
    with pytest.raises(ToolSurfaceError, match="prompt_result_invalid"):
        prompt_text_from_messages(result)
