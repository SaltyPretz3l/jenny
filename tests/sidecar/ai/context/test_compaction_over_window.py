"""HB-028: a resumed chat far over the window compacts once, with a summary.

Dogfood evidence (Bonsai 2 27B on managed llama-server, 64k window, packaged
chars//4 estimator): every resumed turn in a ~330-message chat sent the
summariser 70-78k real tokens ("request (77595 tokens) exceeds the available
context size (65536 tokens)"), fell back to a summary-less microcompaction
that stopped just under the auto-compact trigger, and compacted again after
one tool call.
"""

from __future__ import annotations

import json
import math
from typing import Any

from sidecar.ai.context.compaction import (
    COMPACTED_SUMMARY_HEADING,
    CompactionCircuitBreaker,
    compact_context,
)
from sidecar.ai.context.compaction_window import admit_summary_source, summary_input_limit
from sidecar.ai.context.token_budget import (
    CharEstimationBackend,
    TokenBudget,
    estimate_messages_tokens,
)
from sidecar.ai.exceptions import GenerationError

_WINDOW = 65_536
_NUM_TOOLS = 8
_SUMMARY_MAX_TOKENS = 8_192
# The engine tokenizer counts digit-heavy CSV/code denser than chars//4:
# HB-028's rejected requests ran up to ~1.37x the estimate.
_ENGINE_CHARS_PER_TOKEN = 2.9

_CANNED_SUMMARY = "<summary>\n" + "\n".join(
    f"{index}. **{name}** — kept."
    for index, name in enumerate(
        (
            "Intent Summary",
            "Key Technical Concepts",
            "Relevant Files & Code",
            "Errors & Debugging",
            "Problem-Solving Approaches",
            "User Messages",
            "Pending Tasks",
            "Current Work",
            "Next Step",
        ),
        start=1,
    )
) + "\n</summary>"


def _dogfood_budget() -> TokenBudget:
    return TokenBudget(
        context_window=_WINDOW,
        max_output_tokens=16_384,
        tool_overhead_per_tool=200,
    )


def _engine_tokens(messages: list[dict[str, Any]]) -> int:
    """What llama-server would count for the summariser request."""
    return sum(
        math.ceil(len(str(message.get("content") or "")) / _ENGINE_CHARS_PER_TOKEN) + 4
        for message in messages
    )


class _WindowCheckedSummariser:
    """A generate_fn that rejects requests the engine window cannot hold."""

    def __init__(self) -> None:
        self.requests: list[int] = []

    def __call__(self, messages: list[dict[str, Any]]) -> str:
        real = _engine_tokens(messages)
        self.requests.append(real)
        if real + _SUMMARY_MAX_TOKENS > _WINDOW:
            raise GenerationError("Managed llama-server streaming request failed with status 400")
        return _CANNED_SUMMARY


def _digits(length: int, seed: int) -> str:
    row = f"{seed:05d},2026-09-{seed % 28 + 1:02d},-1234.56,ACH DEBIT {seed * 7919:08d}\n"
    return (row * (length // len(row) + 1))[:length]


def _round(index: int, *, user_chars: int, tool_chars: int, reply_chars: int) -> list[dict[str, Any]]:
    call_id = f"call_{index}"
    return [
        {"role": "user", "content": f"Step {index}: " + _digits(user_chars, index)},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": "run_command",
                        "arguments": json.dumps({"command": f"python recon.py --case {index}"}),
                    },
                }
            ],
        },
        {"role": "tool", "tool_call_id": call_id, "content": _digits(tool_chars, index + 1)},
        {"role": "assistant", "content": _digits(reply_chars, index + 2)},
    ]


def _resumed_history(rounds: int, **sizes: int) -> list[dict[str, Any]]:
    history: list[dict[str, Any]] = [{"role": "system", "content": "Primary prompt. " * 120}]
    for index in range(rounds):
        history.extend(_round(index, **sizes))
    history.append({"role": "user", "content": "Continue with the G5 holdout fix."})
    return history


def test_over_window_resume_gets_one_full_compaction_with_a_summary() -> None:
    budget = _dogfood_budget()
    backend = CharEstimationBackend()
    history = _resumed_history(120, user_chars=400, tool_chars=4_000, reply_chars=1_200)
    assert estimate_messages_tokens(history, backend) > 2 * _WINDOW
    summariser = _WindowCheckedSummariser()

    result = compact_context(
        history,
        budget,
        backend,
        generate_fn=summariser,
        num_tools=_NUM_TOOLS,
        circuit_breaker=CompactionCircuitBreaker(),
    )

    assert summariser.requests, "the summariser was never called"
    assert all(real + _SUMMARY_MAX_TOKENS <= _WINDOW for real in summariser.requests), (
        f"summariser requests overflowed the {_WINDOW}-token window: {summariser.requests}"
    )
    assert (result.strategy, result.summary_status) == ("full", "created"), (
        result.strategy,
        result.summary_status,
        result.summary_failure_code,
    )
    assert result.summary_input_truncated is True
    # Far below the trigger the tool loop re-checks after every tool round.
    assert result.tokens_after <= budget.auto_compact_threshold(_NUM_TOOLS) // 2


def test_micro_fallback_leaves_room_for_a_tool_round_below_the_mid_turn_trigger() -> None:
    budget = _dogfood_budget()
    backend = CharEstimationBackend()
    history = _resumed_history(60, user_chars=200, tool_chars=8_000, reply_chars=200)

    def engine_down(_messages: list[dict[str, Any]]) -> str:
        raise GenerationError("Managed llama-server streaming request failed with status 400")

    result = compact_context(
        history,
        budget,
        backend,
        generate_fn=engine_down,
        num_tools=_NUM_TOOLS,
        circuit_breaker=CompactionCircuitBreaker(),
    )

    assert result.strategy == "micro"
    assert (result.summary_status, result.summary_failure_code) == (
        "failed",
        "summary_generation_failed",
    )
    assert result.error is None
    trigger = budget.auto_compact_threshold(_NUM_TOOLS)
    # One reasoning block and one run_command result, as in the dogfood turn.
    next_round = [
        {"role": "assistant", "content": _digits(2_000, 7)},
        *_round(999, user_chars=0, tool_chars=4_000, reply_chars=0)[1:3],
    ]
    grown = estimate_messages_tokens([*result.messages, *next_round], backend)
    # tool_loop_compaction.compact_tool_loop_context compacts again above this.
    assert grown <= trigger, (
        f"micro fallback landed at {result.tokens_after}; one tool round later the "
        f"history is {grown}, over the {trigger}-token mid-turn trigger"
    )


class _TokenizerStub:
    """A tokenizer backend that reports whether it matches the model exactly."""

    def __init__(self, *, exact: bool) -> None:
        self.is_exact_match = exact

    def count_tokens(self, text: str) -> int:
        return len(text) // 4


def test_summary_input_limit_keeps_the_full_window_only_for_an_exact_tokenizer() -> None:
    budget = _dogfood_budget()

    exact = summary_input_limit(budget, prompt_tokens=1_000, backend=_TokenizerStub(exact=True))
    # An approximate (cross-family tiktoken) count undershoots like chars//4.
    approximate = summary_input_limit(
        budget, prompt_tokens=1_000, backend=_TokenizerStub(exact=False)
    )
    heuristic = summary_input_limit(
        budget, prompt_tokens=1_000, backend=CharEstimationBackend()
    )

    assert exact == _WINDOW - budget.reserved_for_summary - 1_000 - 512
    assert approximate == heuristic < exact


def test_forced_compaction_without_a_summariser_trims_under_the_fallback_target() -> None:
    budget = _dogfood_budget()
    backend = CharEstimationBackend()
    trigger = budget.auto_compact_threshold(_NUM_TOOLS)
    history = _resumed_history(16, user_chars=200, tool_chars=8_000, reply_chars=200)
    before = estimate_messages_tokens(history, backend)
    assert trigger * 2 // 3 < before <= trigger

    result = compact_context(
        history,
        budget,
        backend,
        num_tools=_NUM_TOOLS,
        force=True,
        circuit_breaker=CompactionCircuitBreaker(),
    )

    assert result.strategy == "micro"
    assert result.tokens_after <= trigger * 2 // 3


def test_a_prior_summary_larger_than_half_the_limit_is_not_pinned() -> None:
    budget = _dogfood_budget()
    backend = CharEstimationBackend()
    limit = summary_input_limit(budget, prompt_tokens=0, backend=backend)
    prior = {"role": "system", "content": f"{COMPACTED_SUMMARY_HEADING} " + "x" * (limit * 3)}
    rows = [prior, *({"role": "assistant", "content": "y" * 4_000} for _ in range(40))]

    admission = admit_summary_source(rows, budget, backend, prompt_tokens=0, pin_first=True)

    assert admission.dropped_messages >= 1
    assert prior not in admission.messages


def test_over_window_resume_refolds_the_prior_summary_instead_of_dropping_it() -> None:
    budget = _dogfood_budget()
    backend = CharEstimationBackend()
    history = _resumed_history(120, user_chars=400, tool_chars=4_000, reply_chars=1_200)
    prior = {
        "role": "system",
        "content": f"{COMPACTED_SUMMARY_HEADING}\n\nPrior facts: reconcile account 4411.",
    }
    history.insert(1, prior)
    seen: list[str] = []

    def summariser(messages: list[dict[str, Any]]) -> str:
        seen.extend(str(message.get("content") or "") for message in messages)
        return _CANNED_SUMMARY

    result = compact_context(
        history,
        budget,
        backend,
        generate_fn=summariser,
        num_tools=_NUM_TOOLS,
        circuit_breaker=CompactionCircuitBreaker(),
    )

    assert result.summary_input_truncated is True
    assert any("Prior facts: reconcile account 4411." in text for text in seen), (
        "the oldest-first drop discarded the prior compaction summary"
    )
