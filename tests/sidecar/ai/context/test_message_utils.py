from __future__ import annotations

from sidecar.ai.context import message_utils
from sidecar.ai.context.message_utils import (
    SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
    ensure_tool_result_pairing,
)


def test_ensure_tool_result_pairing_clean_transcript_is_noop() -> None:
    messages = [
        {
            "role": "assistant",
            "content": "Calling read_file",
            "tool_calls": [{"id": "call_1", "name": "read_file", "arguments": {}}],
        },
        {"role": "tool", "tool_call_id": "call_1", "name": "read_file", "content": "done"},
    ]

    assert ensure_tool_result_pairing(messages) == messages


def test_ensure_tool_result_pairing_inserts_missing_tool_result() -> None:
    messages = [
        {
            "role": "assistant",
            "content": "Calling read_file",
            "tool_calls": [{"id": "call_1", "name": "read_file", "arguments": {}}],
        }
    ]

    repaired = ensure_tool_result_pairing(messages)

    assert repaired == [
        messages[0],
        {
            "role": "tool",
            "tool_call_id": "call_1",
            "name": "read_file",
            "content": SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
            "is_error": True,
        },
    ]


def test_ensure_tool_result_pairing_strips_orphan_tool_result() -> None:
    messages = [
        {"role": "tool", "tool_call_id": "orphan", "name": "read_file", "content": "orphan"},
        {"role": "user", "content": "continue"},
    ]

    assert ensure_tool_result_pairing(messages) == [{"role": "user", "content": "continue"}]


def test_ensure_tool_result_pairing_dedupes_duplicate_tool_calls() -> None:
    messages = [
        {
            "role": "assistant",
            "content": "First",
            "tool_calls": [{"id": "dup", "name": "read_file", "arguments": {}}],
        },
        {"role": "tool", "tool_call_id": "dup", "name": "read_file", "content": "done"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "dup", "name": "read_file", "arguments": {}}],
        },
    ]

    repaired = ensure_tool_result_pairing(messages)

    assert repaired == messages[:2]


def test_ensure_tool_result_pairing_handles_resume_mid_turn() -> None:
    messages = [
        {"role": "tool", "tool_call_id": "old_call", "name": "read_file", "content": "stale"},
        {
            "role": "assistant",
            "content": "Calling read_file",
            "tool_calls": [{"id": "call_1", "name": "read_file", "arguments": {}}],
        },
    ]

    repaired = ensure_tool_result_pairing(messages)

    assert repaired == [
        messages[1],
        {
            "role": "tool",
            "tool_call_id": "call_1",
            "name": "read_file",
            "content": SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
            "is_error": True,
        },
    ]


def test_ensure_tool_result_pairing_splits_multi_tool_call_message() -> None:
    messages = [
        {
            "id": "assistant_1",
            "role": "assistant",
            "content": "Calling tools",
            "tool_calls": [
                {"id": "call_1", "name": "read_file", "arguments": {}},
                {"id": "call_2", "name": "glob_files", "arguments": {}},
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "name": "read_file", "content": "done"},
    ]

    repaired = ensure_tool_result_pairing(messages)

    assert repaired == [
        {
            **messages[0],
            "id": "assistant_1__tool_1",
            "_normalized_from": "assistant_1",
            "tool_calls": [messages[0]["tool_calls"][0]],
        },
        messages[1],
        {
            **messages[0],
            "id": "assistant_1__tool_2",
            "_normalized_from": "assistant_1",
            "tool_calls": [messages[0]["tool_calls"][1]],
        },
        {
            "role": "tool",
            "tool_call_id": "call_2",
            "name": "glob_files",
            "content": SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
            "is_error": True,
        },
    ]


def test_ensure_tool_result_pairing_preserves_parallel_results_semantically() -> None:
    calls = [
        {"id": "call_a", "name": "read_file", "arguments": {"path": "a"}},
        {"id": "call_b", "name": "read_file", "arguments": {"path": "b"}},
        {"id": "call_c", "name": "read_file", "arguments": {"path": "c"}},
    ]
    messages: list[dict[str, object]] = [
        {"id": "assistant", "role": "assistant", "content": "read", "tool_calls": calls},
        {
            "role": "tool",
            "tool_call_id": "call_c",
            "content": "REAL_C",
            "is_error": False,
        },
        {"role": "tool", "tool_call_id": "call_a", "content": "REAL_A"},
        {"role": "tool", "tool_call_id": "call_a", "content": "DUPLICATE_A"},
    ]

    repaired = ensure_tool_result_pairing(messages)
    results = [message for message in repaired if message.get("role") == "tool"]

    assert [(item["tool_call_id"], item["content"]) for item in results] == [
        ("call_a", "REAL_A"),
        ("call_b", SYNTHETIC_TOOL_RESULT_PLACEHOLDER),
        ("call_c", "REAL_C"),
    ]
    assert results[0].get("is_error") is not True
    assert results[1]["is_error"] is True
    assert results[2].get("is_error") is False


def test_ensure_tool_result_pairing_preserves_complete_two_call_batch() -> None:
    messages: list[dict[str, object]] = [
        {
            "role": "assistant",
            "tool_calls": [
                {"id": "a", "name": "read_file", "arguments": {}},
                {"id": "b", "name": "glob_files", "arguments": {}},
            ],
        },
        {"role": "tool", "tool_call_id": "a", "content": "REAL_A", "is_error": False},
        {"role": "tool", "tool_call_id": "b", "content": "REAL_B", "is_error": False},
    ]

    repaired = ensure_tool_result_pairing(messages)
    results = [message for message in repaired if message.get("role") == "tool"]

    assert [(item["tool_call_id"], item["content"], item["is_error"]) for item in results] == [
        ("a", "REAL_A", False),
        ("b", "REAL_B", False),
    ]


def test_ensure_tool_result_pairing_fail_closed_returns_original(monkeypatch) -> None:
    messages = [{"role": "assistant", "content": "hello"}]

    monkeypatch.setattr(
        message_utils,
        "_first_tool_call_indices",
        lambda _messages: (_ for _ in ()).throw(RuntimeError("boom")),
    )

    assert ensure_tool_result_pairing(messages) == messages


# ── Additional ensure_tool_result_pairing coverage ───────────────────


def test_ensure_tool_result_pairing_multiple_calls_partial_results() -> None:
    """Two tool calls in separate assistant messages, only one has a result."""
    messages: list[dict[str, object]] = [
        {
            "role": "assistant",
            "content": "call 1",
            "tool_calls": [{"id": "c1", "name": "read_file", "arguments": {}}],
        },
        {"role": "tool", "tool_call_id": "c1", "name": "read_file", "content": "ok"},
        {
            "role": "assistant",
            "content": "call 2",
            "tool_calls": [{"id": "c2", "name": "write_file", "arguments": {}}],
        },
    ]

    repaired = ensure_tool_result_pairing(messages)

    tool_result_ids = [m["tool_call_id"] for m in repaired if m.get("role") == "tool"]
    assert "c1" in tool_result_ids
    assert "c2" in tool_result_ids
    synthetic = [m for m in repaired if m.get("role") == "tool" and m.get("tool_call_id") == "c2"]
    assert synthetic[0]["is_error"] is True


def test_ensure_tool_result_pairing_preserves_user_messages_between_calls() -> None:
    messages: list[dict[str, object]] = [
        {
            "role": "assistant",
            "content": "call",
            "tool_calls": [{"id": "c1", "name": "read_file", "arguments": {}}],
        },
        {"role": "tool", "tool_call_id": "c1", "name": "read_file", "content": "ok"},
        {"role": "user", "content": "can you also check the other file?"},
        {
            "role": "assistant",
            "content": "sure",
            "tool_calls": [{"id": "c2", "name": "read_file", "arguments": {}}],
        },
        {"role": "tool", "tool_call_id": "c2", "name": "read_file", "content": "done"},
    ]

    repaired = ensure_tool_result_pairing(messages)

    user_msgs = [m for m in repaired if m.get("role") == "user"]
    assert len(user_msgs) == 1
    assert user_msgs[0]["content"] == "can you also check the other file?"


def test_ensure_tool_result_pairing_empty_transcript() -> None:
    assert ensure_tool_result_pairing([]) == []


def test_ensure_tool_result_pairing_text_only_transcript() -> None:
    messages: list[dict[str, object]] = [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi"},
    ]
    assert ensure_tool_result_pairing(messages) == messages


def test_ensure_tool_result_pairing_strips_all_orphan_tool_results_at_start() -> None:
    messages: list[dict[str, object]] = [
        {"role": "tool", "tool_call_id": "x1", "content": "orphan 1"},
        {"role": "tool", "tool_call_id": "x2", "content": "orphan 2"},
        {"role": "user", "content": "hi"},
    ]
    repaired = ensure_tool_result_pairing(messages)
    assert repaired == [{"role": "user", "content": "hi"}]
