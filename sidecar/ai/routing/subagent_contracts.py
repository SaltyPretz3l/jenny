"""Shared validation and result shaping for bounded sub-agent tools."""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from typing import Any

from sidecar.ai.error_codes import (
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_SUBAGENT_BUDGET_EXCEEDED,
    CMP_TOOL_SUBAGENT_DEPTH_LIMIT,
    CMP_TOOL_SUBAGENT_INVALID_GRANTS,
    CMP_TOOL_SUBAGENT_INVALID_PROMPT,
)
from sidecar.ai.routing.iteration_limits import parse_sub_agent_report_object
from sidecar.ai.routing.sub_agent_invocation import (
    SUBAGENT_CAPACITY_UNAVAILABLE_MESSAGE,
    SUBAGENT_RUNTIME_UNAVAILABLE_MESSAGE,
    SubAgentIdentity,
    SubAgentInvocationResult,
)
from sidecar.ai.routing.subagent_run import (
    DEFAULT_ALLOWED_TOOL_FAMILIES,
    SUBAGENT_INVALID_REPORT_MESSAGE,
    SubagentRunRequest,
    aggregate_usage,
    build_subagent_report,
    terminal_reason,
    validate_subagent_run_arguments,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.sanitization import sanitize_tool_output

SUBAGENT_BATCH_TOOL_NAME = "subagent_batch"
MAX_BATCH_TASKS = 3
MAX_BATCH_PROMPT_BYTES = 32_000
MAX_BATCH_OUTPUT_CHARS = 24_000
MAX_TASK_LABEL_CHARS = 80
DEFAULT_TASK_MAX_STEPS = 6
MAX_TASK_MAX_STEPS = 16
DEFAULT_TASK_MAX_RUNTIME_MS = 90_000
MAX_TASK_MAX_RUNTIME_MS = 300_000
DEFAULT_MAX_TOTAL_STEPS = 18
MAX_TOTAL_STEPS = 32
DEFAULT_MAX_TOTAL_RUNTIME_MS = 240_000
MAX_TOTAL_RUNTIME_MS = 600_000
EVIDENCE_TRUST_MODEL_REPORTED = "model_reported_unverified"

_TOP_LEVEL_FIELDS = frozenset({"tasks", "max_total_steps", "max_total_runtime_ms"})
_TASK_FIELDS = frozenset(
    {"label", "prompt", "allowed_tool_families", "max_steps", "max_runtime_ms"}
)


@dataclass(frozen=True)
class SubagentBatchTask:
    ordinal: int
    label: str
    request: SubagentRunRequest | None = None
    error: dict[str, Any] | None = None


@dataclass(frozen=True)
class SubagentBatchRequest:
    tasks: tuple[SubagentBatchTask, ...]
    max_total_steps: int
    max_total_runtime_ms: int


@dataclass(frozen=True)
class SubagentBatchSettlement:
    report: dict[str, Any]
    output: str
    status: str
    success: bool
    error_code: str | None


def validate_subagent_batch_arguments(
    arguments: object,
    *,
    parent_agent_depth: int = 0,
) -> SubagentBatchRequest:
    """Validate the full envelope while settling task-local errors independently."""

    if not isinstance(arguments, dict):
        raise _failure(CMP_TOOL_SUBAGENT_INVALID_PROMPT, "arguments must be an object")
    if parent_agent_depth >= 1:
        raise ToolExecutionFailure(
            code=CMP_TOOL_SUBAGENT_DEPTH_LIMIT,
            message="subagent_batch cannot run inside another subagent (depth limit = 1)",
            retryable=False,
        )
    unknown = sorted(str(field) for field in arguments if field not in _TOP_LEVEL_FIELDS)
    if unknown:
        raise _failure(CMP_TOOL_SUBAGENT_INVALID_GRANTS, f"unsupported fields: {unknown}")
    raw_tasks = arguments.get("tasks")
    if not isinstance(raw_tasks, list) or not 1 <= len(raw_tasks) <= MAX_BATCH_TASKS:
        raise _failure(
            CMP_TOOL_SUBAGENT_INVALID_PROMPT,
            f"between 1 and {MAX_BATCH_TASKS} tasks are required",
        )
    if sum(_prompt_byte_length(task) for task in raw_tasks) > MAX_BATCH_PROMPT_BYTES:
        raise _failure(
            CMP_TOOL_SUBAGENT_INVALID_PROMPT,
            f"prompts exceed the {MAX_BATCH_PROMPT_BYTES} byte aggregate limit",
        )
    return SubagentBatchRequest(
        tasks=tuple(
            _validate_batch_task(task, ordinal=ordinal)
            for ordinal, task in enumerate(raw_tasks, start=1)
        ),
        max_total_steps=_bounded_int(
            arguments.get("max_total_steps"),
            default=DEFAULT_MAX_TOTAL_STEPS,
            minimum=1,
            maximum=MAX_TOTAL_STEPS,
            field="max_total_steps",
        ),
        max_total_runtime_ms=_bounded_int(
            arguments.get("max_total_runtime_ms"),
            default=DEFAULT_MAX_TOTAL_RUNTIME_MS,
            minimum=1_000,
            maximum=MAX_TOTAL_RUNTIME_MS,
            field="max_total_runtime_ms",
        ),
    )


def build_settled_task_report(
    *,
    task: SubagentBatchTask,
    request: SubagentRunRequest,
    identity: SubAgentIdentity,
    result: SubAgentInvocationResult,
    elapsed_ms: int,
) -> tuple[dict[str, Any], bool]:
    response_text = str(getattr(result.decision, "response_text", "") or result.response_text or "")
    runtime_success = result.status == "completed"
    parsed_report = parse_sub_agent_report_object(response_text)
    invalid_report = runtime_success and parsed_report.get("status") != "completed"
    success = runtime_success and not invalid_report
    error = (
        None
        if success
        else (
            _error(CMP_TOOL_EXECUTION_FAILED, SUBAGENT_INVALID_REPORT_MESSAGE, False)
            if invalid_report
            else invocation_error(result)
        )
    )
    report = build_subagent_report(
        request=request,
        child_decision=result.decision,
        status="completed" if success else "failed",
        task_id=identity.task_id,
        agent_id=result.agent_id or identity.agent_id,
        parent_agent_id=result.parent_agent_id or identity.parent_agent_id,
        elapsed_ms=elapsed_ms,
        iterations_used=result.iterations_used,
        tool_results_used=result.tool_results_used,
        observed_tool_names=result.observed_tool_names,
        error=error,
        terminal_reason_value=terminal_reason(
            completion_reason=result.completion_reason,
            status=result.status,
            invalid_report=invalid_report,
            error_message=(error or {}).get("message"),
        ),
    )
    if error is not None and not invalid_report:
        report["summary"] = safe_batch_text(error["message"], max_chars=1_000)
    return _batch_task_shape(task, report), invalid_report


def build_unstarted_task_report(
    *,
    task: SubagentBatchTask,
    identity: SubAgentIdentity,
    status: str,
    error: dict[str, Any],
) -> dict[str, Any]:
    request = task.request or SubagentRunRequest(
        prompt="",
        allowed_tool_families=DEFAULT_ALLOWED_TOOL_FAMILIES,
        max_steps=DEFAULT_TASK_MAX_STEPS,
        max_runtime_ms=DEFAULT_TASK_MAX_RUNTIME_MS,
        label=task.label,
    )
    report = build_subagent_report(
        request=request,
        child_decision=None,
        status=status,
        task_id=identity.task_id,
        agent_id=identity.agent_id,
        parent_agent_id=identity.parent_agent_id,
        elapsed_ms=0,
        error=error,
        terminal_reason_value=terminal_reason(
            status=status,
            error_message=error.get("message"),
        ),
    )
    report["summary"] = safe_batch_text(error["message"], max_chars=1_000)
    return _batch_task_shape(task, report)


def build_batch_settlement(  # noqa: PLR0913 - aggregate counters are explicit contract fields.
    *,
    request: SubagentBatchRequest,
    batch_id: str,
    task_reports: list[dict[str, Any]],
    tasks_started: int,
    tasks_completed: int,
    iterations_used: int,
    tool_results_used: int,
    elapsed_ms: int,
    effective_max_total_runtime_ms: int | None = None,
    parent_synthesis_reserve_ms: int = 0,
) -> SubagentBatchSettlement:
    status = _batch_status(task_reports, tasks_completed)
    report = {
        "result_kind": "subagent_batch_report",
        "batch_id": batch_id,
        "status": status,
        "tasks": task_reports,
        "usage": aggregate_usage(task_reports),
        "budget": {
            "max_tasks": MAX_BATCH_TASKS,
            "tasks_requested": len(request.tasks),
            "tasks_started": max(0, tasks_started),
            "tasks_completed": max(0, tasks_completed),
            "max_total_steps": request.max_total_steps,
            "iterations_used": min(max(0, iterations_used), request.max_total_steps),
            "tool_results_used": max(0, tool_results_used),
            "max_total_runtime_ms": request.max_total_runtime_ms,
            "effective_max_total_runtime_ms": min(
                request.max_total_runtime_ms,
                max(
                    0,
                    int(
                        request.max_total_runtime_ms
                        if effective_max_total_runtime_ms is None
                        else effective_max_total_runtime_ms
                    ),
                ),
            ),
            "parent_synthesis_reserve_ms": max(0, int(parent_synthesis_reserve_ms)),
            "elapsed_ms": max(0, elapsed_ms),
        },
    }
    bounded, output = _bound_aggregate_report(report)
    success = tasks_completed > 0
    return SubagentBatchSettlement(
        report=bounded,
        output=output,
        status=status,
        success=success,
        error_code=None if success else _first_error_code(bounded["tasks"]),
    )


def failure_error(error: ToolExecutionFailure) -> dict[str, Any]:
    return {
        "code": safe_batch_text(error.code, max_chars=64) or CMP_TOOL_EXECUTION_FAILED,
        "message": safe_batch_text(error.message, max_chars=300) or "Sub-agent task rejected.",
        "retryable": bool(error.retryable),
    }


def invocation_error(result: SubAgentInvocationResult) -> dict[str, Any]:
    return {
        "code": safe_batch_text(result.error_code, max_chars=64) or CMP_TOOL_EXECUTION_FAILED,
        "message": (
            safe_batch_text(result.error_message, max_chars=300)
            or SUBAGENT_RUNTIME_UNAVAILABLE_MESSAGE
        ),
        "retryable": bool(result.error_retryable),
    }


def runtime_unavailable_error() -> dict[str, Any]:
    return _error(CMP_TOOL_EXECUTION_FAILED, SUBAGENT_RUNTIME_UNAVAILABLE_MESSAGE, False)


def capacity_unavailable_error() -> dict[str, Any]:
    return _error(CMP_TOOL_EXECUTION_FAILED, SUBAGENT_CAPACITY_UNAVAILABLE_MESSAGE, True)


def budget_exhausted_error() -> dict[str, Any]:
    return _error(
        CMP_TOOL_SUBAGENT_BUDGET_EXCEEDED,
        "Sub-agent batch budget exhausted before this task started.",
        False,
    )


def cancelled_error() -> dict[str, Any]:
    return _error(
        CMP_TOOL_EXECUTION_FAILED,
        "Sub-agent batch cancelled by parent.",
        False,
    )


def safe_batch_text(value: Any, *, max_chars: int) -> str:
    return sanitize_tool_output(
        value,
        max_chars=max_chars,
        tool_name=SUBAGENT_BATCH_TOOL_NAME,
    ).strip()


def _validate_batch_task(raw_task: object, *, ordinal: int) -> SubagentBatchTask:
    label = f"Task {ordinal}"
    try:
        if not isinstance(raw_task, dict):
            raise _failure(CMP_TOOL_SUBAGENT_INVALID_PROMPT, f"task {ordinal} must be an object")
        unknown = sorted(str(field) for field in raw_task if field not in _TASK_FIELDS)
        if unknown:
            raise _failure(
                CMP_TOOL_SUBAGENT_INVALID_GRANTS,
                f"task {ordinal} contains unsupported fields: {unknown}",
            )
        label = _validated_label(raw_task.get("label"), ordinal)
        _require_utf8_prompt(raw_task.get("prompt"), ordinal)
        request = validate_subagent_run_arguments(
            {
                "label": label,
                "prompt": raw_task.get("prompt"),
                "allowed_tool_families": raw_task.get("allowed_tool_families"),
                "max_steps": _bounded_int(
                    raw_task.get("max_steps"),
                    default=DEFAULT_TASK_MAX_STEPS,
                    minimum=1,
                    maximum=MAX_TASK_MAX_STEPS,
                    field=f"tasks[{ordinal - 1}].max_steps",
                ),
                "max_runtime_ms": _bounded_int(
                    raw_task.get("max_runtime_ms"),
                    default=DEFAULT_TASK_MAX_RUNTIME_MS,
                    minimum=1_000,
                    maximum=MAX_TASK_MAX_RUNTIME_MS,
                    field=f"tasks[{ordinal - 1}].max_runtime_ms",
                ),
            }
        )
        return SubagentBatchTask(ordinal=ordinal, label=label, request=request)
    except ToolExecutionFailure as error:
        return SubagentBatchTask(ordinal=ordinal, label=label, error=failure_error(error))


def _batch_task_shape(task: SubagentBatchTask, report: dict[str, Any]) -> dict[str, Any]:
    return {
        "task_id": report["task_id"],
        "ordinal": task.ordinal,
        "label": task.label,
        "agent_id": report["agent_id"],
        "parent_agent_id": report["parent_agent_id"],
        "status": report["status"],
        "summary": report["summary"],
        "evidence": report["evidence"],
        "evidence_trust": EVIDENCE_TRUST_MODEL_REPORTED,
        "tools_used": [
            safe_batch_text(name, max_chars=64)
            for name in report["tools_used"]
            if str(name).strip()
        ],
        "uncertainties": report["uncertainties"],
        "budget": report["budget"],
        "usage": report["usage"],
        "terminal_reason": report["terminal_reason"],
        "error": report["error"],
    }


def _batch_status(task_reports: list[dict[str, Any]], completed: int) -> str:
    if any(task["status"] == "cancelled" for task in task_reports):
        return "cancelled"
    if completed == len(task_reports) and all(
        task["status"] == "completed" for task in task_reports
    ):
        return "completed"
    return "partial" if completed else "failed"


def _bound_aggregate_report(report: dict[str, Any]) -> tuple[dict[str, Any], str]:
    bounded = copy.deepcopy(report)
    output = _serialize(bounded)
    if len(output) <= MAX_BATCH_OUTPUT_CHARS:
        return bounded, output
    for field in ("evidence", "uncertainties", "tools_used"):
        for task in reversed(bounded["tasks"]):
            values = task[field]
            while values:
                values.pop()
                output = _serialize(bounded)
                if len(output) <= MAX_BATCH_OUTPUT_CHARS:
                    return bounded, output
    for task in reversed(bounded["tasks"]):
        task["summary"] = _truncate(task["summary"], 160)
        output = _serialize(bounded)
        if len(output) <= MAX_BATCH_OUTPUT_CHARS:
            return bounded, output
    for task in bounded["tasks"]:
        task["label"] = _truncate(task["label"], 40)
        task["summary"] = _truncate(task["summary"], 80)
        if isinstance(task["error"], dict):
            task["error"]["message"] = _truncate(task["error"].get("message"), 80)
    output = _serialize(bounded)
    if len(output) > MAX_BATCH_OUTPUT_CHARS:
        for task in bounded["tasks"]:
            task.update(evidence=[], uncertainties=[], tools_used=[], summary="")
        output = _serialize(bounded)
    return bounded, output


def _serialize(report: dict[str, Any]) -> str:
    return json.dumps(report, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _first_error_code(tasks: list[dict[str, Any]]) -> str:
    for task in tasks:
        error = task.get("error")
        if isinstance(error, dict) and str(error.get("code") or "").strip():
            return str(error["code"]).strip()
    return CMP_TOOL_EXECUTION_FAILED


def _validated_label(value: object, ordinal: int) -> str:
    if value is None or (isinstance(value, str) and not value.strip()):
        return f"Task {ordinal}"
    if not isinstance(value, str) or len(value.strip()) > MAX_TASK_LABEL_CHARS:
        raise _failure(
            CMP_TOOL_SUBAGENT_INVALID_GRANTS,
            f"task {ordinal} label must be a string of at most {MAX_TASK_LABEL_CHARS} characters",
        )
    return safe_batch_text(value, max_chars=MAX_TASK_LABEL_CHARS) or f"Task {ordinal}"


def _require_utf8_prompt(value: object, ordinal: int) -> None:
    if not isinstance(value, str):
        return
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise _failure(
            CMP_TOOL_SUBAGENT_INVALID_PROMPT,
            f"task {ordinal} prompt must be valid UTF-8",
        ) from error


def _prompt_byte_length(raw_task: object) -> int:
    if not isinstance(raw_task, dict) or not isinstance(raw_task.get("prompt"), str):
        return 0
    try:
        return len(raw_task["prompt"].encode("utf-8"))
    except UnicodeEncodeError:
        return 0


def _bounded_int(
    value: object,
    *,
    default: int,
    minimum: int,
    maximum: int,
    field: str,
) -> int:
    if value is None:
        return default
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise _failure(
            CMP_TOOL_SUBAGENT_INVALID_GRANTS,
            f"{field} must be an integer between {minimum} and {maximum}",
        )
    return value


def _failure(code: str, message: str) -> ToolExecutionFailure:
    return ToolExecutionFailure(
        code=code,
        message=f"subagent_batch {message}",
        retryable=False,
    )


def _error(code: str, message: str, retryable: bool) -> dict[str, Any]:
    return {"code": code, "message": message, "retryable": retryable}


def _truncate(value: object, limit: int) -> str:
    text = str(value or "")
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


__all__ = [
    "MAX_BATCH_OUTPUT_CHARS",
    "SUBAGENT_BATCH_TOOL_NAME",
    "SubagentBatchRequest",
    "SubagentBatchSettlement",
    "SubagentBatchTask",
    "budget_exhausted_error",
    "build_batch_settlement",
    "build_settled_task_report",
    "build_unstarted_task_report",
    "cancelled_error",
    "capacity_unavailable_error",
    "runtime_unavailable_error",
    "safe_batch_text",
    "validate_subagent_batch_arguments",
]
