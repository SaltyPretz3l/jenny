"""First-party stdio MCP server exposing local filesystem/shell/git tooling."""

from __future__ import annotations

import argparse
import json
import logging
import sys  # noqa: F401 - tests patch builtin_server.sys.argv.
import threading
import time
import uuid
from contextlib import nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Sequence

from sidecar.ai.config import resolve_operation_ledger_root
from sidecar.ai.error_codes import CMP_TOOL_DISABLED
from sidecar.ai.execution_policy import (
    DesktopExecutionPolicyError,
    desktop_policy_from_cli,
    desktop_tool_decision,
)
from sidecar.ai.host_policy import (
    HOST_EXECUTION_POLICY_VERSION,
    HostPolicyError,
    host_policy_from_cli,
    host_tool_decision,
)
from sidecar.ai.mcp.builtin_request_scope import (
    TRUSTED_EXECUTION_CONTEXT_KEY,
    builtin_request_scope,
)
from sidecar.ai.mcp.builtin_server_cli import build_argument_parser
from sidecar.ai.mcp.builtin_server_io import (
    CANCEL_NOTIFICATION_METHOD,  # noqa: F401 - stable public re-export.
    configure_stdio,
    install_termination_handler,
    start_stdin_pump,
    write_protocol_line,
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
    raise_if_breaker_open,
    record_breaker_outcome,
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
from sidecar.ai.tools.builtins.owned_process_observation import observe_owned_process_invocation
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
from sidecar.ai.tools.hosted_file_io import configure_hosted_file_io
from sidecar.ai.tools.phase_trace import PHASE_NAMES, PhaseTrace
from sidecar.ai.tools.plan_artifact_policy import strip_plan_artifact_write_arg
from sidecar.ai.tools.registry import build_tool_bindings
from sidecar.ai.tools.sanitization import (
    PathKeeper,
    error_path_keeper,
    redact_error_paths,
    strip_surrogates,
)
from sidecar.ai.tools.tool_actions import effective_side_effecting
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.diagnostics import (
    configure_sidecar_logging,
    log_tool_execution,
    shutdown_sidecar_logging,
)
from sidecar.runtime.media_site import activate_optional_sites

ToolHandler = Callable[[dict[str, object], WorkspaceGuard], object]
logger = logging.getLogger(__name__)
_TRUE_ARG_VALUES = frozenset({"1", "true", "yes", "on"})
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
    TRUSTED_EXECUTION_CONTEXT_KEY,
)

def _default_tools(
    config: dict[str, Any] | None = None,
    *,
    workspace_root_present: bool = True,
    request_scoped_authority: bool = False,
) -> dict[str, BuiltinTool]:
    config = {
        "host_mode": "desktop",
        "host_execution_policy_version": None,
        "desktop_execution_policy_version": None,
        "pre_change_snapshot_root": None,
        "tools_glob_enabled": True,
        "tools_grep_enabled": True,
        "tools_edit_file_enabled": True,
        "tools_delete_file_enabled": True,
        "tools_move_file_enabled": True,
        "tools_distill_enabled": True,
        "tools_shell_enabled": False,
        "tools_web_enabled": False,
        "tools_web_rate_limit_per_min": 30,
        "tools_web_max_fetch_bytes": 1048576,
        "tools_web_allow_private_addresses": False,
        "tools_web_search_provider": "duckduckgo",
        "tools_web_searxng_url": None,
        "tools_web_search_provider_keys": None,
        "tools_image_read_enabled": False,
        "tools_max_search_file_bytes": 2097152,
        "tools_max_edit_file_bytes": 2097152,
        "tools_python_runtime_enabled": False,
        "tools_python_runtime_timeout_seconds": 30,
        "tools_python_runtime_max_memory_mb": 512,
        "tools_python_runtime_interpreter": None,
        "tools_python_runtime_root": None,
        "tools_python_runtime_bundled_python": None,
        "tools_python_runtime_wheelhouse_dir": None,
        "tools_todo_enabled": False,
        "tools_connections_enabled": True,
        "connections_engine_type": "mock",
        "connections_engine_host": None,
        "connections_mcp_servers": (),
        "tools_mermaid_enabled": False,
        "tools_workspace_manifest_enabled": False,
        "tools_rich_files_enabled": False,
        "tools_knowledge_enabled": False,
        "knowledge_roots": (),
        "tools_lsp_enabled": False,
        "tools_lsp_command_typescript": None,
        "tools_lsp_command_python": None,
        "tools_load_skill_enabled": True,
        "skills_bundled_root": None,
        "skills_bundled_enabled": True,
        "skills_user_root": None,
        "skills_user_enabled": True,
        "skills_project_root": None,
        "skills_project_enabled": True,
        "skills_disabled_ids": (),
        "skills_auto_index": "auto",
        "feature_flags": {"shell_security": False, "git_tracking": False},
        **(config or {}),
    }
    host_policy = host_policy_from_cli(config["host_mode"], config["host_execution_policy_version"])
    desktop_policy = desktop_policy_from_cli(config["desktop_execution_policy_version"])
    config.update(
        host_mode=host_policy.mode,
        host_execution_policy_version=host_policy.version,
        desktop_execution_policy_version=desktop_policy.version,
    )
    # The owned builtin process is reused across project requests. Register the
    # knowledge handlers once even when the legacy startup config is disabled;
    # the AI request contract still hides them unless the captured request has
    # knowledge roots, and the handler itself requires a per-call registry.
    registry_config = {
        **config,
        "tools_knowledge_enabled": config["tools_knowledge_enabled"] or request_scoped_authority,
        "knowledge_roots": config["knowledge_roots"] if config["tools_knowledge_enabled"] else (),
    }
    bindings = build_tool_bindings(
        config=registry_config,
        include_shell=config["tools_shell_enabled"] and not desktop_policy.enforced,
    )
    bindings["operation_status"] = lambda arguments, workspace: operation_status_tool(
        arguments,
        workspace,
        generation_id=SERVER_GENERATION_ID,
    )
    descriptors = build_tool_catalog(
        config=registry_config,
        bound_names=bindings.keys(),
        bound_server_name=BUILTIN_MCP_SERVER_NAME,
    )
    contract = assemble_tool_contract(
        descriptors,
        ToolAssemblyContext(
            surface=BUILTIN_MCP_SURFACE,
            config=registry_config,
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
        write_protocol_line(line)


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


def _redact_error_message(message: str, *, keep: PathKeeper | None = None) -> str:
    redacted = redact_error_paths(str(message), keep=keep)
    if len(redacted) > _MAX_ERROR_MESSAGE_CHARS:
        return f"{redacted[:_MAX_ERROR_MESSAGE_CHARS]}\n...[truncated]"
    return redacted


def _error_response(  # noqa: PLR0913 - keyword-only response fields.
    message_id: Any,
    code: str,
    message: str,
    *,
    retryable: bool = False,
    metadata: dict[str, object] | None = None,
    keep_path: PathKeeper | None = None,
) -> dict[str, Any]:
    # HB-017: the model sees paths the call named or its workspace holds
    # (``keep_path``); every other absolute path stays ``<path>``.
    safe_message = _redact_error_message(message, keep=keep_path)
    return {
        "jsonrpc": "2.0",
        "id": message_id,
        "error": {
            "code": -32000,
            "message": safe_message,
            "data": {"code": code, "retryable": bool(retryable), **dict(metadata or {})},
        },
    }


def _handle_tools_list(
    message_id: Any,
    tools: dict[str, BuiltinTool],
    host_config: Any | None = None,
) -> dict[str, Any]:
    payload = []
    for tool in sorted(tools.values(), key=lambda item: item.name):
        allowed, _reason = host_tool_decision(tool.name, host_config)
        if allowed:
            allowed, _reason = desktop_tool_decision(tool.name, host_config)
        if not allowed:
            continue
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
        prune_empty_optional_arrays=True,
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
    workspace_key = (
        str(workspace.require_root().resolve()).casefold()
        if workspace.root is not None or workspace.root_error else ""
    )
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


def _traced_failure_data(
    *, tool_name: str, error: ToolExecutionFailure, trace: PhaseTrace, trace_id: str
) -> dict[str, str]:
    error_data = error.to_error_data()
    failed_phase = error_data.get("failed_phase") or trace.current_phase
    if failed_phase:
        record_breaker_outcome(tool_name, failed_phase, error, error_data)
        error_data.setdefault("failed_phase", failed_phase)
    error_data.setdefault("phase_timings_json", trace.phase_timings_json())
    if trace_id:
        error_data.setdefault("trace_id", trace_id)
    return error_data


def _add_success_trace_metadata(
    *,
    tool_name: str,
    metadata: dict[str, Any],
    trace: PhaseTrace,
    trace_id: str,
) -> None:
    metadata.setdefault("phase_timings_json", trace.phase_timings_json())
    if trace_id:
        metadata.setdefault("trace_id", trace_id)
    # The handler returned: the tool works even when its result reports a
    # failure (a non-zero exit), so the breaker closes either way (HB-015).
    for phase in PHASE_NAMES:
        record_success(tool_name, phase)


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


def _handle_tools_call(  # noqa: C901, PLR0911, PLR0912
    message_id: Any,
    tools: dict[str, BuiltinTool],
    workspace: WorkspaceGuard,
    params: dict[str, Any],
    host_config: Any | None = None,
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
    allowed = all((host_tool_decision(tool.name, host_config)[0],
                   desktop_tool_decision(tool.name, host_config)[0]))
    if not allowed:
        return _error_response(
            message_id,
            CMP_MCP_TOOL_NOT_FOUND,
            "tool is unavailable in the hosted execution policy",
        )
    if (
        tool.name == "run_command"
        and (
            (host_config.get("host_mode") if isinstance(host_config, dict)
             else getattr(host_config, "host_mode", None)) == "server"
        )
        and (
            (host_config.get("host_execution_policy_version") if isinstance(host_config, dict)
             else getattr(host_config, "host_execution_policy_version", None))
            == HOST_EXECUTION_POLICY_VERSION
        )
    ):
        return _error_response(
            message_id,
            CMP_TOOL_DISABLED,
            "hosted run_command requires the Electron execution worker bridge",
        )
    raw_arguments = params.get("arguments")
    arguments = strip_plan_artifact_write_arg(raw_arguments)
    scope_carrier: dict[str, object] = {}
    if isinstance(arguments, dict) and TRUSTED_EXECUTION_CONTEXT_KEY in arguments:
        scope_carrier[TRUSTED_EXECUTION_CONTEXT_KEY] = arguments.get(
            TRUSTED_EXECUTION_CONTEXT_KEY
        )
        arguments = dict(arguments)
        arguments.pop(TRUSTED_EXECUTION_CONTEXT_KEY, None)
    call_arguments, ledger_key, trace_id = ledger_call_arguments(arguments)
    trace = PhaseTrace(tool=tool.name, call_id=str(message_id), trace_id=trace_id)
    started_at = time.perf_counter()
    bracket = LedgerBracket(None, ledger_key, {}, "")
    process_observation = None
    execution_may_have_started = False
    try:
        request_scope = builtin_request_scope(
            scope_carrier,
            legacy_workspace=workspace,
            host_config=host_config,
        )
        if request_scope is not None:
            workspace = request_scope.workspace
        scope_binding = request_scope if request_scope is not None else nullcontext()
        with scope_binding, trace:
            raise_if_breaker_open(tool.name)
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
            # Ledger recovery can refer to an earlier invocation. From this
            # boundary onward, retain uncertainty unless the owner proves cleanup.
            execution_may_have_started = True
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
                with trace.phase("execute"), observe_owned_process_invocation(
                    tool.name
                ) as process_observation:
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
            tool_output=redact_error_paths(error.message),
            success=False,
            error_code=error.code,
        )
        cleanup = process_observation.resource_cleanup() if process_observation else None
        return _error_response(
            message_id,
            error.code,
            error.message,
            retryable=error.retryable,
            keep_path=error_path_keeper(arguments=arguments, workspace_root=workspace.root),
            metadata={
                **error_data,
                **({"resource_cleanup": cleanup} if cleanup else {}),
                "completion_status": (
                    "unknown" if execution_may_have_started else "not_started"
                ),
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
            tool_output=redact_error_paths(error_message),
            success=False,
            error_code=CMP_MCP_SERVER_FAILED,
        )
        return _error_response(
            message_id,
            CMP_MCP_SERVER_FAILED,
            error_message,
            keep_path=error_path_keeper(arguments=arguments, workspace_root=workspace.root),
        )
    (
        output_text,
        success,
        generated_artifacts,
        error_code,
        metadata,
        trusted_attachments,
    ) = _unpack_tool_output(output)
    if process_observation is not None:
        process_observation.add_metadata(metadata)
    bracket.settle_result(
        tool_name=tool.name,
        success=bool(success),
        output_text=output_text,
        metadata=metadata,
        generated_artifacts=generated_artifacts,
    )
    _add_success_trace_metadata(
        tool_name=tool.name,
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
    host_config: Any | None = None,
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
        return _handle_tools_list(message_id, tools, host_config)
    if method == "tools/call":
        params = payload.get("params")
        if not isinstance(params, dict):
            params = {}
        return _handle_tools_call(message_id, tools, workspace, params, host_config)
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
        from sidecar.ai.routing.mutation_change_set_lifecycle import (
            MutationChangeSetLifecycle,
        )
        from sidecar.ai.tools.workspace_mutation_journal_store import (
            WorkspaceMutationJournalStore,
        )
        from sidecar.ai.tools.workspace_retention import (
            run_recovery_maintenance,
        )

        store = WorkspaceMutationJournalStore.from_version_root(recovery_root)
        # Reconcile abandoned journals before this subprocess accepts tools.
        # Commit maintenance must preserve other live or approval-paused turns.
        # Both retention paths are bounded and best-effort; neither uses a timer.
        try:
            store.reconcile_workspace(root)
        except (OSError, ValueError) as error:
            logger.warning(
                "workspace_retention_maintenance_reconcile_failed",
                extra={"reason": type(error).__name__},
            )
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


def _configure_logging(*, log_level: str = "info", capture_mode: str = "redacted") -> bool:
    try:
        # Its own file: this process lives as long as the sidecar, and on Windows a
        # second long-lived handle on sidecar.log blocks every rotation rename.
        log_path = Path.home() / ".companion" / "logs" / "builtin-tools.log"
    except (RuntimeError, OSError):
        return False
    configure_sidecar_logging(
        log_path, log_level=log_level, capture_mode=capture_mode, mirror_to_stderr=False,
    )
    return True


def main(argv: Sequence[str] | None = None) -> None:
    configure_stdio()
    # Source-mode launches skip sidecar.__main__; frozen ones already ran this (no-op).
    activate_optional_sites()
    parser = build_argument_parser()
    parser.add_argument(
        "--diagnostics-log-level", choices=("debug", "info", "warn", "warning", "error"),
        default="info",
    )
    parser.add_argument(
        "--diagnostics-capture-mode", choices=("redacted", "sanitized_snippets"),
        default="redacted",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        host_policy = host_policy_from_cli(
            args.host_mode,
            args.host_execution_policy_version,
        )
        desktop_policy = desktop_policy_from_cli(args.desktop_execution_policy_version)
    except (HostPolicyError, DesktopExecutionPolicyError):
        parser.error("invalid execution policy")
    host_config = {
        "host_mode": host_policy.mode,
        "host_execution_policy_version": host_policy.version,
        "desktop_execution_policy_version": desktop_policy.version,
        "workspace_recovery_root": args.workspace_recovery_root,
        "pre_change_snapshot_root": args.pre_change_snapshot_root,
    }
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
    configure_hosted_file_io(
        str(workspace.root) if workspace.root is not None else None,
        enabled=host_policy.mode == "server",
    )
    knowledge_roots = tuple(
        token
        for token in (str(item or "").strip() for item in (args.knowledge_roots or []))
        if token
    )
    skills_disabled_ids = tuple(
        token
        for token in (str(item or "").strip() for item in args.skills_disabled_ids)
        if token
    )[:256]
    tools = _default_tools(
        config={
            "host_mode": host_policy.mode,
            "host_execution_policy_version": host_policy.version,
            "desktop_execution_policy_version": desktop_policy.version,
            "pre_change_snapshot_root": str(args.pre_change_snapshot_root).strip() or None,
            "tools_glob_enabled": _parse_bool_arg(args.glob_enabled),
            "tools_grep_enabled": _parse_bool_arg(args.grep_enabled),
            "tools_edit_file_enabled": _parse_bool_arg(args.edit_enabled),
            "tools_delete_file_enabled": _parse_bool_arg(args.delete_file_enabled),
            "tools_move_file_enabled": _parse_bool_arg(args.move_file_enabled),
            "tools_distill_enabled": _parse_bool_arg(args.distill_enabled),
            "tools_shell_enabled": _parse_bool_arg(args.shell_enabled),
            "tools_web_enabled": _parse_bool_arg(args.web_enabled),
            "tools_web_rate_limit_per_min": int(str(args.web_rate_limit_per_min).strip() or "30"),
            "tools_web_max_fetch_bytes": int(str(args.web_max_fetch_bytes).strip() or "1048576"),
            "tools_web_allow_private_addresses": _parse_bool_arg(args.web_allow_private_addresses),
            "tools_web_search_provider": str(args.web_search_provider).strip() or "duckduckgo",
            "tools_web_searxng_url": str(args.web_searxng_url).strip() or None,
            "tools_image_read_enabled": _parse_bool_arg(args.image_read_enabled),
            "tools_max_search_file_bytes": int(
                str(args.max_search_file_bytes).strip() or "2097152"
            ),
            "tools_max_edit_file_bytes": int(str(args.max_edit_file_bytes).strip() or "2097152"),
            "tools_python_runtime_enabled": _parse_bool_arg(args.python_runtime_enabled),
            "tools_python_runtime_timeout_seconds": int(
                str(args.python_runtime_timeout_seconds).strip() or "30"
            ),
            "tools_python_runtime_max_memory_mb": int(
                str(args.python_runtime_max_memory_mb).strip() or "512"
            ),
            "tools_python_runtime_interpreter": str(args.python_runtime_interpreter).strip()
            or None,
            "tools_python_runtime_root": str(args.python_runtime_root).strip() or None,
            "tools_python_runtime_bundled_python": str(args.python_runtime_bundled_python).strip()
            or None,
            "tools_python_runtime_wheelhouse_dir": str(args.python_runtime_wheelhouse_dir).strip()
            or None,
            "tools_todo_enabled": _parse_bool_arg(args.todo_enabled),
            "tools_connections_enabled": _parse_bool_arg(args.connections_enabled),
            "connections_engine_type": str(args.connections_engine_type).strip() or "mock",
            "connections_engine_host": str(args.connections_engine_host).strip() or None,
            "connections_mcp_servers": tuple(
                (str(server[0]).strip(), str(server[1]).strip(), str(server[2]).strip())
                for server in args.connections_mcp_servers
            ),
            "tools_mermaid_enabled": _parse_bool_arg(args.mermaid_enabled),
            "tools_workspace_manifest_enabled": _parse_bool_arg(args.workspace_manifest_enabled),
            "tools_rich_files_enabled": _parse_bool_arg(args.rich_files_enabled),
            "tools_knowledge_enabled": _parse_bool_arg(args.knowledge_enabled),
            "knowledge_roots": knowledge_roots,
            "tools_lsp_enabled": _parse_bool_arg(args.lsp_enabled),
            "tools_lsp_command_typescript": str(args.lsp_command_typescript).strip() or None,
            "tools_lsp_command_python": str(args.lsp_command_python).strip() or None,
            "tools_load_skill_enabled": _parse_bool_arg(args.load_skill_enabled),
            "skills_bundled_root": str(args.skills_bundled_root).strip() or None,
            "skills_bundled_enabled": _parse_bool_arg(args.skills_bundled_enabled),
            "skills_user_root": str(args.skills_user_root).strip() or None,
            "skills_user_enabled": _parse_bool_arg(args.skills_user_enabled),
            "skills_project_root": str(args.skills_project_root).strip() or None,
            "skills_project_enabled": _parse_bool_arg(args.skills_project_enabled),
            "skills_disabled_ids": skills_disabled_ids,
            "skills_auto_index": args.skills_auto_index,
            "feature_flags": {
                "shell_security": _parse_bool_arg(args.shell_security_enabled),
                "git_tracking": _parse_bool_arg(args.git_tracking_enabled),
            },
        },
        workspace_root_present=workspace.root is not None,
        request_scoped_authority=True,
    )

    install_termination_handler()
    logging_configured = _configure_logging(
        log_level=args.diagnostics_log_level, capture_mode=args.diagnostics_capture_mode,
    )
    # The finally also covers SIGTERM: the termination handler exits via
    # SystemExit, so cached language servers are closed on both exit paths.
    try:
        inbox = start_stdin_pump()
        while True:
            stripped = inbox.get()
            if stripped is None:
                break
            try:
                payload = json.loads(stripped)
            except (json.JSONDecodeError, RecursionError):
                _write_response(
                    _error_response(None, CMP_MCP_PROTOCOL_FAILED, "invalid json payload")
                )
                continue
            if not isinstance(payload, dict):
                _write_response(
                    _error_response(None, CMP_MCP_PROTOCOL_FAILED, "payload must be an object")
                )
                continue
            response = _dispatch_message(payload, tools, workspace, host_config)
            _write_response(response)
    finally:
        try:
            shutdown_lsp_tools()
        finally:
            if logging_configured:
                shutdown_sidecar_logging()


if __name__ == "__main__":
    main()
