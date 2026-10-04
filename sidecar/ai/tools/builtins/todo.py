"""In-session todo list tool for model self-tracking.

Session-scoped task lists keyed by session id, held in memory and mirrored
to the app profile (``<profile>/todo-lists``) so a sidecar restart, such as
the "Restart engine" recovery, does not wipe an in-progress checklist
(dogfood FG-002-A). A restarted process loads a session's list lazily on its
first read. Feature-gated behind ``tools_todo_enabled``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
from pathlib import Path

from sidecar.ai.error_codes import CMP_TOOL_TODO_INVALID, CMP_TOOL_TODO_OVERFLOW
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard

MAX_TODO_ITEMS = 50
MAX_SESSION_ENTRIES = 1000
# A persisted list is at most 50 short items; anything larger is not ours.
MAX_PERSISTED_BYTES = 1024 * 1024
PERSISTED_SCHEMA_VERSION = 1
TODO_DIRECTORY = "todo-lists"

logger = logging.getLogger(__name__)

_VALID_STATUSES = frozenset({"pending", "in_progress", "completed"})
_DEFAULT_SESSION_KEY = "__default__"


_todos_by_session: dict[str, list[dict[str, str]]] = {}


def _evict_oldest_sessions() -> None:
    while len(_todos_by_session) > MAX_SESSION_ENTRIES:
        oldest_session = next(iter(_todos_by_session), None)
        if oldest_session is None:
            return
        _todos_by_session.pop(oldest_session, None)


def _todo_directory(workspace: WorkspaceGuard) -> Path | None:
    """The profile-scoped store, or None when this call carries no profile.

    The builtin server binds ``<profile>/workspace-snapshots`` as the
    per-call snapshot root (container_mcp_servers._default_mcp_servers), so
    its parent is the app profile. A call without it (no profile, or a
    rootless chat) keeps the list in memory only, as before.
    """
    raw = getattr(workspace, "pre_change_snapshot_root", None)
    if not isinstance(raw, str) or not raw.strip():
        return None
    snapshot_root = Path(raw.strip())
    if not snapshot_root.is_absolute():
        return None
    return snapshot_root.parent / TODO_DIRECTORY


def _todo_path(directory: Path, session_key: str) -> Path:
    digest = hashlib.sha256(session_key.encode("utf-8")).hexdigest()[:32]
    return directory / f"{digest}.json"


def _log_store_failure(event: str, error: Exception) -> None:
    # Never log list content or session ids: the reason class is enough.
    logger.warning(event, extra={"reason": type(error).__name__})


def _prune_persisted(directory: Path) -> None:
    files = sorted(directory.glob("*.json"), key=lambda item: item.stat().st_mtime)
    for stale in files[: max(0, len(files) - MAX_SESSION_ENTRIES)]:
        stale.unlink(missing_ok=True)


def _persist(workspace: WorkspaceGuard, session_key: str, items: list[dict[str, str]]) -> None:
    """Best effort: the in-memory list stays authoritative for this process."""
    directory = _todo_directory(workspace)
    if directory is None or session_key == _DEFAULT_SESSION_KEY:
        return
    path = _todo_path(directory, session_key)
    try:
        if not items:
            path.unlink(missing_ok=True)
            return
        directory.mkdir(parents=True, exist_ok=True)
        existed = path.exists()
        document = {
            "schema_version": PERSISTED_SCHEMA_VERSION,
            "session_id": session_key,
            "todos": items,
        }
        descriptor, temp_name = tempfile.mkstemp(dir=directory, prefix=".todo-", suffix=".tmp")
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(document, handle, ensure_ascii=False)
            os.replace(temp_name, path)
        except BaseException:
            Path(temp_name).unlink(missing_ok=True)
            raise
        if not existed:
            _prune_persisted(directory)
    except OSError as error:
        _log_store_failure("todo_persist_failed", error)


def _load_persisted(workspace: WorkspaceGuard, session_key: str) -> list[dict[str, str]] | None:
    directory = _todo_directory(workspace)
    if directory is None or session_key == _DEFAULT_SESSION_KEY:
        return None
    path = _todo_path(directory, session_key)
    try:
        if not path.is_file() or path.stat().st_size > MAX_PERSISTED_BYTES:
            return None
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        _log_store_failure("todo_restore_failed", error)
        return None
    if (
        not isinstance(document, dict)
        or document.get("schema_version") != PERSISTED_SCHEMA_VERSION
        or document.get("session_id") != session_key
    ):
        return None
    try:
        items = _validate_items(document.get("todos"))
    except ToolExecutionFailure:
        return None
    return items or None


def _remember(session_key: str, items: list[dict[str, str]]) -> None:
    _todos_by_session.pop(session_key, None)
    _todos_by_session[session_key] = items
    _evict_oldest_sessions()


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
    raw = arguments.get("todos")
    items = _validate_items(raw)
    session_key = _session_key(arguments)

    if items and all(it["status"] == "completed" for it in items):
        _todos_by_session.pop(session_key, None)
        _persist(workspace, session_key, [])
        return ToolHandlerResult(
            output=json.dumps(
                {"cleared": True, "reason": "all items completed", "count": 0},
                ensure_ascii=False,
            ),
        )

    _remember(session_key, items)
    _persist(workspace, session_key, items)
    return ToolHandlerResult(
        output=json.dumps({"count": len(items), "todos": items}, ensure_ascii=False),
    )


def todo_read_tool(
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> str:
    """Read the current todo list, restoring a persisted one after a restart."""
    session_key = _session_key(arguments)
    if session_key not in _todos_by_session:
        restored = _load_persisted(workspace, session_key)
        if restored is not None:
            _remember(session_key, restored)
    todos = list(_todos_by_session.get(session_key, ()))
    response: dict[str, object] = {"count": len(todos), "todos": todos}
    approved_plan = _approved_plan(arguments)
    if approved_plan is not None:
        response["plan"] = approved_plan
    return json.dumps(response, ensure_ascii=False)


def _reset_todos() -> None:
    """Test helper - clear session state between tests."""
    _todos_by_session.clear()
