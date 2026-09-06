"""Tests for the in-session todo tool."""

from __future__ import annotations

import json

import pytest

from sidecar.ai.tools.builtins import todo as todo_module
from sidecar.ai.tools.builtins.todo import (
    MAX_TODO_ITEMS,
    _reset_todos,
    todo_read_tool,
    todo_write_tool,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


@pytest.fixture(autouse=True)
def _clean_todos() -> None:
    """Reset module state between tests."""
    _reset_todos()


def _guard(tmp_path: object) -> WorkspaceGuard:
    return WorkspaceGuard(None)  # todo tool doesn't use workspace


def _read() -> dict[str, object]:
    raw = todo_read_tool({}, _guard(None))
    return json.loads(raw)


# ── Write + read roundtrip ────────────────────────────────────────────


def test_write_and_read_roundtrip() -> None:
    todos = [
        {"content": "Fix bug", "status": "pending"},
        {"content": "Write tests", "status": "in_progress"},
        {"content": "Deploy", "status": "pending"},
    ]
    result = todo_write_tool({"todos": todos}, _guard(None))
    assert result.success is True

    data = _read()
    assert data["count"] == 3
    assert data["todos"][0]["content"] == "Fix bug"
    assert data["todos"][1]["status"] == "in_progress"


# ── Auto-clear on all completed ──────────────────────────────────────


def test_auto_clear_on_all_completed() -> None:
    todos = [
        {"content": "A", "status": "completed"},
        {"content": "B", "status": "completed"},
    ]
    result = todo_write_tool({"todos": todos}, _guard(None))
    body = json.loads(result.output)
    assert body["cleared"] is True
    assert body["count"] == 0

    data = _read()
    assert data["count"] == 0


# ── Atomic replace ───────────────────────────────────────────────────


def test_atomic_replace() -> None:
    todo_write_tool({"todos": [{"content": "First", "status": "pending"}]}, _guard(None))
    todo_write_tool({"todos": [{"content": "Second", "status": "pending"}]}, _guard(None))

    data = _read()
    assert data["count"] == 1
    assert data["todos"][0]["content"] == "Second"


def test_session_scoped_todos_do_not_leak_between_sessions() -> None:
    todo_write_tool(
        {
            "_jenny_session_id": "session-a",
            "todos": [{"content": "First session", "status": "pending"}],
        },
        _guard(None),
    )
    todo_write_tool(
        {
            "_jenny_session_id": "session-b",
            "todos": [{"content": "Second session", "status": "in_progress"}],
        },
        _guard(None),
    )

    session_a = json.loads(todo_read_tool({"_jenny_session_id": "session-a"}, _guard(None)))
    session_b = json.loads(todo_read_tool({"_jenny_session_id": "session-b"}, _guard(None)))

    assert session_a["todos"] == [{"content": "First session", "status": "pending"}]
    assert session_b["todos"] == [{"content": "Second session", "status": "in_progress"}]


def test_todo_state_evicts_oldest_sessions_when_cap_is_exceeded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(todo_module, "MAX_SESSION_ENTRIES", 2)

    for session_id in ("session-a", "session-b", "session-c"):
        todo_write_tool(
            {
                "_jenny_session_id": session_id,
                "todos": [{"content": session_id, "status": "pending"}],
            },
            _guard(None),
        )

    session_a = json.loads(todo_read_tool({"_jenny_session_id": "session-a"}, _guard(None)))
    session_b = json.loads(todo_read_tool({"_jenny_session_id": "session-b"}, _guard(None)))
    session_c = json.loads(todo_read_tool({"_jenny_session_id": "session-c"}, _guard(None)))

    assert session_a == {"count": 0, "todos": []}
    assert session_b["todos"] == [{"content": "session-b", "status": "pending"}]
    assert session_c["todos"] == [{"content": "session-c", "status": "pending"}]


# ── Max items ────────────────────────────────────────────────────────


def test_max_items_enforced() -> None:
    big = [{"content": f"Item {i}", "status": "pending"} for i in range(MAX_TODO_ITEMS + 1)]
    with pytest.raises(ToolExecutionFailure, match="maximum"):
        todo_write_tool({"todos": big}, _guard(None))


# ── Validation ───────────────────────────────────────────────────────


def test_invalid_status_rejected() -> None:
    with pytest.raises(ToolExecutionFailure, match="invalid status"):
        todo_write_tool(
            {"todos": [{"content": "X", "status": "done"}]},
            _guard(None),
        )


def test_empty_content_rejected() -> None:
    with pytest.raises(ToolExecutionFailure, match="empty"):
        todo_write_tool(
            {"todos": [{"content": "", "status": "pending"}]},
            _guard(None),
        )


def test_missing_content_rejected() -> None:
    with pytest.raises(ToolExecutionFailure, match="empty"):
        todo_write_tool(
            {"todos": [{"status": "pending"}]},
            _guard(None),
        )


def test_non_array_rejected() -> None:
    with pytest.raises(ToolExecutionFailure, match="array"):
        todo_write_tool({"todos": "not a list"}, _guard(None))


# ── Read empty ───────────────────────────────────────────────────────


def test_read_empty_list() -> None:
    data = _read()
    assert data["count"] == 0
    assert data["todos"] == []
    assert "plan" not in data


def test_read_includes_injected_approved_plan() -> None:
    data = json.loads(
        todo_read_tool(
            {
                "_jenny_approved_plan": {
                    "title": "Ship the fix",
                    "steps": ["Add coverage", "Implement the boundary"],
                    "summary": "Keep the plan visible while work is active.",
                }
            },
            _guard(None),
        )
    )

    assert data["plan"] == {
        "title": "Ship the fix",
        "steps": ["Add coverage", "Implement the boundary"],
        "summary": "Keep the plan visible while work is active.",
    }


def test_read_bounds_and_filters_injected_approved_plan() -> None:
    data = json.loads(
        todo_read_tool(
            {
                "_jenny_approved_plan": {
                    "title": f"  {'T' * 140}  ",
                    "steps": ["S" * 320, None, "  ", 7, *[f"Step {i}" for i in range(20)]],
                    "summary": "M" * 900,
                }
            },
            _guard(None),
        )
    )

    assert len(data["plan"]["title"]) == 120
    assert len(data["plan"]["summary"]) == 800
    assert len(data["plan"]["steps"]) == 17
    assert len(data["plan"]["steps"][0]) == 300
    assert all(isinstance(step, str) and step for step in data["plan"]["steps"])


def test_read_omits_invalid_injected_approved_plan() -> None:
    data = json.loads(
        todo_read_tool(
            {"_jenny_approved_plan": {"title": "Plan", "steps": [None, "  "]}},
            _guard(None),
        )
    )

    assert "plan" not in data


# ── Default status ───────────────────────────────────────────────────


def test_default_status_is_pending() -> None:
    todo_write_tool(
        {"todos": [{"content": "No status given", "status": "pending"}]},
        _guard(None),
    )
    data = _read()
    assert data["todos"][0]["status"] == "pending"
