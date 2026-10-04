"""Final dispatch boundary for builtin, Electron, and external MCP tools."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, Callable

from sidecar.ai.error_codes import CMP_TOOL_DISABLED, CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.host_policy import HOST_EXECUTION_POLICY_VERSION
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.routing.tool_authority import admit_scoped_tool_call
from sidecar.ai.tools.contracts import ToolExecutionFailure

_PROCESS_BACKED_BUILTINS = frozenset({
    "git_diff", "git_log", "git_show", "git_status", "monitor", "run_command",
    "run_temp_script", "workspace_change_baseline", "workspace_change_delta",
    "workspace_manifest_read",
})
_ELECTRON_RESOURCE_START_TOOLS = frozenset({
    "jenny_status", "worktree_list", "worktree_create", "worktree_select", "worktree_delete",
    "automation_list", "automation_read", "workspace_present", "preview_test",
    "home", "task_board", "verify", "image_generate", "run_command",
})
_CLEANUP_FIELDS = frozenset({
    "cleanup", "output_readers_terminated", "process_tree_terminated", "reason",
})
_MAX_CLEANUP_REASON_CHARS = 200
_NO_PROCESS_STARTED = "no_native_process_started"
_BACKGROUND_JOB_ID = re.compile(r"^[0-9a-f]{12}$")


def _acquire_builtin_resource(
    *, runtime: Any, call: Any, arguments: dict[str, Any],
    timeout_seconds: float | None,
) -> Any:
    admission = getattr(runtime, "operation_admission", None)
    acquire = getattr(admission, "acquire_resource", None)
    if not callable(acquire):
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="runtime tool resource authority bridge is unavailable",
            retryable=False,
        )
    return acquire(
        operation_id=str(call.call_id or "").strip(),
        tool_name=call.tool_id,
        arguments=dict(arguments),
        timeout_seconds=timeout_seconds,
    )


def _background_job_handed_off(arguments: dict[str, Any], result: Any) -> bool:
    """A started background job is owned by the background-job registry.

    Owner decision 2026-09-28 (dogfood HB-008): once the start receipt carries
    the job id and the spawned pid (Electron's background-job tracker binds its
    kill authority to that pid, the sidecar waiter enforces the job timeout and
    the background slot cap, and app exit ends the job), the call's workspace
    lease is released instead of staying quarantined for the rest of the turn.
    """
    if arguments.get("run_in_background") is not True or not getattr(result, "success", False):
        return False
    metadata = getattr(result, "metadata", None)
    if not isinstance(metadata, Mapping):
        return False
    job_id = metadata.get("background_job_id")
    pid = metadata.get("background_job_pid")
    return (
        isinstance(job_id, str) and _BACKGROUND_JOB_ID.fullmatch(job_id) is not None
        and isinstance(pid, int) and not isinstance(pid, bool) and pid > 0
    )


def _cleanup_for_result(
    tool_name: str, arguments: dict[str, Any], result: Any,
) -> str:
    if tool_name not in _PROCESS_BACKED_BUILTINS:
        return "confirmed"
    if tool_name == "run_command" and _background_job_handed_off(arguments, result):
        return "confirmed"
    metadata = getattr(result, "metadata", None)
    evidence = metadata.get("resource_cleanup") if isinstance(metadata, Mapping) else None
    return _cleanup_from_evidence(tool_name, arguments, evidence)


def _proves_no_process_started(evidence: object) -> bool:
    return (
        isinstance(evidence, Mapping) and set(evidence) == _CLEANUP_FIELDS
        and evidence.get("cleanup") == "confirmed"
        and evidence.get("process_tree_terminated") is True
        and evidence.get("output_readers_terminated") is True
        and evidence.get("reason") == _NO_PROCESS_STARTED
    )


def _cleanup_from_evidence(
    tool_name: str, arguments: dict[str, Any], evidence: object,
    *, failed_before_launch_counts: bool = False,
) -> str:
    if tool_name == "monitor" or (
        tool_name == "run_command" and arguments.get("run_in_background") is True
    ):
        # A started background job outlives the call. A background start that
        # failed with the server's zero-child proof never launched one (HB-014).
        if (
            failed_before_launch_counts and tool_name == "run_command"
            and _proves_no_process_started(evidence)
        ):
            return "confirmed"
        return "uncertain"
    if not isinstance(evidence, Mapping) or set(evidence) != _CLEANUP_FIELDS:
        return "uncertain"
    cleanup = evidence.get("cleanup")
    tree_terminated = evidence.get("process_tree_terminated")
    readers_terminated = evidence.get("output_readers_terminated")
    reason = evidence.get("reason")
    if (
        cleanup not in {"confirmed", "uncertain"}
        or not isinstance(tree_terminated, bool)
        or not isinstance(readers_terminated, bool)
        or (
            reason is not None
            and (
                not isinstance(reason, str)
                or len(reason) > _MAX_CLEANUP_REASON_CHARS
            )
        )
    ):
        return "uncertain"
    if cleanup == "confirmed" and not (tree_terminated and readers_terminated):
        return "uncertain"
    return str(cleanup)


def _settle_resource(
    lease: Any, *, status: str, cleanup: str, logger: Any,
) -> None:
    try:
        lease.settle(status, cleanup)
    except ToolExecutionFailure as error:
        warning = getattr(logger, "warning", None)
        if callable(warning):
            warning("tool resource settlement failed: %s", error.message)


def _dispatch_ready(callback: Callable[[], None] | None) -> None:
    if callable(callback):
        callback()


def dispatch_tool_call(  # noqa: PLR0913
    *, kernel: Any, call: Any, tool_arguments: dict[str, Any], descriptor: Any,
    request_id: str, session_id: str | None, runtime: Any,
    timeout_seconds: float | None, cancel_handle: Any, on_output_chunk: Any,
    admission_arguments: dict[str, Any], builtin_server_name: str,
    electron_server_name: str, electron_request_type: Any,
    electron_executor: Callable[[Any], Any], logger: Any,
    on_dispatch_ready: Callable[[], None] | None = None,
    decision_snapshot: Any = None,
) -> Any:
    if (
        call.tool_id == "run_command"
        and str(getattr(kernel._config, "host_mode", "") or "") == "server"
        and int(getattr(kernel._config, "host_execution_policy_version", 0) or 0)
        == HOST_EXECUTION_POLICY_VERSION
        and getattr(descriptor, "server_name", "") != electron_server_name
    ):
        raise ToolExecutionFailure(
            code=CMP_TOOL_DISABLED,
            message="hosted run_command requires the Electron execution worker bridge",
            retryable=False,
        )
    admit_scoped_tool_call(
        runtime=runtime, call=call, descriptor=descriptor,
        tool_arguments=tool_arguments, visible_arguments=admission_arguments,
        builtin_server_name=builtin_server_name, timeout_seconds=timeout_seconds,
    )
    dispatch_kwargs = {"on_output_chunk": on_output_chunk} if on_output_chunk else {}
    if descriptor is not None and getattr(descriptor, "server_name", "") == electron_server_name:
        request_context = getattr(runtime, "request_context", None)
        if call.tool_id == "run_command":
            tool_arguments = {
                key: value for key, value in tool_arguments.items()
                if not key.startswith("_jenny_")
            }
        resource_start = (
            on_dispatch_ready if call.tool_id in _ELECTRON_RESOURCE_START_TOOLS
            and callable(getattr(runtime, "continuation_checkpoint", None))
            and getattr(request_context, "execution_context", None) is not None else None
        )
        if resource_start is None:
            _dispatch_ready(on_dispatch_ready)
        return electron_executor(electron_request_type(
            tool_name=call.tool_id, arguments=tool_arguments, request_id=request_id,
            trace_id=getattr(runtime, "trace_id", None), session_id=session_id,
            tool_call_id=str(call.call_id or "").strip(),
            write_message=getattr(runtime, "electron_tool_writer", None),
            read_message=getattr(runtime, "electron_tool_reader", None),
            response_reader_factory=getattr(runtime, "electron_tool_reader_factory", None),
            timeout_seconds=timeout_seconds, logger=logger, cancel_handle=cancel_handle,
            plan_mode=bool(getattr(request_context, "plan_mode", False)),
            read_only=bool(getattr(request_context, "read_only", False)),
            decision_snapshot=decision_snapshot,
            before_resource_start=resource_start,
            plan_decision=str(getattr(request_context, "plan_decision", "") or ""),
            plan_feedback=str(getattr(request_context, "plan_feedback", "") or "")[:800],
            edited_plan=(
                getattr(request_context, "edited_plan", None)
                if call.tool_id == "exit_plan_mode" else None
            ),
        ))
    if descriptor is None or getattr(descriptor, "server_name", "") != builtin_server_name:
        _dispatch_ready(on_dispatch_ready)
        return kernel._mcp_client.execute_tool(
            call.tool_id, tool_arguments, timeout_seconds=timeout_seconds,
            cancel_handle=cancel_handle, **dispatch_kwargs,
        )
    request_context = getattr(runtime, "request_context", None)
    if getattr(request_context, "execution_context", None) is None:
        _dispatch_ready(on_dispatch_ready)
        return kernel._mcp_client.execute_tool(
            call.tool_id, tool_arguments, timeout_seconds=timeout_seconds,
            cancel_handle=cancel_handle, **dispatch_kwargs,
        )
    lease = _acquire_builtin_resource(
        runtime=runtime, call=call, arguments=admission_arguments,
        timeout_seconds=timeout_seconds,
    )
    try:
        _dispatch_ready(on_dispatch_ready)
    except BaseException:
        cancelled = bool(getattr(cancel_handle, "cancelled", False))
        _settle_resource(
            lease, status="cancelled" if cancelled else "failed",
            cleanup="confirmed", logger=logger,
        )
        raise
    try:
        result = kernel._mcp_client.execute_tool(
            call.tool_id, tool_arguments, timeout_seconds=timeout_seconds,
            cancel_handle=cancel_handle, **dispatch_kwargs,
        )
    except BaseException as error:
        cancelled = bool(getattr(cancel_handle, "cancelled", False))
        # A cancel that raced the server's error reply keeps that reply as its
        # cause (transport_base.raise_cancelled_keeping_reply): the kill verdict
        # of a stopped command is evidence like any other reply (HB-034).
        reply = error if isinstance(error, MCPError) else (
            error.__cause__ if cancelled and isinstance(error.__cause__, MCPError) else None
        )
        _settle_resource(
            lease, status="cancelled" if cancelled else "failed",
            # A reply proves synchronous builtin dispatch returned, not whether
            # it changed files. Process-backed calls still need cleanup proof.
            # A failed process-backed call (git on an empty repo) carries the
            # server's owned-process verdict; without it the resource stays
            # quarantined and every later call on it waits. One that failed
            # before launching anything (a run_command cwd that failed
            # validation, dogfood HB-014) carries the zero-child proof, even
            # for a background start. A builtin that owns
            # no process (read_file, list_dir, ...) has nothing to clean up when
            # its reply was lost WITH THE TRANSPORT: started_response_lost is
            # only classified once the server is gone (a crash, or a response
            # timeout that terminated it), and quarantining here turned one
            # oversized PDF read into "resource capacity busy" for the rest of
            # the turn (2026-09-20), then into a paused turn that could never
            # settle (2026-09-22). A timeout that left the server running for
            # other callers classifies "unknown" and stays uncertain.
            cleanup=("confirmed" if reply is not None and (
                reply.completion_status == "not_started"
                or (reply.response_received and call.tool_id not in _PROCESS_BACKED_BUILTINS)
                or (
                    reply.completion_status == "started_response_lost"
                    and call.tool_id not in _PROCESS_BACKED_BUILTINS
                )
                or (reply.response_received and _cleanup_from_evidence(
                    call.tool_id, admission_arguments, reply.resource_cleanup,
                    failed_before_launch_counts=True,
                ) == "confirmed")
            ) else "uncertain"),
            logger=logger,
        )
        raise
    _settle_resource(
        lease,
        status="succeeded" if getattr(result, "success", False) else "failed",
        cleanup=_cleanup_for_result(call.tool_id, admission_arguments, result),
        logger=logger,
    )
    return result


__all__ = ["dispatch_tool_call"]
