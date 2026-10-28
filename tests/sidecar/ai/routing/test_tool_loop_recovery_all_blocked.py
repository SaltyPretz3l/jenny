"""The all-blocked tail of ``canonicalize_tool_call_batch`` sees every rejection family."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.routing import tool_loop_recovery
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest


def _loop() -> SimpleNamespace:
    return SimpleNamespace(
        runtime=SimpleNamespace(turn_call_ids=set()),
        latest_user_content="Write the files.",
        request_id="req_all_blocked",
        session_id="session_all_blocked",
    )


@pytest.fixture()
def blocked_tail(monkeypatch: pytest.MonkeyPatch) -> list[tuple[Any, ...]]:
    finished: list[tuple[Any, ...]] = []
    monkeypatch.setattr(tool_loop_recovery, "record_failed_tool_calls", lambda *_a, **_k: None)
    monkeypatch.setattr(
        tool_loop_recovery,
        "finish_all_blocked_iteration",
        lambda _loop, blocked, _last: finished.append(tuple(blocked)),
    )
    return finished


def test_alias_conflict_tail_keeps_the_malformed_call_blocked(
    blocked_tail: list[tuple[Any, ...]],
) -> None:
    malformed = ToolCallRequest(
        tool_id="write_file", arguments={}, call_id="call_malformed", malformed_arguments=True
    )
    conflicting = ToolCallRequest(
        tool_id="write_file",
        arguments={"path": "a.txt", "file_path": "b.txt", "content": "x"},
        call_id="call_conflict",
    )
    result = GenerationResult(content="", tool_calls=(malformed, conflicting))

    result, all_blocked = tool_loop_recovery.canonicalize_tool_call_batch(
        _loop(), result, last_error_output=None
    )

    assert all_blocked is True
    assert result.tool_calls == ()
    (blocked,) = blocked_tail
    assert {call.call_id for call in blocked} == {"call_malformed", "call_conflict"}


def test_no_conflict_tail_is_unchanged(blocked_tail: list[tuple[Any, ...]]) -> None:
    malformed = ToolCallRequest(
        tool_id="write_file", arguments={}, call_id="call_malformed", malformed_arguments=True
    )
    result = GenerationResult(content="", tool_calls=(malformed,))

    _result, all_blocked = tool_loop_recovery.canonicalize_tool_call_batch(
        _loop(), result, last_error_output=None
    )

    assert all_blocked is True
    assert [[call.call_id for call in blocked] for blocked in blocked_tail] == [
        ["call_malformed"]
    ]
