"""Trailing per-turn context row: primitives, builder split, folding, demotion, compaction."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from sidecar.ai.context import turn_context as tc
from sidecar.ai.context.builder import ContextBuilder, RuntimeToolStatus
from sidecar.ai.context.compaction import compact_context
from sidecar.ai.context.prompt_cache import StructuredSystemPrompt
from sidecar.ai.context.runtime_message_markers import (
    CONTEXT_PRESSURE_ADVISORY_HEADING,
    MEMORY_RECALL_HEADING,
    PLAN_MODE_OVERLAY_HEADING,
)
from sidecar.ai.context.token_budget import TokenBudget
from sidecar.runtime.local_engine.messages import demote_non_leading_system_messages

_STATUSES = [
    RuntimeToolStatus(
        name="worktree_list", display_name="Worktree List", available=True, tool_family="git"
    )
]
_ASK = "Use the git worktree tool worktree_list."


@pytest.fixture
def flag_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(tc.TRAILING_TURN_CONTEXT_FLAG, "1")


def _config(engine_type: str = "openai-compatible") -> SimpleNamespace:
    return SimpleNamespace(engine_type=engine_type)


def test_flag_is_on_by_default_for_local_engines(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(tc.TRAILING_TURN_CONTEXT_FLAG, raising=False)

    assert tc.trailing_turn_context_enabled(_config()) is True
    assert tc.trailing_turn_context_enabled(_config("anthropic")) is False
    blocks = ({"kind": "active_file", "content": "x"},)
    assert tc.split_context_blocks(_config(), blocks) == ((), blocks)


def test_kill_switch_restores_the_leading_layout(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(tc.TRAILING_TURN_CONTEXT_FLAG, "0")

    assert tc.trailing_turn_context_enabled(_config()) is False
    blocks = ({"kind": "active_file", "content": "x"},)
    assert tc.split_context_blocks(_config(), blocks) == (blocks, ())


@pytest.mark.usefixtures("flag_on")
def test_flag_applies_to_local_template_engines_only() -> None:
    assert tc.trailing_turn_context_enabled(_config("openai-compatible")) is True
    assert tc.trailing_turn_context_enabled(_config("ollama")) is True
    assert tc.trailing_turn_context_enabled(_config("anthropic")) is False


@pytest.mark.usefixtures("flag_on")
def test_only_personality_blocks_stay_leading() -> None:
    personality = {"kind": "personality", "content": "Warm."}
    active_file = {"kind": "active_file", "content": "main.py"}

    leading, trailing = tc.split_context_blocks(_config(), (personality, active_file))

    assert leading == (personality,)
    assert trailing == (active_file,)


def test_row_is_placed_before_the_latest_user_message() -> None:
    row = tc.build_turn_context_row(["## Workspace Manifest\nsrc/"])
    history = [
        {"role": "system", "content": "prompt"},
        {"role": "user", "content": "one"},
        {"role": "assistant", "content": "ok"},
        {"role": "user", "content": "two"},
    ]

    placed = tc.place_turn_context_row(history, row)

    assert [m["content"] for m in placed][-2:] == [row["content"], "two"]  # type: ignore[index]
    assert tc.is_turn_context_row(placed[-2])
    rest, taken = tc.take_turn_context_row(placed)
    assert rest == history
    assert taken == row


def test_empty_row_holds_the_slot_for_late_overlays() -> None:
    builder = ContextBuilder(None)
    row = tc.build_turn_context_row(["", "  "])
    messages = tc.place_turn_context_row(
        [{"role": "system", "content": "prompt"}, {"role": "user", "content": "hi"}], row
    )

    assert row["content"] == ""
    assert tc.strip_turn_context_metadata(messages) == [
        {"role": "system", "content": "prompt"},
        {"role": "user", "content": "hi"},
    ]
    folded = builder.insert_runtime_system_messages(
        messages, [f"{MEMORY_RECALL_HEADING}\n- likes tea"]
    )
    # Recall lands in the trailing row, not in the leading run.
    assert [m["content"] for m in folded][0] == "prompt"
    assert tc.is_turn_context_row(folded[1])
    assert str(folded[1]["content"]).startswith(tc.TURN_CONTEXT_HEADER)
    assert str(folded[1]["content"]).endswith("- likes tea")
    assert tc.place_turn_context_row([{"role": "user", "content": "hi"}], None) == [
        {"role": "user", "content": "hi"}
    ]


def test_folding_runtime_overlays_is_idempotent() -> None:
    row = tc.build_turn_context_row(["## Task Capsule\nfix the bug"])
    assert row is not None

    once = tc.fold_runtime_messages(row, [f"{MEMORY_RECALL_HEADING}\n- likes tea"])
    twice = tc.fold_runtime_messages(once, [f"{MEMORY_RECALL_HEADING}\n- likes tea"])
    cleared = tc.fold_runtime_messages(twice, [])

    assert once == twice
    assert str(once["content"]).endswith("- likes tea")
    assert cleared["content"] == row["content"]
    assert tc.strip_turn_context_metadata([once]) == [
        {"role": "system", "content": once["content"]}
    ]


def test_deferred_prompt_moves_per_turn_sections_out() -> None:
    builder = ContextBuilder(None)

    full = builder.build_system_prompt(
        "Base", tool_statuses=_STATUSES, latest_user_content=_ASK, cache_aware=True
    )
    deferred = builder.build_system_prompt(
        "Base",
        tool_statuses=_STATUSES,
        latest_user_content=_ASK,
        cache_aware=True,
        defer_turn_context=True,
    )
    other_turn = builder.build_system_prompt(
        "Base",
        tool_statuses=_STATUSES,
        latest_user_content="What is the weather in Paris today?",
        cache_aware=True,
        defer_turn_context=True,
    )
    sections = builder.build_turn_context_sections(
        tool_statuses=_STATUSES, latest_user_content=_ASK
    )

    assert isinstance(full, StructuredSystemPrompt)
    assert isinstance(deferred, StructuredSystemPrompt)
    names = {section.name for section in deferred.sections}
    assert names.isdisjoint(tc.TURN_SECTION_NAMES)
    assert "requested_tool_availability" in {section.name for section in full.sections}
    # The leading prompt no longer depends on what the user asked.
    assert str(deferred) == str(other_turn)
    assert any("## Requested Tool Availability" in section for section in sections)


def test_runtime_overlays_split_between_row_and_leading_run() -> None:
    builder = ContextBuilder(None)
    row = tc.build_turn_context_row(["## Task Capsule\nfix the bug"])
    messages = tc.place_turn_context_row(
        [{"role": "system", "content": "prompt"}, {"role": "user", "content": "go"}], row
    )
    overlays = [
        f"{PLAN_MODE_OVERLAY_HEADING}\nread only",
        f"{MEMORY_RECALL_HEADING}\n- likes tea",
        f"{CONTEXT_PRESSURE_ADVISORY_HEADING}\n80% used",
    ]

    first = builder.insert_runtime_system_messages(messages, overlays)
    again = builder.insert_runtime_system_messages(first, overlays)

    assert first == again
    assert [m["role"] for m in first] == ["system", "system", "system", "user"]
    assert first[1]["content"] == overlays[0]  # plan mode stays leading, ahead of the row
    assert tc.is_turn_context_row(first[2])
    assert "- likes tea" in str(first[2]["content"])
    assert "80% used" in str(first[2]["content"])


def test_row_always_reaches_the_model_as_a_user_row() -> None:
    row = tc.build_turn_context_row(["## Task Capsule\nfix the bug"])
    first_turn = tc.place_turn_context_row(
        [{"role": "system", "content": "prompt"}, {"role": "user", "content": "go"}], row
    )

    demoted = demote_non_leading_system_messages(first_turn)

    assert [m["role"] for m in demoted] == ["system", "user", "user"]


_SUMMARY = (
    "<analysis>\nEarlier questions.\n</analysis>\n\n<summary>\n"
    "## 1. Intent Summary\nAnswer questions.\n"
    "## 2. Key Technical Concepts\n(none)\n"
    "## 3. Relevant Files & Code\n(none)\n"
    "## 4. Errors & Debugging\n(none)\n"
    "## 5. Problem-Solving Approaches\n(none)\n"
    '## 6. User Messages\n"question 0"\n'
    "## 7. Pending Tasks\n(none)\n"
    "## 8. Current Work\nAnswering.\n"
    '## 9. Next Step\n"Answer the latest question."\n'
    "</summary>"
)


def test_compaction_never_summarises_the_row() -> None:
    from sidecar.ai.context.compaction_breaker import CompactionCircuitBreaker

    row = tc.build_turn_context_row(["## Task Capsule\nfix the bug"])
    history: list[dict[str, object]] = [{"role": "system", "content": "prompt"}]
    for index in range(30):
        history.append({"role": "user", "content": f"question {index} " + "x" * 400})
        history.append({"role": "assistant", "content": f"answer {index} " + "y" * 400})
    history.append({"role": "user", "content": "latest"})
    messages = tc.place_turn_context_row(history, row)
    summarised: list[str] = []

    def generate(batch: list[dict[str, str]]) -> str:
        summarised.extend(str(message.get("content") or "") for message in batch)
        return _SUMMARY

    result = compact_context(
        messages,
        TokenBudget(context_window=4000, max_output_tokens=500),
        generate_fn=generate,
        circuit_breaker=CompactionCircuitBreaker(),
        force=True,
    )

    assert result.strategy == "full"
    assert result.error is None
    assert result.tokens_after < result.tokens_before
    assert summarised and not any("fix the bug" in text for text in summarised)
    rows = [m for m in result.messages if tc.is_turn_context_row(m)]
    assert len(rows) == 1
    assert rows[0]["content"] == row["content"]
    assert result.messages[-1]["content"] == "latest"
    assert tc.is_turn_context_row(result.messages[-2])


def test_mid_turn_restore_puts_the_row_back_before_the_task_pin() -> None:
    from sidecar.ai.context.compaction import COMPACTED_SUMMARY_HEADING

    row = tc.build_turn_context_row(["## Task Capsule\nfix the bug"])
    compacted: list[dict[str, object]] = [
        {"role": "system", "content": "prompt"},
        {"role": "system", "content": f"{COMPACTED_SUMMARY_HEADING}\nearlier work"},
        {"role": "user", "content": "fix the bug"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "c1"}]},
        {"role": "tool", "content": "ok", "tool_call_id": "c1"},
    ]

    restored = tc.restore_turn_context_row(list(compacted), row)
    unchanged = tc.restore_turn_context_row(list(restored), row)

    assert tc.is_turn_context_row(restored[2])
    assert restored[3]["content"] == "fix the bug"
    assert unchanged == restored
    assert tc.restore_turn_context_row(list(compacted), None) == compacted


def test_plan_mode_exit_policy_rows_stay_ahead_of_the_row() -> None:
    from sidecar.ai.context.runtime_message_markers import RESTORED_TOOL_CONTRACT_HEADING
    from sidecar.ai.routing.plan_mode_transition import apply_restored_tool_contract

    row = tc.build_turn_context_row(["## Task Capsule\nfix the bug"])
    messages = tc.place_turn_context_row(
        [{"role": "system", "content": "prompt"}, {"role": "user", "content": "go"}], row
    )

    apply_restored_tool_contract(working_messages=messages, tool_statuses=_STATUSES)
    demoted = demote_non_leading_system_messages(messages)

    assert str(messages[1]["content"]).startswith(RESTORED_TOOL_CONTRACT_HEADING)
    assert tc.is_turn_context_row(messages[2])
    # The policy change keeps system authority; only the row is demoted.
    assert [m["role"] for m in demoted] == ["system", "system", "user", "user"]


def test_a_custom_prompt_opening_with_the_heading_is_not_the_row() -> None:
    custom = {"role": "system", "content": f"{tc.TURN_CONTEXT_HEADING}\nMy own rules."}
    messages = [custom, {"role": "user", "content": "go"}]

    recalled = ContextBuilder(None).insert_runtime_system_messages(
        messages, [f"{MEMORY_RECALL_HEADING}\n- likes tea"]
    )

    assert not tc.is_turn_context_row(custom)
    assert [m["role"] for m in demote_non_leading_system_messages(messages)] == ["system", "user"]
    assert recalled[0] == custom  # recall is its own row, not folded into the prompt
    assert str(recalled[1]["content"]).startswith(MEMORY_RECALL_HEADING)
