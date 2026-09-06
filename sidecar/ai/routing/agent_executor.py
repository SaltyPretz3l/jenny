"""Observable task-lifecycle wrapper around the canonical chat router."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from sidecar.ai.context.builder import LearnedLesson
from sidecar.ai.context.message_utils import ensure_tool_result_pairing
from sidecar.ai.feature_flags import FEATURE_TASK_LIFECYCLE, is_feature_flag_enabled
from sidecar.ai.routing.router import ChatDecision, ChatRouter
from sidecar.ai.tasks.task_state import (
    TaskState,
    TaskStatus,
    TaskType,
    create_task,
    transition_task,
)
from sidecar.runtime.chat_models import ChatRequestContext, TerminalChatStateError
from sidecar.runtime.turn_state import TURN_STATE_CANCELLED


@dataclass(frozen=True)
class AgentProgressEvent:
    task_id: str
    task_type: str
    source: str
    status: str
    stage: str
    percent: int
    summary: str
    terminal: bool
    success: bool
    terminal_subcode: str | None = None
    agent_id: str | None = None
    parent_agent_id: str | None = None

ProgressCallback = Callable[[AgentProgressEvent], None]


class AgentExecutor:
    """Track one router turn without adding hidden planning model calls."""

    def __init__(
        self,
        *,
        router: ChatRouter,
        on_progress: ProgressCallback | None = None,
        feature_flags: dict[str, bool] | None = None,
    ) -> None:
        self._router = router
        self._on_progress = on_progress
        self._feature_flags = feature_flags or {}
        self._tasks: dict[str, TaskState] = {}

    def execute(  # noqa: PLR0913 - explicit router boundary.
        self,
        *,
        request_context: ChatRequestContext,
        messages: list[dict[str, object]],
        latest_user_content: str,
        learned_lessons: list[LearnedLesson] | None = None,
        canonical_session_messages: list[dict[str, object]] | None = None,
        runtime: Any | None = None,
    ) -> ChatDecision:
        self._tasks = {}
        messages_to_route = messages
        task = create_task(
            TaskType.LOCAL_AGENT,
            description=f"chat request {request_context.request_id}",
            metadata={
                "request_id": request_context.request_id,
                "session_id": request_context.session_id,
                "agent_id": request_context.agent_id or f"main@{request_context.request_id}",
                "parent_agent_id": request_context.parent_agent_id,
                "kind": "chat_request",
                "source": "local_agent",
            },
        )
        self._tasks[task.id] = task
        self._record_progress(
            task,
            stage="task_created",
            percent=5,
            summary="Tracking agent task lifecycle.",
        )
        if is_feature_flag_enabled(self._feature_flags, FEATURE_TASK_LIFECYCLE):
            messages_to_route = ensure_tool_result_pairing(messages)
        transition_task(task, TaskStatus.RUNNING)
        self._record_progress(
            task,
            stage="tool_loop",
            percent=55,
            summary="Running tool loop and gathering outputs.",
        )
        try:
            decision = self._router.build_chat_decision(
                request_context=request_context,
                request_id=request_context.request_id,
                messages=messages_to_route,
                latest_user_content=latest_user_content,
                mode=request_context.mode,
                approvals_pre_granted=request_context.approvals_pre_granted,
                session_id=request_context.session_id,
                learned_lessons=learned_lessons,
                reasoning_effort=request_context.reasoning_effort,
                session_start_date=request_context.session_start_date,
                canonical_session_messages=canonical_session_messages,
                runtime=runtime,
                plan_mode=request_context.plan_mode,
                tool_preferences=request_context.tool_preferences,
            )
        except Exception as error:
            terminal_subcode: str | None = None
            if isinstance(error, TerminalChatStateError) and error.status == TURN_STATE_CANCELLED:
                transition_task(task, TaskStatus.KILLED, error=str(error))
                failure_stage = "cancelled"
                failure_summary = "Agent execution cancelled."
                terminal_subcode = error.terminal_subcode
            else:
                transition_task(task, TaskStatus.FAILED, error=str(error))
                failure_stage = "failed"
                failure_summary = "Agent execution failed."
            self._record_progress(
                task,
                stage=failure_stage,
                percent=100,
                summary=failure_summary,
                terminal_subcode=terminal_subcode,
            )
            raise

        self._record_progress(
            task,
            stage="finalizing",
            percent=90,
            summary="Finalizing response output.",
        )
        transition_task(task, TaskStatus.COMPLETED)
        self._record_progress(
            task,
            stage="complete",
            percent=100,
            summary="Agent execution complete.",
        )
        return decision

    def _record_progress(
        self,
        task: TaskState,
        *,
        stage: str,
        percent: int,
        summary: str,
        terminal_subcode: str | None = None,
    ) -> None:
        metadata = dict(task.metadata)
        metadata.update(
            {
                "stage": stage,
                "percent": percent,
                "summary": summary,
                "success": task.status is TaskStatus.COMPLETED,
                "terminal": task.status
                in {TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.KILLED},
            }
        )
        task.metadata = metadata
        if self._on_progress is None:
            return
        status = (
            "cancelled"
            if task.status is TaskStatus.KILLED and stage == "cancelled"
            else task.status.value
        )
        self._on_progress(
            AgentProgressEvent(
                task_id=task.id,
                task_type=task.type.value,
                source=str(task.metadata.get("source") or task.type.value),
                status=status,
                stage=stage,
                percent=percent,
                summary=summary,
                terminal=task.status
                in {TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.KILLED},
                success=task.status is TaskStatus.COMPLETED,
                terminal_subcode=terminal_subcode,
                agent_id=str(task.metadata.get("agent_id") or "") or None,
                parent_agent_id=str(task.metadata.get("parent_agent_id") or "") or None,
            )
        )


__all__ = ["AgentExecutor", "AgentProgressEvent"]
