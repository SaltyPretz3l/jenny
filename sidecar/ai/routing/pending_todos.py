"""Keep working when an empty post-tool completion leaves todo items open.

The model tracks multi-step work with ``todo_write``. An empty completion after
a tool batch normally winds the turn down with a tools-stripped summary; with
items still open on the turn's latest list that ends the work early (owner
session 2026-10-31: the user had to type "go"). The one-shot post-tool
continuation retry is used instead, tools kept, naming the open items.
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger("sidecar.ai.routing.tool_loop")

TODO_WRITE_TOOL = "todo_write"
EMPTY_WITH_PENDING_TODOS_TRIGGER = "empty_with_pending_todos"
_COMPLETED = "completed"
_NUDGE_ITEMS = 3
_NUDGE_ITEM_CHARS = 160


def _pending_in(output: object) -> list[str]:
    try:
        document = json.loads(str(output or ""))
    except (TypeError, ValueError):
        return []
    if not isinstance(document, dict) or document.get("cleared") is True:
        return []
    todos = document.get("todos")
    if not isinstance(todos, list):
        return []
    return [
        " ".join(str(item.get("content") or "").split())
        for item in todos
        if isinstance(item, dict) and str(item.get("status") or "pending").strip() != _COMPLETED
    ]


def pending_todo_items(outcomes: list[Any]) -> list[str]:
    """Open items on the turn's latest successful ``todo_write`` list, in order.

    The tool returns ``{"count", "todos": [{content, status}]}``, or
    ``{"cleared": true}`` once every item is completed. Anything else is read
    as nothing pending.
    """
    for outcome in reversed(outcomes or ()):
        if str(getattr(outcome, "tool_name", "") or "").strip() != TODO_WRITE_TOOL:
            continue
        if getattr(outcome, "success", False) is not True:
            continue
        return _pending_in(getattr(outcome, "output", ""))
    return []


def _nudge(items: list[str]) -> str:
    listed = "\n".join(f"- {item[:_NUDGE_ITEM_CHARS]}" for item in items[:_NUDGE_ITEMS] if item)
    extra = len(items) - min(len(items), _NUDGE_ITEMS)
    more = f"\n- ...and {extra} more" if extra > 0 else ""
    return (
        "[Harness note, not a message from the user] Your todo list still has "
        f"{len(items)} pending item(s):\n{listed}{more}\n"
        "Continue the pending todo items now, using tools. Do not stop to report "
        "progress until they are done or you are blocked; update the list with "
        "todo_write as items complete."
    )


def continue_pending_todos(loop: Any, iteration: int) -> bool:
    """Spend the one-shot post-tool continuation on open todo items.

    The caller has already established the completion is empty after tools,
    the continuation is unspent and an iteration remains. Returns ``True``
    when the retry was queued (the caller returns ``None`` to re-generate).
    """
    items = pending_todo_items(loop.outcomes)
    if not items:
        return False
    trigger = EMPTY_WITH_PENDING_TODOS_TRIGGER
    queue_post_tool_retry(
        loop,
        trigger=trigger,
        nudge=_nudge(items),
        log_data={
            "iteration": iteration,
            "trigger": trigger,
            "pending_todo_count": len(items),
            "outcome_count": len(loop.outcomes),
        },
    )
    return True


def queue_post_tool_retry(loop: Any, *, trigger: str, nudge: str, log_data: dict[str, Any]) -> None:
    """Spend the one-shot post-tool continuation: regenerate with *nudge*, tools kept.

    Shared by every post-tool recovery trigger (``tool_loop_finalize``) so the
    retry's heuristic fire, stream reset and log line cannot drift apart.
    """
    import sidecar.ai.routing.tool_loop as _tl_hub

    loop.post_tool_continuation_attempted = True
    _tl_hub.heuristic_fires.emit_heuristic_fire(
        loop.runtime, "post_tool_recovery", trigger=trigger, action="retry"
    )
    _tl_hub.loop_event_emit.emit_stream_reset_for_retry(
        loop.runtime, loop.streamed_event_types, reason="post_tool_restart"
    )
    _tl_hub.log_event(
        logger,
        logging.WARNING,
        component="ai.router",
        event="ai.router.post_tool_recovery_retry",
        message=(
            f"Post-tool response needs recovery ({trigger}); retrying once with "
            "continuation guidance."
        ),
        status="retry",
        data=log_data,
        request_id=loop.request_id,
    )
    loop.working_messages.append({"role": "user", "content": nudge})
