"""Model-facing LSP diagnostics, symbols, definition, and references tools."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

from sidecar.ai.error_codes import (
    CMP_TOOL_DISABLED,
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_IO_FAILED,
)
from sidecar.ai.tools.builtins.lsp.limits import (
    DEFAULT_MAX_DEFINITIONS,
    DEFAULT_MAX_DIAGNOSTICS,
    DEFAULT_MAX_REFERENCES,
    DEFAULT_MAX_SYMBOLS,
    MAX_LSP_ITEMS,
)
from sidecar.ai.tools.builtins.lsp.manager import (
    LSPLanguage,
    LSPManager,
    LSPProtocolError,
    LSPServerCommand,
    LSPUnavailableResult,
    detect_language_servers,
)
from sidecar.ai.tools.builtins.lsp.normalizers import (
    normalize_definitions,
    normalize_diagnostics,
    normalize_references,
    normalize_symbols,
)
from sidecar.ai.tools.builtins.lsp.paths import (
    LSPTarget,
    parse_lsp_position,
    resolve_lsp_target,
    server_language_for_target,
)
from sidecar.ai.tools.builtins.lsp_settings import (
    _STATE,
    _config_string,
)
from sidecar.ai.tools.builtins.lsp_settings import (
    configure_lsp_tools as _configure_lsp_tools,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

configure_lsp_tools = _configure_lsp_tools


if _STATE.manager is None:
    _STATE.manager = LSPManager()


@dataclass(frozen=True)
class _LSPRequestSpec:
    result_kind: str
    method: str
    normalize: Callable[[object], dict[str, object]]
    request_params: dict[str, object] | None = None
    failure_payload_extra: Mapping[str, object] | None = None


def shutdown_lsp_tools() -> None:
    """Close every cached language-server session (builtin-server exit path)."""

    _STATE.manager.shutdown()


def lsp_diagnostics_tool(
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> ToolHandlerResult:
    target = resolve_lsp_target(arguments, workspace)
    max_items = _bounded_int(
        arguments.get("max_diagnostics"),
        default=DEFAULT_MAX_DIAGNOSTICS,
    )
    return _run_lsp_request(
        target=target,
        workspace=workspace,
        spec=_LSPRequestSpec(
            result_kind="lsp_diagnostics",
            method="textDocument/diagnostic",
            normalize=lambda raw: normalize_diagnostics(
                raw,
                file_path=target.relative_path,
                max_diagnostics=max_items,
            ),
        ),
    )


def lsp_symbols_tool(
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> ToolHandlerResult:
    target = resolve_lsp_target(arguments, workspace)
    max_items = _bounded_int(arguments.get("max_symbols"), default=DEFAULT_MAX_SYMBOLS)
    return _run_lsp_request(
        target=target,
        workspace=workspace,
        spec=_LSPRequestSpec(
            result_kind="lsp_symbols",
            method="textDocument/documentSymbol",
            normalize=lambda raw: normalize_symbols(
                raw,
                file_path=target.relative_path,
                max_symbols=max_items,
            ),
        ),
    )


def lsp_definition_tool(
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> ToolHandlerResult:
    target = resolve_lsp_target(arguments, workspace)
    position = parse_lsp_position(arguments)
    max_items = _bounded_int(arguments.get("max_locations"), default=DEFAULT_MAX_DEFINITIONS)
    return _run_lsp_request(
        target=target,
        workspace=workspace,
        spec=_LSPRequestSpec(
            result_kind="lsp_definition",
            method="textDocument/definition",
            request_params={
                "textDocument": {"uri": target.uri},
                "position": position,
            },
            failure_payload_extra={"position": position},
            normalize=lambda raw: {
                **normalize_definitions(
                    raw,
                    workspace=workspace,
                    max_locations=max_items,
                ),
                "file": target.relative_path,
                "position": position,
            },
        ),
    )


def lsp_references_tool(
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> ToolHandlerResult:
    target = resolve_lsp_target(arguments, workspace)
    position = parse_lsp_position(arguments)
    include_declaration = arguments.get("include_declaration") is True
    max_items = _bounded_int(arguments.get("max_references"), default=DEFAULT_MAX_REFERENCES)
    return _run_lsp_request(
        target=target,
        workspace=workspace,
        spec=_LSPRequestSpec(
            result_kind="lsp_references",
            method="textDocument/references",
            request_params={
                "textDocument": {"uri": target.uri},
                "position": position,
                "context": {"includeDeclaration": include_declaration},
            },
            failure_payload_extra={"position": position},
            normalize=lambda raw: {
                **normalize_references(
                    raw,
                    workspace=workspace,
                    max_references=max_items,
                ),
                "file": target.relative_path,
                "position": position,
            },
        ),
    )


_LSP_ACTION_HANDLERS: Mapping[
    str,
    Callable[[dict[str, object], WorkspaceGuard], ToolHandlerResult],
] = {
    "diagnostics": lsp_diagnostics_tool,
    "symbols": lsp_symbols_tool,
    "definition": lsp_definition_tool,
    "references": lsp_references_tool,
}


def lsp_tool(
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> ToolHandlerResult:
    """Dispatch the merged model-facing LSP tool to its action handler."""

    action = arguments.get("action")
    handler = _LSP_ACTION_HANDLERS.get(action) if isinstance(action, str) else None
    if handler is None:
        return ToolHandlerResult(
            output=json.dumps(
                {
                    "status": "invalid_action",
                    "reason": "A declared LSP action is required",
                    "allowed_actions": list(_LSP_ACTION_HANDLERS),
                },
                ensure_ascii=False,
            ),
            success=False,
            error_code=CMP_TOOL_EXECUTION_FAILED,
            metadata={"result_kind": "lsp", "truncated": False},
        )
    return handler(arguments, workspace)


def _run_lsp_request(
    *,
    target: LSPTarget,
    workspace: WorkspaceGuard,
    spec: _LSPRequestSpec,
) -> ToolHandlerResult:
    failure_payload_extra = dict(spec.failure_payload_extra or {})
    if not _lsp_enabled(_STATE.config):
        return _failure_result(
            result_kind=spec.result_kind,
            target=target,
            status="unavailable",
            error_code=CMP_TOOL_DISABLED,
            payload_extra={**failure_payload_extra, "reason": "LSP tools are disabled"},
        )
    server = _server_for_language(target.language)
    if not isinstance(server, LSPServerCommand):
        return _failure_result(
            result_kind=spec.result_kind,
            target=target,
            status="unavailable",
            error_code=CMP_TOOL_DISABLED,
            payload_extra={**failure_payload_extra, **_unavailable_payload(server)},
        )
    try:
        workspace_root = workspace.require_root()
        # Bounded cleanup checkpoint: reap idle language servers before
        # acquiring, so sessions cannot accumulate for the process lifetime.
        _STATE.manager.evict_idle_sessions()
        session = _STATE.manager.ensure_session(
            language=server_language_for_target(target.language),
            workspace_root=workspace_root,
            command=_command_for_server(server),
        )
        _ensure_initialized(
            session=session,
            language=target.language,
            workspace_root=workspace_root,
        )
        sync_result = _STATE.manager.sync_document(
            session=session,
            language=target.language,
            file_path=target.absolute_path,
        )
        if sync_result.stale_content:
            return _failure_result(
                result_kind=spec.result_kind,
                target=target,
                status="stale_content",
                error_code=CMP_TOOL_IO_FAILED,
                payload_extra={
                    **failure_payload_extra,
                    "stale_content": True,
                    "reason": sync_result.reason,
                    "sync_version": sync_result.version,
                },
            )
        raw_result = _request_language_feature(
            session=session,
            method=spec.method,
            uri=target.uri,
            params=spec.request_params,
        )
    except ToolExecutionFailure:
        raise
    except LSPProtocolError as error:
        _log_protocol_failure(result_kind=spec.result_kind, language=target.language, error=error)
        return _failure_result(
            result_kind=spec.result_kind,
            target=target,
            status="degraded",
            error_code=CMP_TOOL_EXECUTION_FAILED,
            payload_extra={
                **failure_payload_extra,
                "reason": f"LSP request failed: {type(error).__name__}",
                "stale_content": False,
            },
        )
    payload = spec.normalize(raw_result)
    if not isinstance(payload, dict):
        payload = {"file": target.relative_path, "truncated": False}
    payload.update(
        {
            "status": "ready",
            "language": target.language,
            "stale_content": False,
        }
    )
    return ToolHandlerResult(
        output=json.dumps(payload, ensure_ascii=False),
        success=True,
        metadata=_metadata(
            result_kind=spec.result_kind,
            target=target,
            truncated=bool(payload.get("truncated", False)),
        ),
    )


def _ensure_initialized(*, session: Any, language: LSPLanguage, workspace_root: Path) -> None:
    ensure_initialized = getattr(_STATE.manager, "ensure_initialized", None)
    if callable(ensure_initialized):
        ensure_initialized(
            session=session,
            language=language,
            workspace_root=workspace_root,
        )


def _request_language_feature(
    *,
    session: Any,
    method: str,
    uri: str,
    params: dict[str, object] | None = None,
) -> object:
    if method == "textDocument/diagnostic":
        request_document_diagnostics = getattr(
            _STATE.manager,
            "request_document_diagnostics",
            None,
        )
        if callable(request_document_diagnostics):
            return request_document_diagnostics(session=session, uri=uri)
    return session.request(method, params or {"textDocument": {"uri": uri}})


def _failure_result(
    *,
    result_kind: str,
    target: LSPTarget,
    status: str,
    error_code: str,
    payload_extra: Mapping[str, object],
) -> ToolHandlerResult:
    payload: dict[str, object] = {
        "status": status,
        "language": target.language,
        "file": target.relative_path,
        "truncated": False,
        **dict(payload_extra),
    }
    if result_kind == "lsp_diagnostics":
        payload["diagnostics"] = []
    elif result_kind == "lsp_symbols":
        payload["symbols"] = []
    elif result_kind == "lsp_definition":
        payload.update(
            {
                "definitions": [],
                "total_count": 0,
                "omitted_external_count": 0,
                "malformed_count": 0,
            }
        )
    elif result_kind == "lsp_references":
        payload.update(
            {
                "references_by_file": [],
                "total_count": 0,
                "omitted_external_count": 0,
                "malformed_count": 0,
            }
        )
    return ToolHandlerResult(
        output=json.dumps(payload, ensure_ascii=False),
        success=False,
        error_code=error_code,
        metadata=_metadata(result_kind=result_kind, target=target, truncated=False),
    )


def _metadata(*, result_kind: str, target: LSPTarget, truncated: bool) -> dict[str, object]:
    return {
        "result_kind": result_kind,
        "language": target.language,
        "file": target.relative_path,
        "truncated": truncated,
    }


def _server_for_language(language: LSPLanguage) -> LSPServerCommand | LSPUnavailableResult | None:
    servers = _STATE.detected_servers
    if servers is None:
        _STATE.detected_servers = detect_language_servers(
            configured_typescript_command=_config_string(
                _STATE.config, "tools_lsp_command_typescript"
            ),
            configured_python_command=_config_string(
                _STATE.config, "tools_lsp_command_python"
            ),
        )
        servers = _STATE.detected_servers
    if servers is None:
        return None
    return servers.get(server_language_for_target(language))


def _unavailable_payload(
    result: LSPServerCommand | LSPUnavailableResult | None,
) -> dict[str, object]:
    if isinstance(result, LSPUnavailableResult):
        reason = (
            "configured language-server command was not found"
            if result.configured_command
            else result.reason
        )
        payload: dict[str, object] = {"reason": reason}
        if result.install_hint:
            payload["install_hint"] = result.install_hint
        if result.configured_command:
            payload["configured_command_present"] = True
        return payload
    return {"reason": "No language server is available for this language"}


def _command_for_server(server: LSPServerCommand) -> tuple[str, ...]:
    executable = str(server.executable or "").strip()
    if not executable:
        raise ToolExecutionFailure(
            code=CMP_TOOL_DISABLED,
            message="language server command is not configured",
            retryable=False,
        )
    name = Path(executable).name.lower()
    command = (executable,)
    if name in {"typescript-language-server", "typescript-language-server.cmd"}:
        return (*command, "--stdio")
    if name in {"pyright-langserver", "pyright-langserver.cmd"}:
        return (*command, "--stdio")
    return command


def _lsp_enabled(config: Any | None) -> bool:
    if isinstance(config, dict):
        value = config.get("tools_lsp_enabled")
    else:
        value = getattr(config, "tools_lsp_enabled", None)
    return value if isinstance(value, bool) else False


def _bounded_int(value: object, *, default: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return default
    if value < 1:
        return default
    return min(value, MAX_LSP_ITEMS)


def _log_protocol_failure(
    *,
    result_kind: str,
    language: LSPLanguage,
    error: LSPProtocolError,
) -> None:
    log_event(
        logger,
        logging.WARNING,
        component="ai.tools.lsp",
        event="ai.tools.lsp.request_failed",
        message=f"{result_kind} failed: {type(error).__name__}",
        status="failure",
        data={
            "result_kind": result_kind,
            "language": language,
            "error_type": type(error).__name__,
        },
    )
