"""Compaction replay: recorded prompt growth through the real budget and compaction code (row 183 W4).

The gate for the compaction parity plan (docs/plans/COMPACTION_PARITY_2026-11-20.md). It builds the
budget the way a turn does for the Anthropic API route (the real engine class, built offline), then
drives `compact_tool_loop_context` request by request with a stub summarizer.

- The recorded run is the owner's 2026-11-20 chat: 350k window, 44 tools, three mid-turn compactions.
- The synthetic run is a long 200k turn.

Expected failures were strict xfails naming the wave that repaid them (W1-W3 have landed).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.context.compaction_breaker import CompactionCircuitBreaker
from sidecar.ai.context.context_count import normalize_context_calibration, resolve_token_scale
from sidecar.ai.context.token_budget import (
    CharEstimationBackend,
    apply_budget_check,
    estimate_messages_tokens,
)
from sidecar.ai.engines.api_provider_anthropic import ApiProviderAnthropicEngine
from sidecar.ai.routing.tool_loop_compaction import (
    compact_tool_loop_context,
    note_request_measurement,
)

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "compaction_replay_2026_11_20.json").read_text("utf-8")
)
PROVIDER_ID = "claude-console"
MODEL = f"api-provider/{PROVIDER_ID}/claude-test-5"
NUM_TOOLS = int(FIXTURE["num_tools"])
# Fitted to the owner's two recorded sessions (a max output pinned at 128,000 and ~40k estimated tokens
# of tool schemas): today's code then gives 241,252 against the recorded ~242k trigger at 350k, and a
# 120,640 meter threshold against the recorded 120,668 at 256k.
TOOL_SCHEMA_TOKENS = 40_000
PINNED_MAX_OUTPUT = 128_000
# Provider tokens per estimated message token on this route (Claude's tokenizer against chars/4),
# and the calibration ratio the 2026-11-20 session carried (provider 144,747 / estimate 82,529).
PROVIDER_PER_ESTIMATE = 2.0
CALIBRATION_RATIO = 1.75
TASK = "Proceed with execution of the fog plan."
_SUMMARY = "<summary>\n" + "".join(
    f"## {index}. {title}\n{'Keep going.' if index == 9 else 'none'}\n"
    for index, title in enumerate(
        ("Intent Summary", "Key Technical Concepts", "Relevant Files & Code", "Errors & Debugging",
         "Problem-Solving Approaches", "User Messages", "Pending Tasks", "Current Work", "Next Step"),
        start=1,
    )
) + "</summary>"


def target_trigger(window: int) -> int:
    """Section 2 of the plan (owner D1): ~90% of the window, never past the reply floor."""
    return min(int(0.9 * window), window - min(20_480, window // 4))


def _engine(window: int) -> ApiProviderAnthropicEngine:
    sources = {key: "preset" for key in ("context_length", "tools", "vision", "reasoning")}
    sources["max_output_tokens"] = "pin"
    engine = ApiProviderAnthropicEngine(
        descriptor={
            "descriptor_schema_version": 6, "provider_id": PROVIDER_ID, "label": "Claude Console",
            "endpoint": "https://api.anthropic.com/v1", "transport": "anthropic_messages_v1",
            "auth_profile": "api_key_header",
        },
        api_key="sk-ant-test-0123456789abcdefXYZ",
        limits={"context_length": window, "max_output_tokens": min(PINNED_MAX_OUTPUT, window),  # Electron clamps it to the window
                "tools": True,
                "vision": False, "reasoning": True, "sources": sources},
        resolve_local=lambda *_args: False,
    )
    engine.load_model(MODEL)
    return engine


def _config() -> Any:
    return parse_runtime_config({"engine_type": "api-provider", "model": MODEL})


def _calibration(config: Any) -> Any:
    return normalize_context_calibration({
        "provider_tokens": int(100_000 * CALIBRATION_RATIO), "estimate_tokens": 100_000,
        "engine": config.engine_type, "model": config.model, "estimator": "CharEstimationBackend",
    })


def _turn_tracker(engine: Any, config: Any, messages: list[dict[str, Any]], *, prefix: int) -> Any:
    """The tracker a turn builds: the count-source ladder, then the budget."""
    if callable(getattr(type(engine), "count_request_tokens", None)):
        # W2's exact count, answered offline with the replay's own provider figure.
        engine.count_request_tokens = lambda messages, tools: _provider(messages, prefix)
    scale, source = resolve_token_scale(
        engine=engine, config=config, messages=messages, tool_payload=[],
        calibration=_calibration(config),
    )
    _messages, _budget, tracker = apply_budget_check(
        messages, config, engine, num_tools=NUM_TOOLS, tool_schema_tokens=TOOL_SCHEMA_TOKENS,
        token_scale=scale, scale_source=source,
    )
    return tracker


def _provider(messages: list[dict[str, Any]], prefix: int) -> int:
    return prefix + int(PROVIDER_PER_ESTIMATE * estimate_messages_tokens(messages, CharEstimationBackend()))


def _pair(index: int, estimate_tokens: int) -> list[dict[str, Any]]:
    call_id = f"call_{index}"
    return [
        {"role": "assistant", "content": "",
         "tool_calls": [{"id": call_id, "name": "read_file", "arguments": {"path": f"src/f{index}.rs"}}]},
        {"role": "tool", "tool_call_id": call_id, "name": "read_file",
         "content": "x" * max(40, estimate_tokens * 4)},
    ]


def _history(provider_tokens: int, prefix: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = [{"role": "user", "content": TASK}]
    index = 0
    while _provider(rows, prefix) < provider_tokens:
        rows += _pair(index, 2_000)
        index += 1
    return rows


def _loop(tracker: Any, config: Any, engine: Any, messages: list[dict[str, Any]]) -> Any:
    runtime = MagicMock()
    runtime._preview_context_tokens.return_value = 0
    kernel = SimpleNamespace(
        _config=config, _engine=engine,
        _compaction_breakers=SimpleNamespace(for_key=lambda _key: CompactionCircuitBreaker()),
        _build_compaction_generate_fn=lambda **_kwargs: (lambda _messages: _SUMMARY),
    )
    return SimpleNamespace(
        budget_tracker=tracker, runtime=runtime, working_messages=messages,
        feature_flags={"context_compaction": True}, compaction_stalled=False,
        request_id="replay", session_id="replay", system_prompt="system", latest_user_content=TASK,
        prompt_cache_enabled=True, kernel=kernel, request_context=None, request_measurement=None,
        cache_break_detector=None,
    )


@dataclass
class Replay:
    window: int
    trigger: int
    compactions: int = 0
    after: list[int] = field(default_factory=list)  # provider tokens right after each compaction
    gaps: list[int] = field(default_factory=list)  # requests between compactions
    peak: int = 0
    first_fire_at: int | None = None  # provider tokens on the request that first compacted
    task_kept: bool = True
    uncached_resent: int = 0


def replay(window: int, start: int, deltas: list[int], *, prefix: int) -> Replay:
    """Drive one turn: each request is measured, its tool result appended, then the loop's check."""
    engine, config = _engine(window), _config()
    messages = _history(start, prefix)
    tracker = _turn_tracker(engine, config, messages, prefix=prefix)
    loop = _loop(tracker, config, engine, messages)
    result = Replay(window=window, trigger=tracker.provider_compact_threshold(NUM_TOOLS))
    since = 0
    for index, delta in enumerate(deltas):
        sent = _provider(loop.working_messages, prefix)
        result.peak = max(result.peak, sent)
        note_request_measurement(loop, SimpleNamespace(last_request_input_tokens=sent))
        loop.working_messages.extend(_pair(10_000 + index, int(delta / PROVIDER_PER_ESTIMATE)))
        before = list(loop.working_messages)
        compact_tool_loop_context(loop, num_tools=NUM_TOOLS)
        since += 1
        if len(loop.working_messages) != len(before) or any(
            a is not b for a, b in zip(before, loop.working_messages, strict=False)
        ):
            now = _provider(loop.working_messages, prefix)
            result.compactions += 1
            result.after.append(now)
            result.gaps.append(since)
            result.uncached_resent += now - prefix
            if result.first_fire_at is None:
                result.first_fire_at = _provider(before, prefix)
            since = 0
            result.task_kept &= any(TASK in str(row.get("content", "")) for row in loop.working_messages)
    return result


def _recorded() -> Replay:
    return replay(
        int(FIXTURE["context_window"]), int(FIXTURE["start_prompt_tokens"]),
        list(FIXTURE["growth_deltas"]), prefix=int(FIXTURE["stable_prefix_tokens"]),
    )


# -- the trigger (W1) ------------------------------------------------------------------------------


@pytest.mark.parametrize("window", [350_000, 200_000, 65_536, 32_768])
def test_the_provider_trigger_is_ninety_percent_with_the_reply_floor(window: int) -> None:
    engine, config = _engine(window), _config()
    tracker = _turn_tracker(engine, config, _history(20_000, 0), prefix=0)
    assert tracker.provider_compact_threshold(NUM_TOOLS) == pytest.approx(target_trigger(window), rel=0.005)


def test_target_triggers_match_the_plan_table() -> None:
    assert [target_trigger(w) for w in (350_000, 262_144, 200_000, 65_536, 32_768)] == [
        315_000, 235_929, 179_520, 49_152, 24_576,
    ]


# -- the count source at turn start (W2) ------------------------------------------------------------


def test_the_anthropic_calibration_is_trusted_at_turn_start() -> None:
    engine, config = _engine(350_000), _config()
    scale, source = resolve_token_scale(
        engine=engine, config=config, messages=[{"role": "user", "content": TASK}],
        tool_payload=[], calibration=_calibration(config),
    )
    assert source in ("calibrated", "exact")
    assert scale == pytest.approx(CALIBRATION_RATIO, rel=0.01) or source == "exact"


# -- the recorded turn (W1) -------------------------------------------------------------------------


def test_the_recorded_turn_never_compacts() -> None:
    # It peaks near 307k under a 315k trigger; the live chat compacted three times at ~242k.
    run = _recorded()
    assert run.compactions == 0, run
    assert run.peak < run.window - 20_480, run


# -- a long synthetic turn (W1, W3) ---------------------------------------------------------------


def _long_turn() -> Replay:
    return replay(200_000, 60_000, [4_000] * 120, prefix=20_000)


def test_a_long_turn_first_compacts_near_the_target() -> None:
    run = _long_turn()
    assert run.first_fire_at is not None, run
    assert run.first_fire_at >= target_trigger(200_000) * 0.97, run


def test_a_long_turn_stays_inside_the_window_spaces_its_passes_and_keeps_the_task() -> None:
    run = _long_turn()
    assert run.compactions >= 2, run
    # With about a third of the trigger freed at 4k per request, passes sit well apart.
    assert min(run.gaps[1:]) >= int(run.trigger / 3 / 4_000 * 0.8), run
    assert run.peak < run.window, run
    assert run.task_kept, run


def test_every_forced_pass_lands_at_two_thirds_of_the_provider_trigger() -> None:
    # W3: the fixed part of the prompt comes out of a forced pass's target.
    run = _long_turn()
    assert run.compactions >= 2, run
    assert all(after <= run.trigger * 2 / 3 for after in run.after), run


def test_a_long_turn_runs_at_most_one_micro_pass_before_the_summary() -> None:
    # D3: 120 requests of 4k on a 200k window compacted 5 times with three micro passes.
    run = _long_turn()
    assert run.compactions <= 3, run
