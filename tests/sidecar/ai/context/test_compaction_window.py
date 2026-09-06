from __future__ import annotations

from sidecar.ai.context import compaction as c
from sidecar.ai.context.compaction_window import (
    MID_TURN_NUDGE,
    MID_TURN_TASK_STUB,
    _TOOL_PLACEHOLDER,
    _copy_message_for_compaction,
    _index_tool_calls,
    _strip_matching_tool_call_arguments,
    admit_summary_source,
    split_mid_turn_window,
    summary_input_limit,
)
from sidecar.ai.context.token_budget import (
    CharEstimationBackend,
    TokenBudget,
    estimate_messages_tokens,
)


def test_compaction_window_exports_shared_stripping_primitives() -> None:
    assert _TOOL_PLACEHOLDER == "[tool output omitted for context space]"
    assert c._TOOL_PLACEHOLDER is _TOOL_PLACEHOLDER


def _admission_budget() -> TokenBudget:
    return TokenBudget(
        context_window=2_000,
        max_output_tokens=200,
        reserved_for_summary=200,
    )


def _tool_round(call_id: str, content: str) -> list[dict[str, object]]:
    return [
        {
            "role": "assistant",
            "content": f"Calling {call_id}.",
            "tool_calls": [
                {
                    "id": call_id,
                    "name": "read_file",
                    "arguments": {"path": f"{call_id}.txt"},
                }
            ],
        },
        {"role": "tool", "tool_call_id": call_id, "content": content},
    ]


def test_admit_summary_source_returns_input_unchanged_when_under_limit() -> None:
    messages = [{"role": "user", "content": "hello"}]

    result = admit_summary_source(
        messages,
        _admission_budget(),
        CharEstimationBackend(),
        prompt_tokens=512,
    )

    assert result.messages is messages
    assert result.truncated is False
    assert result.stripped_messages == 0
    assert result.dropped_messages == 0


def test_admit_summary_source_strips_tool_contents_oldest_first() -> None:
    messages = [
        *_tool_round("call_1", "x" * 1_600),
        *_tool_round("call_2", "y" * 1_600),
    ]

    result = admit_summary_source(
        messages,
        _admission_budget(),
        CharEstimationBackend(),
        prompt_tokens=512,
    )

    assert result.messages[1]["content"] == _TOOL_PLACEHOLDER
    assert result.messages[3]["content"] == "y" * 1_600
    assert result.stripped_messages == 1
    assert result.messages[0]["tool_calls"][0]["arguments"] == {"compacted": True}


def test_admit_summary_source_has_no_preserve_tail() -> None:
    messages = [
        {"role": "user", "content": "inspect the file"},
        *_tool_round("call_last", "z" * 4_000),
    ]

    result = admit_summary_source(
        messages,
        _admission_budget(),
        CharEstimationBackend(),
        prompt_tokens=512,
    )

    assert result.messages[-1]["content"] == _TOOL_PLACEHOLDER
    assert result.stripped_messages == 1


def test_admit_summary_source_drops_oldest_rows_and_prepends_omission_marker() -> None:
    backend = CharEstimationBackend()
    messages = [
        {"role": "assistant", "content": chr(97 + index) * 600}
        for index in range(6)
    ]

    result = admit_summary_source(
        messages,
        _admission_budget(),
        backend,
        prompt_tokens=512,
    )

    assert result.dropped_messages == 2
    assert result.messages[0] == {
        "role": "system",
        "content": "[2 earlier messages omitted from this summary input]",
    }
    assert result.messages[1] == messages[2]
    assert estimate_messages_tokens(result.messages, backend) <= summary_input_limit(
        _admission_budget(), prompt_tokens=512
    )


def test_summary_input_limit_excludes_prompt_and_summary_reservation() -> None:
    budget = TokenBudget(
        context_window=4_096,
        max_output_tokens=512,
        reserved_for_summary=512,
    )

    assert summary_input_limit(budget, prompt_tokens=256) == 2_816
    assert summary_input_limit(budget, prompt_tokens=10_000) == 1_024


def _mid_turn_rows(
    pair_count: int,
    *,
    task: str = "Complete the task.",
    tool_content: str = "tool result",
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = [{"role": "user", "content": task}]
    for index in range(1, pair_count + 1):
        call_id = f"call_{index}"
        rows.extend(
            [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": call_id,
                            "name": "read_file",
                            "arguments": {"path": f"file_{index}.txt"},
                        }
                    ],
                },
                {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": tool_content,
                },
            ]
        )
    return rows


def test_mid_turn_window_task_index_is_the_last_user_row() -> None:
    rows = [
        {"role": "user", "content": "Earlier request."},
        {"role": "assistant", "content": "Earlier response."},
        *_mid_turn_rows(4, task="Current task."),
    ]

    window = split_mid_turn_window(
        rows,
        _admission_budget(),
        CharEstimationBackend(),
        num_tools=0,
    )

    assert window.applicable is True
    assert window.task_message == {"role": "user", "content": "Current task."}


def test_mid_turn_window_is_not_applicable_without_a_user_row() -> None:
    window = split_mid_turn_window(
        [
            {"role": "assistant", "content": "Working."},
            {"role": "tool", "tool_call_id": "call_1", "content": "Done."},
        ],
        _admission_budget(),
        CharEstimationBackend(),
        num_tools=0,
    )

    assert window.applicable is False
    assert window.task_message is None
    assert window.summary_source == []
    assert window.tail == []
    assert window.covered_through_tool_call_id is None


def test_mid_turn_window_is_not_applicable_with_nothing_but_the_task() -> None:
    window = split_mid_turn_window(
        _mid_turn_rows(0),
        _admission_budget(),
        CharEstimationBackend(),
        num_tools=0,
    )

    assert window.applicable is False
    assert window.summary_source == []
    assert window.tail == []


def test_mid_turn_tail_never_starts_on_a_tool_row() -> None:
    for pair_count in range(4, 11):
        window = split_mid_turn_window(
            _mid_turn_rows(pair_count),
            _admission_budget(),
            CharEstimationBackend(),
            num_tools=0,
        )

        assert window.applicable is True
        assert window.tail[0]["role"] != "tool"


def test_mid_turn_tail_preserves_at_least_six_rows() -> None:
    window = split_mid_turn_window(
        _mid_turn_rows(10),
        TokenBudget(context_window=200_000, max_output_tokens=16_384),
        CharEstimationBackend(),
        num_tools=0,
    )

    assert window.applicable is True
    assert len(window.tail) >= 6


def test_mid_turn_tail_shrinks_to_one_pair_under_the_quarter_context_cap() -> None:
    window = split_mid_turn_window(
        _mid_turn_rows(10, tool_content="x" * 20_000),
        _admission_budget(),
        CharEstimationBackend(),
        num_tools=0,
    )

    assert window.applicable is True
    assert [row["role"] for row in window.tail] == ["assistant", "tool"]
    assert window.tail[1]["tool_call_id"] == "call_10"


def test_mid_turn_summary_source_includes_this_turns_older_tool_activity() -> None:
    window = split_mid_turn_window(
        _mid_turn_rows(10),
        TokenBudget(context_window=200_000, max_output_tokens=16_384),
        CharEstimationBackend(),
        num_tools=0,
    )

    assert any(
        row.get("role") == "tool" and row.get("tool_call_id") == "call_1"
        for row in window.summary_source
    )


def test_mid_turn_summary_source_strips_prior_continuation_nudges() -> None:
    rows = _mid_turn_rows(10)
    rows.insert(5, {"role": "system", "content": MID_TURN_NUDGE})

    window = split_mid_turn_window(
        rows,
        TokenBudget(context_window=200_000, max_output_tokens=16_384),
        CharEstimationBackend(),
        num_tools=0,
    )

    assert all(
        row.get("content") != MID_TURN_NUDGE
        for row in [*window.summary_source, *window.tail]
    )


def test_mid_turn_covered_through_is_the_last_summarised_tool_call_id() -> None:
    window = split_mid_turn_window(
        _mid_turn_rows(10),
        TokenBudget(context_window=200_000, max_output_tokens=16_384),
        CharEstimationBackend(),
        num_tools=0,
    )

    assert window.covered_through_tool_call_id == "call_7"


def test_mid_turn_covered_through_is_none_when_no_turn_tool_rows_are_summarised() -> None:
    window = split_mid_turn_window(
        [
            {"role": "user", "content": "Prior task."},
            {"role": "assistant", "content": "Prior answer."},
            *_mid_turn_rows(1, task="Current task."),
        ],
        _admission_budget(),
        CharEstimationBackend(),
        num_tools=0,
    )

    assert window.applicable is True
    assert window.covered_through_tool_call_id is None


def _assert_every_tool_call_has_its_result(rows: list[dict[str, object]]) -> None:
    call_ids = {
        str(call.get("id"))
        for row in rows
        for call in (row.get("tool_calls") or [])  # type: ignore[union-attr]
    }
    result_ids = {str(row.get("tool_call_id")) for row in rows if row.get("role") == "tool"}
    assert call_ids <= result_ids, call_ids - result_ids


def test_mid_turn_nudge_filter_is_role_gated_so_a_tool_row_quoting_it_survives() -> None:
    rows = _mid_turn_rows(10)
    quoting_tool_row = rows[-1]
    assert quoting_tool_row["role"] == "tool"
    quoting_tool_row["content"] = MID_TURN_NUDGE + "\n(fetched page text)"

    window = split_mid_turn_window(
        rows,
        TokenBudget(context_window=200_000, max_output_tokens=16_384),
        CharEstimationBackend(),
        num_tools=0,
    )

    kept = [*window.summary_source, *window.tail]
    assert quoting_tool_row in kept
    _assert_every_tool_call_has_its_result(kept)


def test_mid_turn_task_index_prefers_the_turns_prompt_over_loop_injected_user_rows() -> None:
    rows = _mid_turn_rows(8, task="Current task.")
    rows.insert(
        9,
        {"role": "user", "content": "Your call to 'read_file' was rejected: bad args."},
    )

    window = split_mid_turn_window(
        rows,
        TokenBudget(context_window=200_000, max_output_tokens=16_384),
        CharEstimationBackend(),
        num_tools=0,
        task_content="Current task.",
    )

    assert window.applicable is True
    assert window.task_message == {"role": "user", "content": "Current task."}
    assert window.covered_through_tool_call_id is not None


def test_mid_turn_task_index_accepts_the_pinned_task_stub() -> None:
    rows = _mid_turn_rows(8, task=MID_TURN_TASK_STUB)

    window = split_mid_turn_window(
        rows,
        TokenBudget(context_window=200_000, max_output_tokens=16_384),
        CharEstimationBackend(),
        num_tools=0,
        task_content="The original, now-summarised prompt.",
    )

    assert window.applicable is True
    assert window.task_message == {"role": "user", "content": MID_TURN_TASK_STUB}


def test_mid_turn_task_index_falls_back_to_the_last_user_row_without_a_prompt() -> None:
    rows = [
        {"role": "user", "content": "Earlier request."},
        {"role": "assistant", "content": "Earlier response."},
        *_mid_turn_rows(4, task="Current task."),
    ]

    window = split_mid_turn_window(
        rows,
        _admission_budget(),
        CharEstimationBackend(),
        num_tools=0,
        task_content="A prompt that matches no row.",
    )

    assert window.task_message == {"role": "user", "content": "Current task."}


def test_mid_turn_window_normalises_role_case() -> None:
    rows = _mid_turn_rows(8, task="Current task.")
    rows[0]["role"] = "User"
    for row in rows[1:]:
        row["role"] = str(row["role"]).upper()

    window = split_mid_turn_window(
        rows,
        TokenBudget(context_window=200_000, max_output_tokens=16_384),
        CharEstimationBackend(),
        num_tools=0,
    )

    assert window.applicable is True
    assert window.tail[0]["role"] != "TOOL"
    assert window.covered_through_tool_call_id is not None
