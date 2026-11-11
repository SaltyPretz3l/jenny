"""Managed NInfer keeps a cache anchor at the end of the conversation history.

NInfer does not do longest-common-prefix reuse: a request reuses only a
continuation of the previous one, or a marked shared prefix. Jenny's per-turn
``## Turn Context`` row sits before the latest user message and is gone from
the next turn's request, so without a mark a follow-up re-prefills everything
(measured 2026-11-08: 0 of 88,656 tokens, 25 s to first token).
"""

from __future__ import annotations

from typing import Any

import pytest

from sidecar.ai.context.turn_context import TURN_CONTEXT_HEADER
from sidecar.ai.engines.openai_compatible import OpenAICompatibleEngine

BREAKPOINT = {"mode": "explicit"}
ROW = {"role": "user", "content": f"{TURN_CONTEXT_HEADER}\n\n## Workspace\nsrc/"}


def _payload(messages: list[dict[str, Any]], provider_kind: str | None = "ninfer") -> dict[str, Any]:
    engine = OpenAICompatibleEngine()
    engine.model_name = "qwen3.8-27b-nvfp4"
    engine._ready = True
    context: dict[str, Any] = {}
    if provider_kind is not None:
        context["inference_performance"] = {"live": False, "provider_kind": provider_kind}
    engine._current_request_context = lambda: context  # type: ignore[method-assign]
    return engine._build_payload(
        prompt="",
        max_tokens=64,
        temperature=0.0,
        reasoning_effort=None,
        prompt_cache_enabled=False,
        system="",
        messages=messages,  # type: ignore[arg-type]
        response_format=None,
    )


def _marks(payload: dict[str, Any]) -> list[int]:
    return [
        index
        for index, message in enumerate(payload["messages"])
        if isinstance(message.get("content"), list)
        and any(
            isinstance(part, dict) and part.get("prompt_cache_breakpoint") == BREAKPOINT
            for part in message["content"]
        )
    ]


def _follow_up() -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": "You are Jenny."},
        {"role": "user", "content": "first question"},
        {"role": "assistant", "content": "first answer"},
        dict(ROW),
        {"role": "user", "content": "second question"},
    ]


def test_marks_the_last_history_row_before_the_turn_context() -> None:
    payload = _payload(_follow_up())

    assert _marks(payload) == [2]
    assert payload["messages"][2]["content"] == [
        {"type": "text", "text": "first answer", "prompt_cache_breakpoint": BREAKPOINT}
    ]


def test_every_other_row_keeps_its_exact_text() -> None:
    messages = _follow_up()
    payload = _payload(messages)

    for index in (0, 1, 3, 4):
        assert payload["messages"][index]["content"] == messages[index]["content"]


@pytest.mark.parametrize("provider_kind", ["llama-server", "ollama", "other", None])
def test_other_providers_are_left_alone(provider_kind: str | None) -> None:
    assert _marks(_payload(_follow_up(), provider_kind=provider_kind)) == []


def test_kill_switch_leaves_the_payload_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JENNY_ENABLE_NINFER_CACHE_BREAKPOINT", "0")

    assert _marks(_payload(_follow_up())) == []


def test_without_a_turn_context_row_the_latest_user_message_is_the_boundary() -> None:
    messages = [m for m in _follow_up() if m is not None and not str(m["content"]).startswith(TURN_CONTEXT_HEADER)]

    assert _marks(_payload(messages)) == [2]


def test_a_tool_loop_iteration_keeps_the_same_anchor() -> None:
    messages = [
        *_follow_up(),
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "c1", "function": {"name": "read_file", "arguments": "{}"}}],
        },
        {"role": "tool", "tool_call_id": "c1", "content": "file body"},
    ]

    assert _marks(_payload(messages)) == [2]


def test_walks_back_past_rows_that_cannot_carry_a_mark() -> None:
    messages = [
        {"role": "system", "content": "You are Jenny."},
        {"role": "user", "content": "earlier question"},
        {"role": "assistant", "content": "earlier answer"},
        {"role": "user", "content": "run it"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "c1", "function": {"name": "read_file", "arguments": "{}"}}],
        },
        {"role": "tool", "tool_call_id": "c1", "content": "file body"},
        dict(ROW),
        {"role": "user", "content": "next question"},
    ]

    assert _marks(_payload(messages)) == [3]


def test_a_first_turn_marks_the_prompt_block() -> None:
    messages = [
        {"role": "system", "content": "You are Jenny."},
        dict(ROW),
        {"role": "user", "content": "first question"},
    ]

    assert _marks(_payload(messages)) == [0]


def test_only_one_row_is_marked() -> None:
    assert len(_marks(_payload(_follow_up()))) == 1


def test_a_vision_turn_marks_only_a_text_row() -> None:
    messages = [
        *_follow_up()[:3],
        {"role": "assistant", "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}}]},
        dict(ROW),
        {"role": "user", "content": "second question"},
    ]

    assert _marks(_payload(messages)) == [2]
