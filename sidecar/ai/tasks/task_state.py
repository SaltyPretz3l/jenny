"""Request-scoped task lifecycle helpers for agent execution."""

from __future__ import annotations

import secrets
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class TaskType(str, Enum):
    LOCAL_AGENT = "local_agent"


class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    KILLED = "killed"


VALID_TRANSITIONS: dict[TaskStatus, frozenset[TaskStatus]] = {
    TaskStatus.PENDING: frozenset({TaskStatus.RUNNING}),
    TaskStatus.RUNNING: frozenset({TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.KILLED}),
    TaskStatus.COMPLETED: frozenset(),
    TaskStatus.FAILED: frozenset(),
    TaskStatus.KILLED: frozenset(),
}


@dataclass
class TaskState:
    id: str
    type: TaskType
    status: TaskStatus
    description: str
    created_at: float
    updated_at: float
    tool_use_id: str | None = None
    notified: bool = False
    error: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)


def create_task(
    task_type: TaskType,
    description: str,
    **kwargs: Any,
) -> TaskState:
    now = time.time()
    metadata = kwargs.pop("metadata", None)
    return TaskState(
        id=f"{task_type.value}_{secrets.token_hex(4)}",
        type=task_type,
        status=TaskStatus.PENDING,
        description=str(description),
        created_at=now,
        updated_at=now,
        tool_use_id=kwargs.pop("tool_use_id", None),
        notified=bool(kwargs.pop("notified", False)),
        error=kwargs.pop("error", None),
        metadata=dict(metadata) if isinstance(metadata, dict) else {},
    )


def transition_task(
    task: TaskState,
    new_status: TaskStatus,
    *,
    error: str | None = None,
) -> TaskState:
    allowed = VALID_TRANSITIONS.get(task.status, frozenset())
    if new_status not in allowed:
        raise ValueError(f"Illegal task transition: {task.status.value} -> {new_status.value}")
    task.status = new_status
    task.updated_at = time.time()
    task.error = error
    return task


def summarize_task(task: TaskState) -> dict[str, object]:
    return {
        "id": task.id,
        "type": task.type.value,
        "status": task.status.value,
        "description": task.description,
        "created_at": task.created_at,
        "updated_at": task.updated_at,
        "tool_use_id": task.tool_use_id,
        "notified": task.notified,
        "error": task.error,
        "metadata": dict(task.metadata),
    }


__all__ = [
    "summarize_task",
    "TaskState",
    "TaskStatus",
    "TaskType",
    "VALID_TRANSITIONS",
    "create_task",
    "transition_task",
]
