from __future__ import annotations

import pytest

from sidecar.ai.tasks.task_state import (
    TaskStatus,
    TaskType,
    create_task,
    transition_task,
)


def test_create_task_generates_unique_prefixed_ids() -> None:
    first = create_task(TaskType.LOCAL_AGENT, "First")
    second = create_task(TaskType.LOCAL_AGENT, "Second")

    assert first.id.startswith("local_agent_")
    assert second.id.startswith("local_agent_")
    assert first.id != second.id


def test_valid_task_transitions() -> None:
    task = create_task(TaskType.LOCAL_AGENT, "Run")

    transition_task(task, TaskStatus.RUNNING)
    assert task.status is TaskStatus.RUNNING

    transition_task(task, TaskStatus.COMPLETED)
    assert task.status is TaskStatus.COMPLETED


@pytest.mark.parametrize(
    ("start_status", "new_status"),
    [
        (TaskStatus.PENDING, TaskStatus.COMPLETED),
        (TaskStatus.COMPLETED, TaskStatus.RUNNING),
        (TaskStatus.FAILED, TaskStatus.COMPLETED),
        (TaskStatus.KILLED, TaskStatus.RUNNING),
    ],
)
def test_invalid_task_transitions_raise(
    start_status: TaskStatus,
    new_status: TaskStatus,
) -> None:
    task = create_task(TaskType.LOCAL_AGENT, "Run")
    task.status = start_status

    with pytest.raises(ValueError, match="Illegal task transition"):
        transition_task(task, new_status)


# ── Additional transition path coverage ──────────────────────────────


def test_transition_running_to_failed_records_error() -> None:
    task = create_task(TaskType.LOCAL_AGENT, "Run")
    transition_task(task, TaskStatus.RUNNING)

    transition_task(task, TaskStatus.FAILED, error="network timeout")

    assert task.status is TaskStatus.FAILED
    assert task.error == "network timeout"


def test_transition_running_to_killed() -> None:
    task = create_task(TaskType.LOCAL_AGENT, "Run")
    transition_task(task, TaskStatus.RUNNING)

    transition_task(task, TaskStatus.KILLED)

    assert task.status is TaskStatus.KILLED


def test_transition_updates_timestamp() -> None:
    task = create_task(TaskType.LOCAL_AGENT, "Run")
    created_at = task.created_at
    updated_at = task.updated_at

    transition_task(task, TaskStatus.RUNNING)

    assert task.created_at == created_at
    assert task.updated_at >= updated_at


def test_transition_clears_error_on_success() -> None:
    task = create_task(TaskType.LOCAL_AGENT, "Run")
    task.error = "leftover error"

    transition_task(task, TaskStatus.RUNNING)
    transition_task(task, TaskStatus.COMPLETED)

    assert task.error is None


# ── create_task kwargs coverage ──────────────────────────────────────


def test_create_task_with_metadata_and_tool_use_id() -> None:
    task = create_task(
        TaskType.LOCAL_AGENT,
        "Run",
        tool_use_id="tool_abc",
        metadata={"key": "value"},
    )

    assert task.tool_use_id == "tool_abc"
    assert task.metadata == {"key": "value"}
    assert task.notified is False


# ── Terminal-state re-transition guard ───────────────────────────────


@pytest.mark.parametrize(
    "terminal_status", [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.KILLED]
)
def test_cannot_transition_from_terminal_state(terminal_status: TaskStatus) -> None:
    task = create_task(TaskType.LOCAL_AGENT, "Run")
    task.status = terminal_status

    for target in TaskStatus:
        if target == terminal_status:
            continue
        with pytest.raises(ValueError, match="Illegal task transition"):
            transition_task(task, target)

