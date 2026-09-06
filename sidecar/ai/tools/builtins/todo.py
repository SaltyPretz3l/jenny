"""In-session todo list tool for model self-tracking.

Session-scoped in-memory task lists keyed by session id. State resets
when the sidecar process restarts. Feature-gated behind
``tools_todo_enabled``.
"""

from __future__ import annotations

import json

from sidecar.ai.error_codes import CMP_TOOL_TODO_INVALID, CMP_TOOL_TODO_OVERFLOW
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard

MAX_TODO_ITEMS = 50
MAX_SESSION_ENTRIES = 1000

_VALID_STATUSES = frozenset({"pending", "in_progress", "completed"})
_DEFAULT_SESSION_KEY = "__default__"


_todos_by_session: dict[str, list[dict[str, str]]] = {}


def _evict_oldest_sessions() -> None:
    while len(_todos_by_session) > MAX_SESSION_ENTRIES:
        oldest_session = next(iter(_todos_by_session), None)
        if oldest_session is None:
            return
        _todos_by_session.pop(oldest_session, None)


def _session_key(arguments: dict[str, object]) -> str:
    raw_value = arguments.get("_jenny_session_id")
    if not isinstance(raw_value, str):
        return _DEFAULT_SESSION_KEY
    normalized = raw_value.strip()
    if not normalized or "\x00" in normalized:
        return _DEFAULT_SESSION_KEY
    return normalized


def _bounded_plan_text(value: object, max_length: int) -> str:
    return value.strip()[:max_length] if isinstance(value, str) else ""


def _approved_plan(arguments: dict[str, object]) -> dict[str, object] | None:
    raw_plan = arguments.get("_jenny_approved_plan")
    if not isinstance(raw_plan, dict):
        return None
    title = _bounded_plan_text(raw_plan.get("title"), 120)
    raw_steps = raw_plan.get("steps")
    if not title or not isinstance(raw_steps, list) or not raw_steps:
        return None
    steps = [
        normalized
        for step in raw_steps[:20]
        if (normalized := _bounded_plan_text(step, 300))
    ]
    if not steps:
        return None
    return {
        "title": title,
        "steps": steps,
        "summary": _bounded_plan_text(raw_plan.get("summary"), 800),
    }


def _validate_items(raw_todos: object) -> list[dict[str, str]]:
    """Validate and normalise the incoming todo list."""
    if not isinstance(raw_todos, list):
        raise ToolExecutionFailure(
            code=CMP_TOOL_TODO_INVALID,
            message="'todos' must be an array",
        )
    if len(raw_todos) > MAX_TODO_ITEMS:
        raise ToolExecutionFailure(
            code=CMP_TOOL_TODO_OVERFLOW,
            message=f"todo list exceeds maximum of {MAX_TODO_ITEMS} items",
        )

    validated: list[dict[str, str]] = []
    for i, item in enumerate(raw_todos):
        if not isinstance(item, dict):
            raise ToolExecutionFailure(
                code=CMP_TOOL_TODO_INVALID,
                message=f"todo item {i} must be an object",
            )
        content = item.get("content")
        if not isinstance(content, str) or not content.strip():
            raise ToolExecutionFailure(
                code=CMP_TOOL_TODO_INVALID,
                message=f"todo item {i} has empty or missing 'content'",
            )
        status = item.get("status", "pending")
        if not isinstance(status, str) or status not in _VALID_STATUSES:
            raise ToolExecutionFailure(
                code=CMP_TOOL_TODO_INVALID,
                message=f"todo item {i} has invalid status: {status!r}",
            )
        validated.append({"content": content.strip(), "status": status})
    return validated


def todo_write_tool(
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> ToolHandlerResult:
    """Replace the entire todo list atomically.

    Auto-clears when every item has status ``completed``.
    """
    del workspace

    raw = arguments.get("todos")
    items = _validate_items(raw)
    session_key = _session_key(arguments)

    if items and all(it["status"] == "completed" for it in items):
        _todos_by_session.pop(session_key, None)
        return ToolHandlerResult(
            output=json.dumps(
                {"cleared": True, "reason": "all items completed", "count": 0},
                ensure_ascii=False,
            ),
        )

    _todos_by_session.pop(session_key, None)
    _todos_by_session[session_key] = items
    _evict_oldest_sessions()
    return ToolHandlerResult(
        output=json.dumps({"count": len(items), "todos": items}, ensure_ascii=False),
    )


def todo_read_tool(
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> str:
    """Read the current todo list."""
    del workspace

    session_key = _session_key(arguments)
    todos = list(_todos_by_session.get(session_key, ()))
    response: dict[str, object] = {"count": len(todos), "todos": todos}
    approved_plan = _approved_plan(arguments)
    if approved_plan is not None:
        response["plan"] = approved_plan
    return json.dumps(response, ensure_ascii=False)


def _reset_todos() -> None:
    """Test helper - clear session state between tests."""
    _todos_by_session.clear()
