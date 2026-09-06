"""First-party stdio MCP server exposing local filesystem/shell/git tooling."""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Sequence

from sidecar.ai.config import resolve_operation_ledger_root
from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.mcp.builtin_server_io import (
    CANCEL_NOTIFICATION_METHOD,  # noqa: F401 - stable public re-export.
    install_termination_handler,
    start_stdin_pump,
)
from sidecar.ai.mcp.builtin_server_ledger import (
    LedgerBracket,
    OperationLedgerUnavailable,
    configure_operation_ledger,
    current_operation_ledger,
    ledger_call_arguments,
    ledger_request_fingerprint,  # noqa: F401 - stable public re-export.
    operation_status_tool,
    operation_timestamp,
)
from sidecar.ai.mcp.builtin_snapshot_leases import SnapshotLeaseStore, session_scope
from sidecar.ai.mcp.circuit_breaker import (
    breaker_open_reason,
    record_failure,
    record_success,
)
from sidecar.ai.mcp.exceptions import (
    CMP_MCP_PROTOCOL_FAILED,
    CMP_MCP_SERVER_FAILED,
    CMP_MCP_TOOL_NOT_FOUND,
)
from sidecar.ai.tools.assembly import ToolAssemblyContext, assemble_tool_contract
from sidecar.ai.tools.builtins import cancellation, output_chunk_slot
from sidecar.ai.tools.builtins.lsp.tools import shutdown_lsp_tools
from sidecar.ai.tools.builtins.worktree_change_tracking import run_with_worktree_observation
from sidecar.ai.tools.catalog import (
    BUILTIN_MCP_SERVER_NAME,
    BUILTIN_MCP_SURFACE,
    build_tool_catalog,
)
from sidecar.ai.tools.contracts import (
    ToolExecutionFailure,
    ToolHandlerResult,
    validate_tool_arguments,
)
from sidecar.ai.tools.phase_trace import PHASE_NAMES, PhaseTrace
from sidecar.ai.tools.plan_artifact_policy import strip_plan_artifact_write_arg
from sidecar.ai.tools.registry import build_tool_bindings
from sidecar.ai.tools.sanitization import strip_surrogates
from sidecar.ai.tools.tool_actions import effective_side_effecting
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.diagnostics import log_tool_execution

ToolHandler = Callable[[dict[str, object], WorkspaceGuard], object]
logger = logging.getLogger(__name__)
_TRUE_ARG_VALUES = frozenset({"1", "true", "yes", "on"})
_DELIMITED_PATH_RE = re.compile(
    r"""(?P<quote>["'])(?P<quoted>(?:[A-Za-z]:\\|/)[^"'\r\n]+)(?P=quote)"""
    r"|\((?P<parenthesized>(?:[A-Za-z]:\\|/)[^)\r\n]+)\)"
    r"|\[(?P<bracketed>(?:[A-Za-z]:\\|/)[^\]\r\n]+)\]"
)
_BARE_PATH_RE = re.compile(
    r"\b[A-Za-z]:\\[^\s:<>|?*\"'()\[\],;]+"
    r"|(?<!\w)/(?:[^\s:/]+/)*[^\s:/\"'()\[\],;]+"
)
_MAX_ERROR_MESSAGE_CHARS = 500


@dataclass(frozen=True)
class BuiltinTool:
    name: str
    description: str
    side_effecting: bool
    input_schema: dict[str, Any]
    handler: ToolHandler
    actions: dict[str, Any] | None = None


# Every ``_jenny_*`` key routing may inject into tool arguments
# (tool_execution.inject_dispatch_trace_id + tool_execution_snapshots). They are
# stripped before schema validation and restored after, so tools declaring
# ``additionalProperties: false`` keep accepting dispatches (74ddbc9c regression).
TRANSPORT_ARGUMENT_KEYS: tuple[str, ...] = (
    "_jenny_trace_id",
    "_jenny_idempotency_key",
    "_jenny_operation_id",
    "_jenny_session_id",
    "_jenny_turn_id",
    "_jenny_tool_call_id",
    "_jenny_change_set_id",
    "_jenny_session_offline_lockdown",
    "_jenny_read_only",
    "_jenny_approved_plan",
)

def _default_tools(  # noqa: PLR0913
    *,
    workspace_root_present: bool = True,
    pre_change_snapshot_root: str | None = None,
    glob_enabled: bool = True,
    grep_enabled: bool = True,
    edit_enabled: bool = True,
    delete_file_enabled: bool = True,
    move_file_enabled: bool = True,
    distill_enabled: bool = True,
    shell_enabled: bool = False,
    shell_security_enabled: bool = False,
    git_tracking_enabled: bool = False,
    web_enabled: bool = False,
    web_rate_limit_per_min: int = 30,
    web_max_fetch_bytes: int = 1_048_576,
    web_allow_private_addresses: bool = False,
    web_search_provider: str = "duckduckgo",
    web_searxng_url: str | None = None,
    web_search_provider_keys: dict[str, str] | None = None,
    image_read_enabled: bool = False,
    max_search_file_bytes: int = 2_097_152,
    max_edit_file_bytes: int = 2_097_152,
    python_runtime_enabled: bool = False,
    python_runtime_timeout_seconds: int = 30,
    python_runtime_max_memory_mb: int = 512,
    python_runtime_interpreter: str | None = None,
    python_runtime_root: str | None = None,
    python_runtime_bundled_python: str | None = None,
    python_runtime_wheelhouse_dir: str | None = None,
    todo_enabled: bool = False,
    connections_enabled: bool = True,
    connections_engine_type: str = "mock",
    connections_engine_host: str | None = None,
    connections_mcp_servers: tuple[tuple[str, str, str], ...] = (),
    mermaid_enabled: bool = False,
    workspace_manifest_enabled: bool = False,
    rich_files_enabled: bool = False,
    knowledge_enabled: bool = False,
    knowledge_roots: tuple[str, ...] = (),
    lsp_enabled: bool = False,
    lsp_command_typescript: str | None = None,
    lsp_command_python: str | None = None,
    load_skill_enabled: bool = True,
    skills_bundled_root: str | None = None,
    skills_bundled_enabled: bool = True,
    skills_user_root: str | None = None,
    skills_user_enabled: bool = True,
    skills_project_root: str | None = None,
    skills_project_enabled: bool = True,
    skills_disabled_ids: tuple[str, ...] = (),
    skills_auto_index: str = "auto",
) -> dict[str, BuiltinTool]:
    config = {
        "pre_change_snapshot_root": pre_change_snapshot_root,
        "tools_glob_enabled": glob_enabled,
        "tools_grep_enabled": grep_enabled,
        "tools_edit_file_enabled": edit_enabled,
        "tools_delete_file_enabled": delete_file_enabled,
        "tools_move_file_enabled": move_file_enabled,
        "tools_distill_enabled": distill_enabled,
        "tools_shell_enabled": shell_enabled,
        "tools_web_enabled": web_enabled,
        "tools_web_rate_limit_per_min": web_rate_limit_per_min,
        "tools_web_max_fetch_bytes": web_max_fetch_bytes,
        "tools_web_allow_private_addresses": web_allow_private_addresses,
        "tools_web_search_provider": web_search_provider,
        "tools_web_searxng_url": web_searxng_url,
        "tools_web_search_provider_keys": web_search_provider_keys,
        "tools_image_read_enabled": image_read_enabled,
        "tools_max_search_file_bytes": max_search_file_bytes,
        "tools_max_edit_file_bytes": max_edit_file_bytes,
        "tools_python_runtime_enabled": python_runtime_enabled,
        "tools_python_runtime_timeout_seconds": python_runtime_timeout_seconds,
        "tools_python_runtime_max_memory_mb": python_runtime_max_memory_mb,
        "tools_python_runtime_interpreter": python_runtime_interpreter,
        "tools_python_runtime_root": python_runtime_root,
        "tools_python_runtime_bundled_python": python_runtime_bundled_python,
        "tools_python_runtime_wheelhouse_dir": python_runtime_wheelhouse_dir,
        "tools_todo_enabled": todo_enabled,
        "tools_connections_enabled": connections_enabled,
        "connections_engine_type": connections_engine_type,
        "connections_engine_host": connections_engine_host,
        "connections_mcp_servers": connections_mcp_servers,
        "tools_mermaid_enabled": mermaid_enabled,
        "tools_workspace_manifest_enabled": workspace_manifest_enabled,
        "tools_rich_files_enabled": rich_files_enabled,
        "tools_knowledge_enabled": knowledge_enabled,
        "knowledge_roots": knowledge_roots,
        "tools_lsp_enabled": lsp_enabled,
        "tools_lsp_command_typescript": lsp_command_typescript,
        "tools_lsp_command_python": lsp_command_python,
        "tools_load_skill_enabled": load_skill_enabled,
        "skills_bundled_root": skills_bundled_root,
        "skills_bundled_enabled": skills_bundled_enabled,
        "skills_user_root": skills_user_root,
        "skills_user_enabled": skills_user_enabled,
        "skills_project_root": skills_project_root,
        "skills_project_enabled": skills_project_enabled,
        "skills_disabled_ids": skills_disabled_ids,
        "skills_auto_index": skills_auto_index,
        # Reconstruct the two feature flags run_command consumes so
        # build_tool_bindings -> configure_shell_security arms the classifier and
        # git telemetry inside this subprocess (see main()'s --*-enabled args).
        "feature_flags": {
            "shell_security": shell_security_enabled,
            "git_tracking": git_tracking_enabled,
        },
    }
    bindings = build_tool_bindings(config=config, include_shell=shell_enabled)
    bindings["operation_status"] = lambda arguments, workspace: operation_status_tool(
        arguments,
        workspace,
        generation_id=SERVER_GENERATION_ID,
    )
    descriptors = build_tool_catalog(
        config=config,
        bound_names=bindings.keys(),
        bound_server_name=BUILTIN_MCP_SERVER_NAME,
    )
    contract = assemble_tool_contract(
        descriptors,
        ToolAssemblyContext(
            surface=BUILTIN_MCP_SURFACE,
            config=config,
            engine_supports_tool_calling=True,
            mode="assist",
            plan_mode=False,
            tool_preferences=None,
            resolution_context=None,
            workspace_root_present=workspace_root_present,
            enforce_mode_policy=False,
            enforce_request_preferences=False,
            include_deferred_tools=False,
        ),
    )
    return {
        entry.descriptor.name: BuiltinTool(
            name=entry.descriptor.name,
            description=entry.descriptor.description,
            side_effecting=entry.descriptor.side_effecting,
            input_schema=dict(entry.descriptor.input_schema),
            handler=bindings[entry.descriptor.name],
            actions=dict(entry.descriptor.actions) if entry.descriptor.actions else None,
        )
        for entry in contract.entries
        if (
            entry.available
            and entry.descriptor.name in bindings
            and entry.descriptor.runtime_registered
        )
    }


def _safe_json_dumps(payload: object) -> str:
    return strip_surrogates(json.dumps(payload, ensure_ascii=False))


# W2-1: tool reader/flush-timer threads write live-output notifications to
# stdout while the dispatch thread eventually writes the call's response —
# every stdout write must hold this lock so lines never interleave.
_STDOUT_WRITE_LOCK = threading.Lock()
# Lockstep with transport_stdio.OUTPUT_CHUNK_NOTIFICATION_METHOD.
OUTPUT_CHUNK_NOTIFICATION_METHOD = "tool/output_chunk"
TOOL_STARTED_NOTIFICATION_METHOD = "tool/started"
SERVER_GENERATION_ID = f"gen_{uuid.uuid4().hex}"
_SNAPSHOT_LEASES = SnapshotLeaseStore()


def _write_response(payload: dict[str, Any]) -> None:
    line = _safe_json_dumps(payload) + "\n"
    with _STDOUT_WRITE_LOCK:
        sys.stdout.write(line)
        sys.stdout.flush()


def _make_output_chunk_writer(message_id: Any) -> Callable[[dict[str, object]], None]:
    """Notification writer for the in-flight call's live-output batches."""

    def _write(batch: dict[str, object]) -> None:
        _write_response(
            {
                "jsonrpc": "2.0",
                "method": OUTPUT_CHUNK_NOTIFICATION_METHOD,
                "params": {**batch, "request_id": message_id},
            }
        )

    return _write


def _write_tool_started(message_id: Any, operation_id: str) -> None:
    _write_response(
        {
            "jsonrpc": "2.0",
            "method": TOOL_STARTED_NOTIFICATION_METHOD,
            "params": {
                "request_id": message_id,
                "operation_id": operation_id,
                "generation_id": SERVER_GENERATION_ID,
            },
        }
    )


def _result_response(message_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": message_id,
        "result": result,
    }


def _redact_error_message(message: str) -> str:
    redacted = _DELIMITED_PATH_RE.sub(
        lambda match: f"{match.group(0)[0]}<path>{match.group(0)[-1]}",
        str(message),
    )
    redacted = _BARE_PATH_RE.sub("<path>", redacted)
    if len(redacted) > _MAX_ERROR_MESSAGE_CHARS:
        return f"{redacted[:_MAX_ERROR_MESSAGE_CHARS]}\n...[truncated]"
    return redacted


def _error_response(
    message_id: Any,
    code: str,
    message: str,
    *,
    retryable: bool = False,
    metadata: dict[str, object] | None = None,
) -> dict[str, Any]:
    safe_message = _redact_error_message(message)
    return {
        "jsonrpc": "2.0",
        "id": message_id,
        "error": {
            "code": -32000,
            "message": safe_message,
            "data": {"code": code, "retryable": bool(retryable), **dict(metadata or {})},
        },
    }


def _handle_tools_list(message_id: Any, tools: dict[str, BuiltinTool]) -> dict[str, Any]:
    payload = []
    for tool in sorted(tools.values(), key=lambda item: item.name):
        descriptor = {
            "name": tool.name,
            "description": tool.description,
            "inputSchema": tool.input_schema,
            "side_effecting": tool.side_effecting,
        }
        if tool.actions:
            descriptor["actions"] = {
                name: {"side_effecting": getattr(spec, "side_effecting", True)}
                for name, spec in tool.actions.items()
            }
        payload.append(descriptor)
    return _result_response(message_id, {"tools": payload})


def _prepare_call_arguments(
    tool: BuiltinTool,
    arguments: object,
    workspace: WorkspaceGuard,
) -> tuple[dict[str, object], str, str]:
    stripped_arguments = strip_plan_artifact_write_arg(arguments)
    schema_arguments = stripped_arguments
    transport_arguments: dict[str, object] = {}
    if isinstance(stripped_arguments, dict):
        schema_arguments = dict(stripped_arguments)
        for key in TRANSPORT_ARGUMENT_KEYS:
            if key in schema_arguments:
                transport_arguments[key] = schema_arguments.pop(key)
    validated = validate_tool_arguments(
        tool_name=tool.name,
        arguments=schema_arguments,
        input_schema=tool.input_schema,
    )
    validated.update(transport_arguments)
    raw_operation_id = validated.get("_jenny_operation_id")
    operation_id = (
        raw_operation_id.strip()
        if isinstance(raw_operation_id, str) and raw_operation_id.strip()
        else f"op_{uuid.uuid4().hex}"
    )
    validated["_jenny_operation_id"] = operation_id
    validated["_jenny_server_generation_id"] = SERVER_GENERATION_ID
    session_id = session_scope(validated)
    workspace_key = str(workspace.require_root().resolve()).casefold()
    scope = f"{session_id}\0{workspace_key}"
    return (
        _SNAPSHOT_LEASES.inject(
            tool_name=tool.name,
            session_id=scope,
            arguments=validated,
        ),
        operation_id,
        scope,
    )


def _postprocess_call_output(
    *, tool_name: str, scope: str, arguments: dict[str, object], output: object
) -> object:
    if not isinstance(output, ToolHandlerResult):
        return output
    processed = (
        _SNAPSHOT_LEASES.decorate_read_result(session_id=scope, result=output)
        if tool_name == "read_file"
        else output
    )
    _SNAPSHOT_LEASES.invalidate_after(
        tool_name=tool_name,
        session_id=scope,
        result=processed,
    )
    return processed


def _raise_if_breaker_open(tool_name: str) -> None:
    for phase in PHASE_NAMES:
        open_reason = breaker_open_reason(tool_name, phase)
        if open_reason is not None:
            raise ToolExecutionFailure(
                code=CMP_TOOL_IO_FAILED,
                message=open_reason,
                retryable=False,
                error_details={
                    "failure_class": "unavailable",
                    "effects": "none",
                    "failed_phase": phase,
                },
            )


def _traced_failure_data(
    *, tool_name: str, error: ToolExecutionFailure, trace: PhaseTrace, trace_id: str
) -> dict[str, str]:
    error_data = error.to_error_data()
    failed_phase = error_data.get("failed_phase") or trace.current_phase
    if failed_phase:
        record_failure(tool_name, failed_phase)
        error_data.setdefault("failed_phase", failed_phase)
    error_data.setdefault("phase_timings_json", trace.phase_timings_json())
    if trace_id:
        error_data.setdefault("trace_id", trace_id)
    return error_data


def _add_success_trace_metadata(
    *,
    tool_name: str,
    success: bool,
    metadata: dict[str, Any],
    trace: PhaseTrace,
    trace_id: str,
) -> None:
    metadata.setdefault("phase_timings_json", trace.phase_timings_json())
    if trace_id:
        metadata.setdefault("trace_id", trace_id)
    if success:
        record_success(tool_name, "execute")
        record_success(tool_name, "validate")


def _unpack_tool_output(
    output: object,
) -> tuple[str, bool, tuple[dict[str, Any], ...], str | None, dict[str, Any], tuple]:
    if not isinstance(output, ToolHandlerResult):
        text = _safe_json_dumps(output) if isinstance(output, (dict, list)) else str(output)
        return text, True, (), None, {}, ()
    return (
        output.output,
        output.success,
        output.generated_artifacts,
        output.error_code,
        dict(output.metadata),
        output.trusted_attachments,
    )


def _handle_tools_call(  # noqa: PLR0911
    message_id: Any,
    tools: dict[str, BuiltinTool],
    workspace: WorkspaceGuard,
    params: dict[str, Any],
) -> dict[str, Any]:
    name = params.get("name")
    if not isinstance(name, str) or not name.strip():
        return _error_response(
            message_id,
            CMP_MCP_PROTOCOL_FAILED,
            "tools/call requires a non-empty name",
        )
    tool = tools.get(name.strip())
    if tool is None:
        return _error_response(message_id, CMP_MCP_TOOL_NOT_FOUND, f"unknown tool: {name}")
    raw_arguments = params.get("arguments")
    arguments = strip_plan_artifact_write_arg(raw_arguments)
    call_arguments, ledger_key, trace_id = ledger_call_arguments(arguments)
    trace = PhaseTrace(tool=tool.name, call_id=str(message_id), trace_id=trace_id)
    started_at = time.perf_counter()
    bracket = LedgerBracket(None, ledger_key, {}, "")
    try:
        with trace:
            _raise_if_breaker_open(tool.name)
            with trace.phase("validate"):
                validated_arguments, operation_id, scope = _prepare_call_arguments(
                    tool,
                    call_arguments,
                    workspace,
                )
            call_side_effecting = effective_side_effecting(tool, validated_arguments)
            workspace.observe_mutation_tool_call(tool.name, validated_arguments)
            if call_side_effecting is None:
                call_side_effecting = tool.side_effecting
            bracket = LedgerBracket.start(
                tool_name=tool.name,
                side_effecting=call_side_effecting,
                key=ledger_key,
                arguments=validated_arguments,
                operation_id=operation_id,
                workspace=workspace,
                message_id=message_id,
                generation_id=SERVER_GENERATION_ID,
                error_response=_error_response,
                result_response=_result_response,
            )
            operation_id = bracket.operation_id
            if bracket.response is not None:
                return bracket.response
            # The reader thread flips this call's abort event when it sees a
            # notifications/cancelled for message_id; long-running handlers
            # (run_command) poll it via cancellation.current_abort_event().
            cancellation.begin_tool_call(message_id)
            # W2-1: streaming-capable handlers (run_command) fetch this writer to
            # emit live tool/output_chunk notifications tagged with message_id.
            output_chunk_slot.begin_tool_call(_make_output_chunk_writer(message_id))
            try:
                _write_tool_started(message_id, operation_id)
                with trace.phase("execute"):
                    output = run_with_worktree_observation(
                        side_effecting=tool.side_effecting,
                        tool_name=tool.name,
                        arguments=validated_arguments,
                        workspace=workspace,
                        handler=lambda: tool.handler(validated_arguments, workspace),
                        logger=logger,
                    )
                    output = _postprocess_call_output(
                        tool_name=tool.name,
                        scope=scope,
                        arguments=validated_arguments,
                        output=output,
                    )
            finally:
                output_chunk_slot.end_tool_call()
                cancellation.end_tool_call()
    except ToolExecutionFailure as error:
        error_data = _traced_failure_data(
            tool_name=tool.name,
            error=error,
            trace=trace,
            trace_id=trace_id,
        )
        bracket.settle_failure(tool.name, error_data, error)
        log_tool_execution(
            logger,
            tool_name=tool.name,
            arguments=arguments,
            duration_ms=(time.perf_counter() - started_at) * 1000,
            result_size=len(error.message),
            tool_output=error.message,
            success=False,
            error_code=error.code,
        )
        return _error_response(
            message_id,
            error.code,
            error.message,
            retryable=error.retryable,
            metadata={
                **error_data,
                "operation_id": locals().get("operation_id"),
                "generation_id": SERVER_GENERATION_ID,
            },
        )
    except Exception as error:  # noqa: BLE001
        bracket.settle_unexpected()
        record_failure(tool.name, "execute")
        error_message = f"tool execution failed: {error}"
        log_tool_execution(
            logger,
            tool_name=tool.name,
            arguments=arguments,
            duration_ms=(time.perf_counter() - started_at) * 1000,
            result_size=len(error_message),
            tool_output=error_message,
            success=False,
            error_code=CMP_MCP_SERVER_FAILED,
        )
        return _error_response(message_id, CMP_MCP_SERVER_FAILED, f"tool execution failed: {error}")
    (
        output_text,
        success,
        generated_artifacts,
        error_code,
        metadata,
        trusted_attachments,
    ) = _unpack_tool_output(output)
    bracket.settle_result(
        tool_name=tool.name,
        success=bool(success),
        output_text=output_text,
        metadata=metadata,
        generated_artifacts=generated_artifacts,
    )
    _add_success_trace_metadata(
        tool_name=tool.name,
        success=bool(success),
        metadata=metadata,
        trace=trace,
        trace_id=trace_id,
    )
    metadata.setdefault("mcp_operation_id", operation_id)
    metadata.setdefault("mcp_generation_id", SERVER_GENERATION_ID)
    log_tool_execution(
        logger,
        tool_name=tool.name,
        arguments=arguments,
        duration_ms=(time.perf_counter() - started_at) * 1000,
        result_size=len(output_text),
        tool_output=output_text,
        success=bool(success),
        error_code=error_code,
    )
    result_payload: dict[str, Any] = {
        "content": [{"type": "text", "text": output_text}],
        "isError": not bool(success),
        "content_type": "text",
        "success": bool(success),
        "generated_artifacts": [dict(item) for item in generated_artifacts],
    }
    if error_code is not None:
        result_payload["error_code"] = error_code
    if metadata:
        result_payload["metadata"] = metadata
    if trusted_attachments:
        result_payload["trusted_attachments"] = [dict(item) for item in trusted_attachments]
    return _result_response(message_id, result_payload)


def _dispatch_message(
    payload: dict[str, Any],
    tools: dict[str, BuiltinTool],
    workspace: WorkspaceGuard,
) -> dict[str, Any]:
    message_id = payload.get("id")
    method = payload.get("method")
    if method == "initialize":
        return _result_response(
            message_id,
            {
                "protocolVersion": "2025-03-26",
                "capabilities": {
                    "tools": {},
                    "experimental": {
                        "jenny_tool_lifecycle": {
                            "started_notification": TOOL_STARTED_NOTIFICATION_METHOD
                        }
                    },
                },
                "serverInfo": {"name": "jenny-builtin-tools", "version": "1"},
                "generationId": SERVER_GENERATION_ID,
            },
        )
    if method == "tools/list":
        return _handle_tools_list(message_id, tools)
    if method == "tools/call":
        params = payload.get("params")
        if not isinstance(params, dict):
            params = {}
        return _handle_tools_call(message_id, tools, workspace, params)
    return _error_response(message_id, CMP_MCP_PROTOCOL_FAILED, f"unknown method: {method}")


def _build_workspace_guard(args: argparse.Namespace) -> WorkspaceGuard:
    root = args.workspace_root if isinstance(args.workspace_root, str) else None
    snapshot_root = (
        args.pre_change_snapshot_root
        if isinstance(args.pre_change_snapshot_root, str)
        else None
    )
    recovery_root = str(args.workspace_recovery_root or "").strip()
    mutation_journal = None
    if root and recovery_root:
        from sidecar.ai.routing.mutation_change_set_lifecycle import (  # noqa: PLC0415
            MutationChangeSetLifecycle,
        )
        from sidecar.ai.tools.workspace_mutation_journal_store import (  # noqa: PLC0415
            WorkspaceMutationJournalStore,
        )
        from sidecar.ai.tools.workspace_retention import (  # noqa: PLC0415
            run_recovery_maintenance,
        )

        store = WorkspaceMutationJournalStore.from_version_root(recovery_root)
        # WO-26: close the "retention only runs on the next delete/write" gap --
        # one bounded startup pass here, then again after every journal commit
        # (the store fires `on_commit`; both share `run_recovery_maintenance`).
        # Neither is a timer: this runs once per subprocess start, and the hook
        # only fires on an already-happening commit write.
        store.on_commit = lambda *_ids: run_recovery_maintenance(store, root)
        run_recovery_maintenance(store, root)
        mutation_journal = MutationChangeSetLifecycle(store, root)
    return WorkspaceGuard(
        root,
        pre_change_snapshot_root=snapshot_root,
        mutation_journal=mutation_journal,
    )


def _parse_bool_arg(value: object) -> bool:
    return str(value).strip().lower() in _TRUE_ARG_VALUES


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace-root", dest="workspace_root", default=None)
    parser.add_argument(
        "--operation-ledger-root", dest="operation_ledger_root", default=""
    )
    parser.add_argument(
        "--pre-change-snapshot-root",
        dest="pre_change_snapshot_root",
        default="",
    )
    parser.add_argument(
        "--workspace-recovery-root", dest="workspace_recovery_root", default=""
    )
    parser.add_argument("--glob-enabled", dest="glob_enabled", default="1")
    parser.add_argument("--grep-enabled", dest="grep_enabled", default="1")
    parser.add_argument("--edit-enabled", dest="edit_enabled", default="1")
    parser.add_argument("--delete-file-enabled", dest="delete_file_enabled", default="1")
    parser.add_argument("--move-file-enabled", dest="move_file_enabled", default="1")
    parser.add_argument("--shell-enabled", dest="shell_enabled", default="0")
    # SECURITY: gate the shell-security classifier and git-operation telemetry
    # that live in run_command's subprocess handler. Default off so a stale
    # launcher never silently claims guardrails it did not forward.
    parser.add_argument("--shell-security-enabled", dest="shell_security_enabled", default="0")
    parser.add_argument("--git-tracking-enabled", dest="git_tracking_enabled", default="0")
    parser.add_argument("--web-enabled", dest="web_enabled", default="0")
    parser.add_argument("--web-rate-limit-per-min", dest="web_rate_limit_per_min", default="30")
    parser.add_argument("--web-max-fetch-bytes", dest="web_max_fetch_bytes", default="1048576")
    parser.add_argument(
        "--web-allow-private-addresses",
        dest="web_allow_private_addresses",
        default="0",
    )
    parser.add_argument(
        "--web-search-provider",
        dest="web_search_provider",
        default="duckduckgo",
    )
    # No CLI arg for provider API keys: argv is visible in process listings,
    # so key-based providers are configurable only through the managed sidecar
    # config channel (RuntimeConfig.tools_web_search_provider_keys).
    parser.add_argument("--web-searxng-url", dest="web_searxng_url", default="")
    parser.add_argument("--image-read-enabled", dest="image_read_enabled", default="0")
    parser.add_argument("--max-search-file-bytes", dest="max_search_file_bytes", default="2097152")
    parser.add_argument("--max-edit-file-bytes", dest="max_edit_file_bytes", default="2097152")
    parser.add_argument("--python-runtime-enabled", dest="python_runtime_enabled", default="0")
    parser.add_argument(
        "--python-runtime-timeout-seconds",
        dest="python_runtime_timeout_seconds",
        default="30",
    )
    parser.add_argument(
        "--python-runtime-max-memory-mb",
        dest="python_runtime_max_memory_mb",
        default="512",
    )
    parser.add_argument(
        "--python-runtime-interpreter",
        dest="python_runtime_interpreter",
        default="",
    )
    parser.add_argument("--python-runtime-root", dest="python_runtime_root", default="")
    parser.add_argument(
        "--python-runtime-bundled-python",
        dest="python_runtime_bundled_python",
        default="",
    )
    parser.add_argument(
        "--python-runtime-wheelhouse-dir",
        dest="python_runtime_wheelhouse_dir",
        default="",
    )
    parser.add_argument("--todo-enabled", dest="todo_enabled", default="0")
    parser.add_argument("--connections-enabled", dest="connections_enabled", default="1")
    parser.add_argument(
        "--connections-engine-type", dest="connections_engine_type", default="mock"
    )
    parser.add_argument(
        "--connections-engine-host", dest="connections_engine_host", default=""
    )
    parser.add_argument(
        "--connections-mcp-server",
        dest="connections_mcp_servers",
        action="append",
        nargs=3,
        default=[],
    )
    parser.add_argument("--mermaid-enabled", dest="mermaid_enabled", default="0")
    parser.add_argument(
        "--workspace-manifest-enabled",
        dest="workspace_manifest_enabled",
        default="0",
    )
    parser.add_argument("--rich-files-enabled", dest="rich_files_enabled", default="0")
    parser.add_argument("--knowledge-enabled", dest="knowledge_enabled", default="0")
    # Repeatable: one flag per registered knowledge root. Roots are paths, not
    # secrets, so argv delivery matches --workspace-root.
    parser.add_argument(
        "--knowledge-root",
        dest="knowledge_roots",
        action="append",
        default=[],
    )
    parser.add_argument("--distill-enabled", dest="distill_enabled", default="1")
    parser.add_argument("--lsp-enabled", dest="lsp_enabled", default="0")
    parser.add_argument(
        "--lsp-command-typescript",
        dest="lsp_command_typescript",
        default="",
    )
    parser.add_argument("--lsp-command-python", dest="lsp_command_python", default="")
    parser.add_argument("--load-skill-enabled", dest="load_skill_enabled", default="1")
    # Skill scope roots are paths, not secrets, so argv delivery matches
    # --workspace-root / --knowledge-root; the tool re-validates every read
    # against these roots regardless of what a caller requests.
    parser.add_argument("--skill-bundled-root", dest="skills_bundled_root", default="")
    parser.add_argument("--skill-bundled-enabled", dest="skills_bundled_enabled", default="1")
    parser.add_argument("--skill-user-root", dest="skills_user_root", default="")
    parser.add_argument("--skill-user-enabled", dest="skills_user_enabled", default="1")
    parser.add_argument("--skill-project-root", dest="skills_project_root", default="")
    parser.add_argument("--skill-project-enabled", dest="skills_project_enabled", default="1")
    parser.add_argument(
        "--skill-disabled-id", dest="skills_disabled_ids", action="append", default=[]
    )
    parser.add_argument(
        "--skill-auto-index",
        dest="skills_auto_index",
        choices=("auto", "on", "off"),
        default="auto",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)
    ledger_root_arg = str(args.operation_ledger_root or "").strip()
    configure_operation_ledger(
        ledger_root_arg if ledger_root_arg else resolve_operation_ledger_root()
    )
    try:
        ledger = current_operation_ledger()
        if ledger is not None:
            ledger.compact(now_iso=operation_timestamp())
    except OperationLedgerUnavailable:
        pass
    workspace = _build_workspace_guard(args)
    glob_enabled = _parse_bool_arg(args.glob_enabled)
    grep_enabled = _parse_bool_arg(args.grep_enabled)
    edit_enabled = _parse_bool_arg(args.edit_enabled)
    delete_file_enabled = _parse_bool_arg(args.delete_file_enabled)
    move_file_enabled = _parse_bool_arg(args.move_file_enabled)
    distill_enabled = _parse_bool_arg(args.distill_enabled)
    shell_enabled = _parse_bool_arg(args.shell_enabled)
    shell_security_enabled = _parse_bool_arg(args.shell_security_enabled)
    git_tracking_enabled = _parse_bool_arg(args.git_tracking_enabled)
    web_enabled = _parse_bool_arg(args.web_enabled)
    web_allow_private_addresses = _parse_bool_arg(args.web_allow_private_addresses)
    image_read_enabled = _parse_bool_arg(args.image_read_enabled)
    python_runtime_enabled = _parse_bool_arg(args.python_runtime_enabled)
    todo_enabled = _parse_bool_arg(args.todo_enabled)
    connections_enabled = _parse_bool_arg(args.connections_enabled)
    mermaid_enabled = _parse_bool_arg(args.mermaid_enabled)
    workspace_manifest_enabled = _parse_bool_arg(args.workspace_manifest_enabled)
    rich_files_enabled = _parse_bool_arg(args.rich_files_enabled)
    knowledge_enabled = _parse_bool_arg(args.knowledge_enabled)
    knowledge_roots = tuple(
        token
        for token in (str(item or "").strip() for item in (args.knowledge_roots or []))
        if token
    )
    lsp_enabled = _parse_bool_arg(args.lsp_enabled)
    load_skill_enabled = _parse_bool_arg(args.load_skill_enabled)
    skills_bundled_enabled = _parse_bool_arg(args.skills_bundled_enabled)
    skills_user_enabled = _parse_bool_arg(args.skills_user_enabled)
    skills_project_enabled = _parse_bool_arg(args.skills_project_enabled)
    skills_disabled_ids = tuple(
        token
        for token in (str(item or "").strip() for item in args.skills_disabled_ids)
        if token
    )[:256]
    tools = _default_tools(
        workspace_root_present=workspace.root is not None,
        pre_change_snapshot_root=str(args.pre_change_snapshot_root).strip() or None,
        glob_enabled=glob_enabled,
        grep_enabled=grep_enabled,
        edit_enabled=edit_enabled,
        delete_file_enabled=delete_file_enabled,
        move_file_enabled=move_file_enabled,
        distill_enabled=distill_enabled,
        shell_enabled=shell_enabled,
        shell_security_enabled=shell_security_enabled,
        git_tracking_enabled=git_tracking_enabled,
        web_enabled=web_enabled,
        web_rate_limit_per_min=int(str(args.web_rate_limit_per_min).strip() or "30"),
        web_max_fetch_bytes=int(str(args.web_max_fetch_bytes).strip() or "1048576"),
        web_allow_private_addresses=web_allow_private_addresses,
        web_search_provider=str(args.web_search_provider).strip() or "duckduckgo",
        web_searxng_url=str(args.web_searxng_url).strip() or None,
        image_read_enabled=image_read_enabled,
        max_search_file_bytes=int(str(args.max_search_file_bytes).strip() or "2097152"),
        max_edit_file_bytes=int(str(args.max_edit_file_bytes).strip() or "2097152"),
        python_runtime_enabled=python_runtime_enabled,
        python_runtime_timeout_seconds=int(
            str(args.python_runtime_timeout_seconds).strip() or "30"
        ),
        python_runtime_max_memory_mb=int(str(args.python_runtime_max_memory_mb).strip() or "512"),
        python_runtime_interpreter=str(args.python_runtime_interpreter).strip() or None,
        python_runtime_root=str(args.python_runtime_root).strip() or None,
        python_runtime_bundled_python=str(args.python_runtime_bundled_python).strip() or None,
        python_runtime_wheelhouse_dir=str(args.python_runtime_wheelhouse_dir).strip() or None,
        todo_enabled=todo_enabled,
        connections_enabled=connections_enabled,
        connections_engine_type=str(args.connections_engine_type).strip() or "mock",
        connections_engine_host=str(args.connections_engine_host).strip() or None,
        connections_mcp_servers=tuple(
            (
                str(server[0]).strip(),
                str(server[1]).strip(),
                str(server[2]).strip(),
            )
            for server in args.connections_mcp_servers
        ),
        mermaid_enabled=mermaid_enabled,
        workspace_manifest_enabled=workspace_manifest_enabled,
        rich_files_enabled=rich_files_enabled,
        knowledge_enabled=knowledge_enabled,
        knowledge_roots=knowledge_roots,
        lsp_enabled=lsp_enabled,
        lsp_command_typescript=str(args.lsp_command_typescript).strip() or None,
        lsp_command_python=str(args.lsp_command_python).strip() or None,
        load_skill_enabled=load_skill_enabled,
        skills_bundled_root=str(args.skills_bundled_root).strip() or None,
        skills_bundled_enabled=skills_bundled_enabled,
        skills_user_root=str(args.skills_user_root).strip() or None,
        skills_user_enabled=skills_user_enabled,
        skills_project_root=str(args.skills_project_root).strip() or None,
        skills_project_enabled=skills_project_enabled,
        skills_disabled_ids=skills_disabled_ids,
        skills_auto_index=args.skills_auto_index,
    )

    install_termination_handler()
    inbox = start_stdin_pump()
    # The finally also covers SIGTERM: the termination handler exits via
    # SystemExit, so cached language servers are closed on both exit paths.
    try:
        while True:
            stripped = inbox.get()
            if stripped is None:
                break
            try:
                payload = json.loads(stripped)
            except json.JSONDecodeError:
                _write_response(
                    _error_response(None, CMP_MCP_PROTOCOL_FAILED, "invalid json payload")
                )
                continue
            if not isinstance(payload, dict):
                _write_response(
                    _error_response(None, CMP_MCP_PROTOCOL_FAILED, "payload must be an object")
                )
                continue
            response = _dispatch_message(payload, tools, workspace)
            _write_response(response)
    finally:
        shutdown_lsp_tools()


if __name__ == "__main__":
    main()
