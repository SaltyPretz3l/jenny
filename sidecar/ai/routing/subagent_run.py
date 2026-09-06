"""Read-only ``subagent_run`` tool execution and report shaping."""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from typing import Any

from sidecar.ai.error_codes import (
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_SUBAGENT_DEPTH_LIMIT,
    CMP_TOOL_SUBAGENT_INVALID_GRANTS,
    CMP_TOOL_SUBAGENT_INVALID_PROMPT,
    CMP_TOOL_SUBAGENT_MUTATING_REQUIRES_WORKTREE,
)
from sidecar.ai.routing.sub_agent_invocation import (
    INVOCATION_KIND_RESEARCH,
    SUBAGENT_RUNTIME_UNAVAILABLE_MESSAGE,
    SubAgentIdentity,
    SubAgentInvocationResult,
    build_sub_agent_identity,
    invoke_sub_agent,
)
from sidecar.ai.routing.subagent_telemetry import (
    aggregate_usage as _aggregate_usage,
)
from sidecar.ai.routing.subagent_telemetry import (
    parse_sub_agent_report_object,
    selected_route,
    terminal_reason,
    usage_from_decision,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.sanitization import sanitize_tool_output
from sidecar.ai.tools.tool_families import KNOWN_TOOL_FAMILIES
from sidecar.protocol import AGENT_PROGRESS_METHOD
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.rpc import notification

MAX_PROMPT_BYTES = 16_000
MAX_STEPS = 32
DEFAULT_MAX_STEPS = 8
MAX_RUNTIME_MS = 600_000
DEFAULT_MAX_RUNTIME_MS = 120_000
MAX_REPORT_SUMMARY_CHARS = 1_000
MAX_REPORT_FIELD_CHARS = 300
MAX_EVIDENCE_ITEMS = 12
MAX_UNCERTAINTIES = 8
MAX_TOOLS_USED = 20
MAX_TASK_LABEL_CHARS = 80

DEFAULT_ALLOWED_TOOL_FAMILIES = ("filesystem", "git", "code_intelligence")

READ_ONLY_GRANTABLE_FAMILIES = frozenset(DEFAULT_ALLOWED_TOOL_FAMILIES)

MUTATING_TOOL_FAMILIES = frozenset(
    {
        "browser",
        "python",
        "rich_files",
        "shell",
    }
)

SUBAGENT_TOOL_NAME = "subagent_run"
SUBAGENT_INVALID_REPORT_MESSAGE = "Sub-agent returned an invalid or incomplete report."
logger = logging.getLogger(__name__)


def aggregate_usage(task_reports: Any) -> dict[str, Any] | None:
    """Expose aggregate telemetry without widening sibling import fan-out."""

    return _aggregate_usage(task_reports)

READ_ONLY_DISABLED_TOOLS = (
    SUBAGENT_TOOL_NAME,
    "subagent_batch",
    "delegate",
    "worktree_create",
    "worktree_select",
    "worktree_delete",
)


@dataclass(frozen=True)
class SubagentRunRequest:
    """Validated input for a ``subagent_run`` call."""

    prompt: str
    allowed_tool_families: tuple[str, ...]
    max_steps: int
    max_runtime_ms: int
    label: str = "Research subagent"


def validate_subagent_run_arguments(
    arguments: object,
    *,
    parent_agent_depth: int = 0,
) -> SubagentRunRequest:
    """Validate model-supplied ``subagent_run`` arguments."""

    if not isinstance(arguments, dict):
        raise ToolExecutionFailure(
            code=CMP_TOOL_SUBAGENT_INVALID_PROMPT,
            message="subagent_run arguments must be an object",
            retryable=False,
        )

    if parent_agent_depth >= 1:
        raise ToolExecutionFailure(
            code=CMP_TOOL_SUBAGENT_DEPTH_LIMIT,
            message=(
                "subagent_run cannot be invoked from inside another subagent "
                "(depth limit = 1 in v1)"
            ),
            retryable=False,
        )

    ghost_fields = tuple(field for field in ("isolation_mode", "worktree_id") if field in arguments)
    if ghost_fields:
        raise ToolExecutionFailure(
            code=CMP_TOOL_SUBAGENT_INVALID_GRANTS,
            message=(
                "subagent_run is read-only; unsupported fields are not accepted: "
                f"{list(ghost_fields)}"
            ),
            retryable=False,
        )

    prompt_raw = arguments.get("prompt")
    if not isinstance(prompt_raw, str) or not prompt_raw.strip():
        raise ToolExecutionFailure(
            code=CMP_TOOL_SUBAGENT_INVALID_PROMPT,
            message="subagent_run requires a non-empty 'prompt' string",
            retryable=False,
        )
    try:
        prompt_bytes = prompt_raw.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_SUBAGENT_INVALID_PROMPT,
            message="subagent_run prompt must be valid UTF-8",
            retryable=False,
        ) from error
    if len(prompt_bytes) > MAX_PROMPT_BYTES:
        raise ToolExecutionFailure(
            code=CMP_TOOL_SUBAGENT_INVALID_PROMPT,
            message=(
                f"subagent_run prompt exceeds {MAX_PROMPT_BYTES} byte limit "
                f"(received {len(prompt_bytes)})"
            ),
            retryable=False,
        )

    grants = _normalize_allowed_tool_families(arguments.get("allowed_tool_families"))

    max_steps = _bounded_int(
        arguments.get("max_steps"),
        default=DEFAULT_MAX_STEPS,
        minimum=1,
        maximum=MAX_STEPS,
        field="max_steps",
    )
    max_runtime_ms = _bounded_int(
        arguments.get("max_runtime_ms"),
        default=DEFAULT_MAX_RUNTIME_MS,
        minimum=1_000,
        maximum=MAX_RUNTIME_MS,
        field="max_runtime_ms",
    )

    requested_mutating = [grant for grant in grants if grant in MUTATING_TOOL_FAMILIES]
    if requested_mutating:
        raise ToolExecutionFailure(
            code=CMP_TOOL_SUBAGENT_MUTATING_REQUIRES_WORKTREE,
            message=(
                "subagent_run is read-only in this pass; mutating grants require "
                f"a future worktree-isolation phase: {requested_mutating}"
            ),
            retryable=False,
        )

    for grant in grants:
        if grant not in READ_ONLY_GRANTABLE_FAMILIES:
            raise ToolExecutionFailure(
                code=CMP_TOOL_SUBAGENT_INVALID_GRANTS,
                message=f"tool family is not grantable to read-only subagents: {grant!r}",
                retryable=False,
            )

    label = _safe_text(arguments.get("label"), max_chars=MAX_TASK_LABEL_CHARS)
    return SubagentRunRequest(
        prompt=prompt_raw.strip(),
        allowed_tool_families=tuple(grants),
        max_steps=max_steps,
        max_runtime_ms=max_runtime_ms,
        label=label or "Research subagent",
    )


def _normalize_allowed_tool_families(value: object) -> tuple[str, ...]:
    if value is None:
        return DEFAULT_ALLOWED_TOOL_FAMILIES
    if not isinstance(value, list):
        raise ToolExecutionFailure(
            code=CMP_TOOL_SUBAGENT_INVALID_GRANTS,
            message="allowed_tool_families must be a list of strings",
            retryable=False,
        )
    if not value:
        return ()
    grants: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ToolExecutionFailure(
                code=CMP_TOOL_SUBAGENT_INVALID_GRANTS,
                message=(f"allowed_tool_families entries must be non-empty strings (got {item!r})"),
                retryable=False,
            )
        family = item.strip()
        if family not in KNOWN_TOOL_FAMILIES:
            raise ToolExecutionFailure(
                code=CMP_TOOL_SUBAGENT_INVALID_GRANTS,
                message=(
                    f"unknown tool family in allowed_tool_families: {family!r}. "
                    f"Known families: {sorted(KNOWN_TOOL_FAMILIES)}"
                ),
                retryable=False,
            )
        if family not in grants:
            grants.append(family)
    return tuple(grants)


def build_subagent_tool_preferences(
    allowed_tool_families: tuple[str, ...] | list[str],
) -> dict[str, tuple[str, ...]]:
    """Translate validated grants into existing request-scoped tool preferences."""

    allowed = {str(item or "").strip() for item in allowed_tool_families if str(item or "").strip()}
    disabled_families = tuple(sorted(KNOWN_TOOL_FAMILIES - allowed))
    return {
        "disabled_tools": READ_ONLY_DISABLED_TOOLS,
        "disabled_tool_families": disabled_families,
    }


def build_subagent_report(  # noqa: PLR0913 - mirrors the fixed report envelope fields.
    *,
    request: SubagentRunRequest,
    child_decision: Any | None,
    status: str,
    agent_id: str | None,
    parent_agent_id: str | None,
    elapsed_ms: int,
    task_id: str | None = None,
    iterations_used: int = 0,
    tool_results_used: int | None = None,
    observed_tool_names: tuple[str, ...] | list[str] | None = None,
    error: dict[str, Any] | None = None,
    terminal_reason_value: str | None = None,
) -> dict[str, Any]:
    """Return the compact sanitized report exposed to the parent tool result."""

    response_text = str(getattr(child_decision, "response_text", "") or "")
    parsed = parse_sub_agent_report_object(response_text)
    observed_tools = (
        _normalize_tool_names(observed_tool_names)
        if observed_tool_names is not None
        else _observed_tools_used(child_decision)
    )
    observed_tool_results = (
        len(tuple(getattr(child_decision, "tool_results", ()) or ()))
        if tool_results_used is None
        else max(0, int(tool_results_used))
    )
    return {
        "task_id": str(task_id or "").strip() or None,
        "label": request.label,
        "summary": _summary_from_report(parsed, response_text),
        "evidence": _normalize_evidence(parsed.get("evidence") if parsed else None),
        "tools_used": observed_tools,
        "uncertainties": _normalize_string_list(
            parsed.get("uncertainties") if parsed else None,
            max_items=MAX_UNCERTAINTIES,
        ),
        "budget": {
            "max_steps": request.max_steps,
            "iterations_used": min(max(0, int(iterations_used)), request.max_steps),
            "tool_results_used": observed_tool_results,
            "max_runtime_ms": request.max_runtime_ms,
            "elapsed_ms": max(0, int(elapsed_ms)),
        },
        "status": str(status or "").strip() or "completed",
        "agent_id": str(agent_id or "").strip() or None,
        "parent_agent_id": str(parent_agent_id or "").strip() or None,
        "usage": usage_from_decision(child_decision),
        "terminal_reason": terminal_reason_value,
        "error": _normalize_report_error(error),
    }


def execute_subagent_run_tool(  # noqa: PLR0913 - synthetic tool boundary mirrors router inputs.
    *,
    router: Any,
    arguments: dict[str, Any],
    runtime: Any,
    outcome_type: Any,
    visible_tool_arguments: dict[str, object] | None = None,
    call_id: str = "",
) -> Any:
    """Execute a read-only child research agent and return a tool outcome."""

    normalized_call_id = str(call_id or "").strip()
    if not normalized_call_id:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="subagent_run canonical call id is unavailable",
            retryable=False,
        )
    parent_context = getattr(runtime, "request_context", None)
    parent_request_id = str(
        getattr(parent_context, "request_id", "") or getattr(runtime, "request_id", "") or ""
    ).strip()
    if not parent_request_id:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="subagent_run parent request id is unavailable",
            retryable=False,
        )
    identity = build_sub_agent_identity(
        parent_request_id=parent_request_id,
        canonical_call_id=normalized_call_id,
        parent_agent_id=getattr(parent_context, "agent_id", None),
    )
    request = validate_subagent_run_arguments(
        arguments,
        parent_agent_depth=int(getattr(parent_context, "agent_depth", 0) or 0),
    )
    start = time.monotonic()
    _raise_runtime_interrupted(runtime)
    if parent_context is None:
        return _settle_subagent_result(
            runtime=runtime,
            request=request,
            result=_runtime_unavailable_result(identity),
            identity=identity,
            outcome_type=outcome_type,
            arguments=arguments,
            visible_tool_arguments=visible_tool_arguments,
            call_id=normalized_call_id,
            started_at=start,
        )
    slot_allocator = getattr(runtime, "sub_agent_slot_allocator", None)
    if slot_allocator is None:
        return _settle_subagent_result(
            runtime=runtime,
            request=request,
            result=_runtime_unavailable_result(identity),
            identity=identity,
            outcome_type=outcome_type,
            arguments=arguments,
            visible_tool_arguments=visible_tool_arguments,
            call_id=normalized_call_id,
            started_at=start,
        )
    _log_subagent_event(
        runtime,
        identity=identity,
        level=logging.INFO,
        event="ai.router.subagent_run_started",
        status="running",
        iterations_used=0,
        tool_results_used=0,
        error_code=None,
    )
    _emit_subagent_progress(
        runtime,
        identity=identity,
        stage="start",
        status="running",
        percent=5,
        summary="Starting read-only subagent research.",
        terminal=False,
        success=False,
        call_id=normalized_call_id,
        label=request.label,
        route=selected_route(router),
    )
    _emit_subagent_progress(
        runtime,
        identity=identity,
        stage="running",
        status="running",
        percent=50,
        summary="Running read-only subagent research.",
        terminal=False,
        success=False,
        call_id=normalized_call_id,
        label=request.label,
        route=selected_route(router),
    )
    result = invoke_sub_agent(
        router=router,
        parent_context=parent_context,
        messages=[{"role": "user", "content": request.prompt}],
        latest_user_content=request.prompt,
        slot_allocator=slot_allocator,
        runtime=runtime,
        cancel_handle=getattr(runtime, "cancel_handle", None),
        tool_preferences_override=build_subagent_tool_preferences(
            request.allowed_tool_families,
        ),
        iteration_budget_override=request.max_steps,
        max_runtime_ms=request.max_runtime_ms,
        identity=identity,
    )
    _raise_runtime_interrupted(runtime)
    return _settle_subagent_result(
        runtime=runtime,
        request=request,
        result=result,
        identity=identity,
        outcome_type=outcome_type,
        arguments=arguments,
        visible_tool_arguments=visible_tool_arguments,
        call_id=normalized_call_id,
        started_at=start,
    )


def _settle_subagent_result(  # noqa: PLR0913 - fixed synthetic-tool settlement data.
    *,
    runtime: Any,
    request: SubagentRunRequest,
    result: SubAgentInvocationResult,
    identity: SubAgentIdentity,
    outcome_type: Any,
    arguments: dict[str, Any],
    visible_tool_arguments: dict[str, object] | None,
    call_id: str,
    started_at: float,
) -> Any:
    elapsed_ms = max(0, int((time.monotonic() - started_at) * 1000))
    response_text = str(getattr(result.decision, "response_text", "") or result.response_text or "")
    runtime_success = result.status == "completed"
    parsed_report = parse_sub_agent_report_object(response_text)
    invalid_report = runtime_success and parsed_report.get("status") != "completed"
    success = runtime_success and not invalid_report
    error_code = None if success else (result.error_code or CMP_TOOL_EXECUTION_FAILED)
    error = (
        None
        if success
        else {
            "code": error_code,
            "message": (
                SUBAGENT_INVALID_REPORT_MESSAGE
                if invalid_report
                else result.error_message or SUBAGENT_RUNTIME_UNAVAILABLE_MESSAGE
            ),
            "retryable": bool(result.error_retryable),
        }
    )
    settled_reason = terminal_reason(
        completion_reason=result.completion_reason,
        status=result.status,
        invalid_report=invalid_report,
        error_message=(error or {}).get("message"),
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
        terminal_reason_value=settled_reason,
    )
    if not success and not response_text.strip() and error is not None:
        report["summary"] = _safe_text(
            error["message"],
            max_chars=MAX_REPORT_SUMMARY_CHARS,
        )
    terminal_stage = "completed" if success else "failed"
    terminal_summary = (
        "Read-only subagent research completed."
        if success
        else "Read-only subagent research failed."
    )
    _emit_subagent_progress(
        runtime,
        identity=identity,
        stage=terminal_stage,
        status=terminal_stage,
        percent=100,
        summary=terminal_summary,
        terminal=True,
        success=success,
        call_id=call_id,
        label=request.label,
        usage=report.get("usage"),
        terminal_reason_value=settled_reason,
    )
    if invalid_report:
        _log_subagent_event(
            runtime,
            identity=identity,
            level=logging.WARNING,
            event="ai.router.subagent_run_invalid_report",
            status="failed",
            iterations_used=result.iterations_used,
            tool_results_used=result.tool_results_used,
            error_code=CMP_TOOL_EXECUTION_FAILED,
            duration_ms=elapsed_ms,
        )
    _log_subagent_event(
        runtime,
        identity=identity,
        level=logging.INFO if success else logging.WARNING,
        event=("ai.router.subagent_run_completed" if success else "ai.router.subagent_run_failed"),
        status=terminal_stage,
        iterations_used=result.iterations_used,
        tool_results_used=result.tool_results_used,
        error_code=error_code,
        duration_ms=elapsed_ms,
    )
    output = json.dumps(report, sort_keys=True)
    return outcome_type(
        tool_name=SUBAGENT_TOOL_NAME,
        output=output,
        success=success,
        tool_input=visible_tool_arguments or dict(arguments),
        content_type="application/json",
        error_code=error_code,
        metadata={
            "result_kind": "subagent_report",
            "subagent_report": report,
            "allowed_tool_families": list(request.allowed_tool_families),
            "invocation_kind": INVOCATION_KIND_RESEARCH,
        },
        call_id=call_id,
    )


def _runtime_unavailable_result(identity: SubAgentIdentity) -> SubAgentInvocationResult:
    return SubAgentInvocationResult(
        status="failed",
        agent_id=identity.agent_id,
        parent_agent_id=identity.parent_agent_id,
        error_code=CMP_TOOL_EXECUTION_FAILED,
        error_message=SUBAGENT_RUNTIME_UNAVAILABLE_MESSAGE,
        error_retryable=False,
    )


def _raise_runtime_interrupted(runtime: Any) -> None:
    raise_if_interrupted = getattr(runtime, "raise_if_interrupted", None)
    if callable(raise_if_interrupted):
        raise_if_interrupted(message="subagent deadline exceeded")
        return
    cancel_handle = getattr(runtime, "cancel_handle", None)
    if cancel_handle is not None:
        cancel_handle.raise_if_cancelled()


def _emit_subagent_progress(  # noqa: PLR0913 - agent.progress payload is fixed.
    runtime: Any,
    *,
    identity: SubAgentIdentity,
    stage: str,
    status: str,
    percent: int,
    summary: str,
    terminal: bool,
    success: bool,
    call_id: str = "",
    label: str = "Research subagent",
    route: dict[str, str] | None = None,
    usage: dict[str, Any] | None = None,
    terminal_reason_value: str | None = None,
) -> None:
    writer = getattr(runtime, "notification_writer", None)
    if not callable(writer):
        return
    request_id = str(getattr(runtime, "request_id", "") or "").strip()
    session_id = str(getattr(runtime, "session_id", "") or "").strip()
    trace_id = str(getattr(runtime, "trace_id", "") or "").strip()
    payload: dict[str, Any] = {
        "request_id": request_id,
        "trace_id": trace_id,
        "session_id": session_id,
        "task_id": identity.invocation_id,
        "task_type": "sub_agent",
        "source": SUBAGENT_TOOL_NAME,
        "status": status,
        "stage": stage,
        "percent": max(0, min(100, int(percent))),
        "summary": sanitize_tool_output(summary, max_chars=160, tool_name=SUBAGENT_TOOL_NAME),
        "message": sanitize_tool_output(summary, max_chars=160, tool_name=SUBAGENT_TOOL_NAME),
        "terminal": bool(terminal),
        "success": bool(success),
        "agent_id": identity.agent_id,
        "parent_agent_id": identity.parent_agent_id,
        "tool_call_id": str(call_id or "").strip() or None,
        "child_task_id": identity.task_id,
        "child_agent_id": identity.agent_id,
        "child_ordinal": 1,
        "child_count": 1,
        "child_label": _safe_text(label, max_chars=MAX_TASK_LABEL_CHARS),
        "child_terminal": bool(terminal),
        "child_success": bool(success),
    }
    route_values = route or {}
    if route_values.get("model"):
        payload["model"] = route_values["model"]
    if route_values.get("provider"):
        payload["provider"] = route_values["provider"]
    if usage:
        payload["usage"] = usage
        if usage.get("model"):
            payload["model"] = usage["model"]
        if usage.get("provider"):
            payload["provider"] = usage["provider"]
    if terminal_reason_value:
        payload["terminal_reason"] = terminal_reason_value
    try:
        writer(notification(AGENT_PROGRESS_METHOD, payload))
    except Exception:  # noqa: BLE001 - progress is advisory and best-effort.
        _log_subagent_event(
            runtime,
            identity=identity,
            level=logging.WARNING,
            event="ai.router.subagent_progress_write_failed",
            status="degraded",
            iterations_used=0,
            tool_results_used=0,
            error_code=None,
        )


def _log_subagent_event(  # noqa: PLR0913 - fixed structured diagnostic fields.
    runtime: Any,
    *,
    identity: SubAgentIdentity,
    level: int,
    event: str,
    status: str,
    iterations_used: int,
    tool_results_used: int,
    error_code: str | None,
    duration_ms: int | None = None,
) -> None:
    data: dict[str, Any] = {
        "invocation_id": identity.invocation_id,
        "task_id": identity.task_id,
        "agent_id": identity.agent_id,
        "parent_agent_id": identity.parent_agent_id,
        "iterations_used": max(0, int(iterations_used)),
        "tool_results_used": max(0, int(tool_results_used)),
        "error_code": str(error_code or "").strip() or None,
        "allocator": _safe_allocator_snapshot(runtime),
    }
    log_event(
        logger,
        level,
        component="ai.routing.subagent_run",
        event=event,
        message="Sub-agent run lifecycle update.",
        status=status,
        duration_ms=duration_ms,
        data=data,
        request_id=str(getattr(runtime, "request_id", "") or "").strip() or None,
        trace_id=str(getattr(runtime, "trace_id", "") or "").strip() or None,
        session_id=str(getattr(runtime, "session_id", "") or "").strip() or None,
    )


def _safe_allocator_snapshot(runtime: Any) -> dict[str, int] | None:
    allocator = getattr(runtime, "sub_agent_slot_allocator", None)
    snapshot = getattr(allocator, "snapshot", None)
    if not callable(snapshot):
        return None
    try:
        raw = snapshot()
        if not isinstance(raw, dict):
            return None
        return {
            key: max(0, int(raw.get(key, 0) or 0))
            for key in (
                "active_sub_agents",
                "max_active_sub_agents",
                "max_sub_agents_per_parent",
                "active_parent_count",
            )
        }
    except Exception:  # noqa: BLE001 - diagnostics cannot affect tool truth.
        return None


def _normalize_report_error(value: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    code = _safe_text(value.get("code"), max_chars=64)
    message = _safe_text(value.get("message"), max_chars=MAX_REPORT_FIELD_CHARS)
    if not code or not message:
        return None
    return {
        "code": code,
        "message": message,
        "retryable": value.get("retryable") is True,
    }


def _safe_text(value: Any, *, max_chars: int = MAX_REPORT_FIELD_CHARS) -> str:
    return sanitize_tool_output(value, max_chars=max_chars, tool_name=SUBAGENT_TOOL_NAME).strip()


def _summary_from_report(parsed: dict[str, Any], response_text: str) -> str:
    summary = _safe_text(parsed.get("summary"), max_chars=MAX_REPORT_SUMMARY_CHARS)
    if summary:
        return summary
    fallback_lines = [
        line.strip() for line in str(response_text or "").splitlines() if line.strip()
    ]
    if not fallback_lines:
        return "Subagent completed without a summary."
    return _safe_text(fallback_lines[0], max_chars=MAX_REPORT_SUMMARY_CHARS)


def _normalize_evidence(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    evidence: list[dict[str, str]] = []
    for item in value:
        if len(evidence) >= MAX_EVIDENCE_ITEMS:
            break
        if isinstance(item, str):
            summary = _safe_text(item)
            if summary:
                evidence.append({"summary": summary})
            continue
        if not isinstance(item, dict):
            continue
        record: dict[str, str] = {}
        for key in ("source", "path", "quote", "summary"):
            text = _safe_text(item.get(key))
            if text:
                record[key] = text
        if record:
            evidence.append(record)
    return evidence


def _normalize_string_list(value: Any, *, max_items: int) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        if len(result) >= max_items:
            break
        text = _safe_text(item)
        if text:
            result.append(text)
    return result


def _observed_tools_used(child_decision: Any | None) -> list[str]:
    return _normalize_tool_names(
        getattr(outcome, "tool_name", "")
        for outcome in tuple(getattr(child_decision, "tool_results", ()) or ())
    )


def _normalize_tool_names(values: Any) -> list[str]:
    names: list[str] = []
    for value in tuple(values or ()):
        name = _safe_text(value)
        if name and name not in names:
            names.append(name)
        if len(names) >= MAX_TOOLS_USED:
            break
    return names


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
    if not isinstance(value, int) or isinstance(value, bool):
        raise ToolExecutionFailure(
            code=CMP_TOOL_SUBAGENT_INVALID_GRANTS,
            message=f"{field} must be an integer",
            retryable=False,
        )
    if value < minimum or value > maximum:
        raise ToolExecutionFailure(
            code=CMP_TOOL_SUBAGENT_INVALID_GRANTS,
            message=f"{field} must be between {minimum} and {maximum}",
            retryable=False,
        )
    return value
