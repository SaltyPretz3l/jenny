from __future__ import annotations

from sidecar.ai.context.compaction import microcompact
from sidecar.ai.context.token_budget import TokenBudget


def test_microcompact_strips_arguments_for_canonical_call_id() -> None:
    messages = [
        {"role": "user", "content": "inspect"},
        {
            "role": "assistant",
            "content": "ok",
            "tool_calls": [
                {
                    "call_id": "call_1",
                    "name": "read_file",
                    "arguments": {"path": "secret.txt", "payload": "x" * 1_000},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": "y" * 1_000},
        *[{"role": "user", "content": f"tail {index}"} for index in range(8)],
    ]
    budget = TokenBudget(
        context_window=200,
        max_output_tokens=1,
        reserved_for_summary=0,
        tool_overhead_per_tool=0,
    )

    result = microcompact(messages, budget)

    assert result.messages[1]["tool_calls"][0]["arguments"] == {"compacted": True}
    assert result.messages[2]["content"] == "[tool output omitted for context space]"
