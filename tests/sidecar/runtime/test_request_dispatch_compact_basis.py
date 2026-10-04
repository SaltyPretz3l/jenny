"""W3-F11: manual ``chat.compact`` reports on the send path's basis.

The 1.2.0 gate (B5/2) pressed Compact now on a one-turn chat of nine ~10.6 KB
file reads. The request now carries the full tool output (Electron sends the
same prepared history as the next chat.send), so a single round can exceed the
manual threshold. That round is the latest one, which a summary keeps
verbatim, so there is nothing to fold: the result must say so with a reason the
UI can show, never "Compaction failed." after a pointless micro pass.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any

import pytest

import sidecar.runtime.request_dispatch_compact as rdc
from sidecar.ai.context.compaction import CompactionCircuitBreaker, CompactionResult
from sidecar.ai.context.token_budget import estimate_messages_tokens, resolve_tokenizer_backend
from sidecar.protocol import API_VERSION, CHAT_COMPACT_METHOD

LOGGER = logging.getLogger("test.request_dispatch_compact_basis")
SUMMARY_REPLY = "<analysis>a</analysis><summary>**Intent Summary** nine parts read</summary>"
PART_OUTPUT = "line of part text with a codeword somewhere in it. " * 210


class _Engine:
    def get_model_context_length(self) -> int:
        return 32_768

    def get_model_max_output_tokens(self) -> int:
        return 8_192


class _Router:
    def __init__(self) -> None:
        self.summary_calls = 0

    def _build_compaction_generate_fn(self, **_kwargs: Any) -> Any:
        def generate(_messages: Any) -> str:
            self.summary_calls += 1
            return SUMMARY_REPLY

        return generate


def _brain() -> SimpleNamespace:
    config = SimpleNamespace(
        engine_type="ollama",
        model="ornith",
        context_length=32_768,
        max_tokens=8_192,
        feature_flags={"compaction_manual": True},
        compaction_custom_prompt=None,
        token_budget_auto_compact_ratio=None,
        token_budget_auto_compact_ratio_by_model=None,
    )
    return SimpleNamespace(stack=SimpleNamespace(config=config, engine=_Engine(), router=_Router()))


def _read_round(index: int, output: str) -> list[dict[str, Any]]:
    call_id = f"call-{index}"
    return [
        {
            "role": "assistant",
            "content": f"Reading part {index}.",
            "tool_calls": [
                {
                    "id": call_id,
                    "type": "function",
                    "function": {"name": "read_file", "arguments": "{}"},
                }
            ],
        },
        {"role": "tool", "content": output, "tool_call_id": call_id, "name": "read_file"},
    ]


def _one_turn(parts: int, output: str = PART_OUTPUT) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = [{"role": "user", "content": "Read the nine files."}]
    for index in range(1, parts + 1):
        rows.extend(_read_round(index, output))
    rows.append({"role": "assistant", "content": "AMBER-FOX-41 ... IRIS-CRANE-07"})
    return rows


def _tokens(messages: list[dict[str, Any]]) -> int:
    """The manual path's own estimate: the budget tracker's config-aware backend."""
    return estimate_messages_tokens(messages, resolve_tokenizer_backend(_brain().stack.config))


def _run(messages: list[dict[str, Any]], brain: SimpleNamespace | None = None) -> Any:
    return rdc.process_compact_method(
        CHAT_COMPACT_METHOD,
        7,
        {"accept_version": API_VERSION, "session_id": "sess-f11", "messages": messages},
        True,
        brain or _brain(),
        LOGGER,
    )


@pytest.fixture(autouse=True)
def _fresh_breaker(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rdc, "_MANUAL_COMPACTION_BREAKER", CompactionCircuitBreaker())


def test_single_round_over_threshold_is_not_needed_with_reason() -> None:
    messages = _one_turn(9)
    brain = _brain()

    outcome = _run(messages, brain)

    result = outcome.response["result"]
    conversation_tokens = _tokens(messages)
    assert conversation_tokens > 20_000, "the fixture is the gate's ~24k-token turn"
    assert result["status"] == "ok"
    assert result["compacted"] is False
    assert result["strategy"] == "none"
    assert result["reason"] == "single_round"
    assert result["conversation_tokens"] == conversation_tokens
    assert result["tokens_before"] == result["tokens_after"] == conversation_tokens
    assert result["foldable_tokens"] == 0
    assert brain.stack.router.summary_calls == 0
    assert outcome.notifications == []


def test_single_round_below_threshold_reports_single_round() -> None:
    outcome = _run(_one_turn(1, "short output"))

    result = outcome.response["result"]
    assert result["compacted"] is False
    assert result["reason"] == "single_round"
    assert result["foldable_tokens"] == 0


def test_history_without_a_user_round_reports_no_user_round() -> None:
    outcome = _run([{"role": "assistant", "content": "orphan reply"}])

    result = outcome.response["result"]
    assert result["compacted"] is False
    assert result["reason"] == "no_user_round"


def test_two_turn_success_reports_conversation_and_foldable_tokens() -> None:
    first_turn = _one_turn(3)
    second_turn = [
        {"role": "user", "content": "Now read note-01."},
        *_read_round(10, "NOTE-01 body. " * 40),
        {"role": "assistant", "content": "IRIS-CRANE-07"},
    ]
    messages = [*first_turn, *second_turn]

    outcome = _run(messages)

    result = outcome.response["result"]
    assert result["status"] == "ok"
    assert result["compacted"] is True
    assert result["conversation_tokens"] == _tokens(messages)
    assert result["conversation_tokens"] == result["tokens_before"]
    assert result["foldable_tokens"] == _tokens(first_turn)
    assert result["tokens_after"] < result["tokens_before"] - 7_000
    assert "reason" not in result


def test_compact_context_uses_the_budget_trackers_backend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def _fake_compact(messages: Any, budget: Any, **kwargs: Any) -> CompactionResult:
        captured.update(kwargs)
        return CompactionResult(
            messages=list(messages), strategy="none", tokens_before=10, tokens_after=10
        )

    monkeypatch.setattr(rdc, "compact_context", _fake_compact)

    _run(_one_turn(1, "short"))

    assert captured.get("backend") is not None, "estimate with the tracker backend, like chat.send"
