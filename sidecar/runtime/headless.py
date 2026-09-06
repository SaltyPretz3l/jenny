"""Headless sidecar entrypoint for one-shot chat turns."""

from __future__ import annotations

import argparse
import json
import queue
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from sidecar.ai.container import BrainContainer
from sidecar.ai.error_codes import CMP_CHAT_STREAM_FAILED, CMP_TOOL_APPROVAL_DENIED
from sidecar.protocol import API_VERSION, JSONRPC_VERSION, TOOL_REQUEST_APPROVAL_METHOD
from sidecar.runtime.chat import (
    ChatRequestError,
    ChatResponse,
    build_chat_send_response,
    chat_error_notification,
)
from sidecar.runtime.chat_models import ChatResponse as RuntimeChatResponse
from sidecar.runtime.diagnostics import configure_sidecar_logging, shutdown_sidecar_logging
from sidecar.runtime.turn_state import TERMINAL_SUBCODE_DENIED_USER_EXPLICIT

_OUTPUT_FORMAT_TEXT = "text"
_OUTPUT_FORMAT_JSON = "json"
_OUTPUT_FORMAT_STREAM_JSON = "stream-json"

_PERMISSION_MODE_PROMPT = "prompt"
_PERMISSION_MODE_AUTO_READONLY = "auto-readonly"
_PERMISSION_MODE_AUTO_TOOLS = "auto-tools"
_PERMISSION_MODE_DANGEROUS = "dangerously-skip"

_READ_ONLY_TOOL_ALLOWLIST = frozenset(
    {
        "tool_search",
        "read_file",
        "glob_files",
        "grep_search",
        "web_search",
        "fetch_url",
        "list_dir",
        "git_status",
        "git_log",
        "git_diff",
        "git_show",
        "todo_read",
        "check_background_job",
    }
)

_APPROVAL_TIMEOUT_SECONDS = 30.0


@dataclass(frozen=True)
class HeadlessRunOptions:
    mode: str
    auto_tools_pattern: str | None
    output_format: str
    prompt: str
    config_arg: str | None
    request_id: str


def _log_path() -> Path:
    return Path.home() / ".companion" / "logs" / "sidecar.log"


def _cwd() -> Path:
    return Path.cwd()


def _home_dir() -> Path:
    return Path.home()


def _stderr(message: str) -> None:
    sys.stderr.write(f"{message}\n")
    sys.stderr.flush()


def _stdout_line(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def _json_preview(payload: dict[str, Any], *, max_chars: int = 300) -> str:
    text = json.dumps(payload, ensure_ascii=True)
    if len(text) <= max_chars:
        return text
    return f"{text[: max_chars - 3]}..."


def _notification_token_text(notifications: Sequence[dict[str, Any]]) -> str:
    deltas: list[str] = []
    for item in notifications:
        if str(item.get("method") or "").strip() != "chat.token":
            continue
        params = item.get("params")
        if not isinstance(params, dict):
            continue
        delta = params.get("delta")
        if isinstance(delta, str) and delta:
            deltas.append(delta)
    return "".join(deltas)


def _load_config_file(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    payload = json.loads(text)
    if not isinstance(payload, dict):
        raise ValueError("config must be a JSON object")
    return {str(key): value for key, value in payload.items()}


def _load_raw_config(explicit_config_path: str | None) -> tuple[dict[str, Any], Path | None]:
    if explicit_config_path:
        config_path = Path(explicit_config_path).expanduser()
        if not config_path.is_file():
            raise FileNotFoundError(f"config file not found: {config_path}")
        return _load_config_file(config_path), config_path

    default_candidates = [
        _cwd() / "config.json",
        _home_dir() / ".companion" / "config.json",
    ]
    for candidate in default_candidates:
        if candidate.is_file():
            return _load_config_file(candidate), candidate

    return {}, None


def _permission_mode_from_aliases(
    *,
    auto_approve_readonly: bool,
    auto_approve_tools: str | None,
    dangerously_skip_permissions: bool,
) -> tuple[str | None, str | None]:
    alias_mode: str | None = None
    auto_tools_pattern: str | None = None
    if auto_approve_readonly:
        alias_mode = _PERMISSION_MODE_AUTO_READONLY
    if isinstance(auto_approve_tools, str) and auto_approve_tools.strip():
        alias_mode = _PERMISSION_MODE_AUTO_TOOLS
        auto_tools_pattern = auto_approve_tools.strip()
    if dangerously_skip_permissions:
        alias_mode = _PERMISSION_MODE_DANGEROUS
    return alias_mode, auto_tools_pattern


def resolve_permission_mode(
    *,
    permission_mode: str,
    permission_mode_explicit: bool,
    auto_approve_readonly: bool,
    auto_approve_tools: str | None,
    dangerously_skip_permissions: bool,
) -> tuple[str, str | None]:
    alias_count = sum(
        1
        for present in (
            auto_approve_readonly,
            isinstance(auto_approve_tools, str) and bool(auto_approve_tools.strip()),
            dangerously_skip_permissions,
        )
        if present
    )
    if alias_count > 1:
        raise ValueError(
            "at most one permission alias can be set: --auto-approve-readonly, "
            "--auto-approve-tools, --dangerously-skip-permissions"
        )

    alias_mode, alias_pattern = _permission_mode_from_aliases(
        auto_approve_readonly=auto_approve_readonly,
        auto_approve_tools=auto_approve_tools,
        dangerously_skip_permissions=dangerously_skip_permissions,
    )
    if permission_mode_explicit and alias_mode is not None and alias_mode != permission_mode:
        raise ValueError("--permission-mode conflicts with permission alias flags; remove one form")

    resolved_mode = alias_mode or permission_mode
    resolved_pattern = alias_pattern
    return resolved_mode, resolved_pattern


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run one headless sidecar chat turn.")
    parser.add_argument(
        "--prompt",
        required=True,
        help="User prompt content for a single chat.send turn.",
    )
    parser.add_argument(
        "--config",
        default=None,
        help="Optional path to config JSON. Defaults: ./config.json, ~/.companion/config.json.",
    )
    parser.add_argument(
        "--output-format",
        choices=(
            _OUTPUT_FORMAT_TEXT,
            _OUTPUT_FORMAT_JSON,
            _OUTPUT_FORMAT_STREAM_JSON,
        ),
        default=_OUTPUT_FORMAT_TEXT,
        help="Output mode for the final response.",
    )
    parser.add_argument(
        "--permission-mode",
        choices=(
            _PERMISSION_MODE_PROMPT,
            _PERMISSION_MODE_AUTO_READONLY,
            _PERMISSION_MODE_AUTO_TOOLS,
            _PERMISSION_MODE_DANGEROUS,
        ),
        default=_PERMISSION_MODE_PROMPT,
        help="How tool approvals should be handled.",
    )
    parser.add_argument(
        "--auto-approve-readonly",
        action="store_true",
        help="Alias for --permission-mode auto-readonly.",
    )
    parser.add_argument(
        "--auto-approve-tools",
        default=None,
        help="Alias for --permission-mode auto-tools with a regex allowlist.",
    )
    parser.add_argument(
        "--dangerously-skip-permissions",
        action="store_true",
        help="Alias for --permission-mode dangerously-skip.",
    )
    return parser


class ApprovalPolicyEngine:
    """Headless approval policy shared by router flows."""

    def __init__(
        self,
        *,
        mode: str,
        auto_tools_pattern: str | None,
        stdin: Any,
    ) -> None:
        self._mode = mode
        self._stdin = stdin
        self._auto_tools_pattern = auto_tools_pattern
        self._auto_tools_regex: re.Pattern[str] | None = None
        if auto_tools_pattern:
            self._auto_tools_regex = re.compile(auto_tools_pattern)

    def decide(self, *, tool_name: str, tool_input: dict[str, Any], reason: str) -> bool:
        if self._mode == _PERMISSION_MODE_DANGEROUS:
            return True
        if self._mode == _PERMISSION_MODE_AUTO_READONLY:
            return tool_name in _READ_ONLY_TOOL_ALLOWLIST
        if self._mode == _PERMISSION_MODE_AUTO_TOOLS:
            if self._auto_tools_regex is None:
                return False
            return bool(self._auto_tools_regex.search(tool_name))
        return self._prompt_user(
            tool_name=tool_name,
            tool_input=tool_input,
            reason=reason,
        )

    def _prompt_user(
        self,
        *,
        tool_name: str,
        tool_input: dict[str, Any],
        reason: str,
    ) -> bool:
        if not bool(getattr(self._stdin, "isatty", lambda: False)()):
            _stderr("approval required but stdin is non-interactive; denying tool execution")
            return False
        _stderr(f"Approval required for tool '{tool_name}'.")
        if reason:
            _stderr(f"Reason: {reason}")
        if tool_input:
            _stderr(f"Input: {_json_preview(tool_input)}")
        sys.stderr.write("Approve? [y/N]: ")
        sys.stderr.flush()
        line = self._stdin.readline()
        if not isinstance(line, str):
            return False
        return line.strip().lower() in {"y", "yes"}


class ApprovalResponseBridge:
    """Converts approval requests into immediate request/response payloads."""

    def __init__(self, policy: ApprovalPolicyEngine) -> None:
        self._policy = policy
        self._responses: queue.Queue[dict[str, Any]] = queue.Queue()

    def write_message(self, payload: dict[str, Any]) -> None:
        if str(payload.get("method") or "").strip() != TOOL_REQUEST_APPROVAL_METHOD:
            return
        request_id = payload.get("id")
        if request_id is None:
            return
        params = payload.get("params")
        params_map = params if isinstance(params, dict) else {}
        tool_name = str(params_map.get("tool_name") or "").strip()
        reason = str(params_map.get("reason") or "").strip()
        raw_tool_input = params_map.get("tool_input")
        tool_input = raw_tool_input if isinstance(raw_tool_input, dict) else {}
        approved = self._policy.decide(
            tool_name=tool_name,
            tool_input={str(key): value for key, value in tool_input.items()},
            reason=reason,
        )
        self._responses.put(
            {
                "jsonrpc": JSONRPC_VERSION,
                "id": request_id,
                "result": {"approved": approved},
            }
        )

    def read_message(self, timeout_seconds: float) -> dict[str, Any]:
        try:
            wait_seconds = max(float(timeout_seconds), 0.0)
        except (TypeError, ValueError):
            wait_seconds = 0.0
        try:
            return self._responses.get(timeout=wait_seconds)
        except queue.Empty as error:
            raise TimeoutError("approval response timed out") from error


class NdjsonNotificationWriter:
    """Writes one JSON object per line and tracks token deltas."""

    def __init__(self) -> None:
        self._token_parts: list[str] = []

    @property
    def response_text(self) -> str:
        return "".join(self._token_parts)

    def write(self, payload: dict[str, Any]) -> None:
        method = str(payload.get("method") or "").strip()
        if method == "chat.token":
            params = payload.get("params")
            if isinstance(params, dict):
                delta = params.get("delta")
                if isinstance(delta, str) and delta:
                    self._token_parts.append(delta)
        _stdout_line(payload)


def _confirm_dangerous_mode(stdin: Any) -> bool:
    _stderr("WARNING: dangerously-skip permission mode auto-approves all tool requests.")
    if not bool(getattr(stdin, "isatty", lambda: False)()):
        return True
    sys.stderr.write("Continue in dangerously-skip mode? [y/N]: ")
    sys.stderr.flush()
    response = stdin.readline()
    if not isinstance(response, str):
        return False
    return response.strip().lower() in {"y", "yes"}


def _approval_denied_response(
    *,
    request_id: str,
    trace_id: str | None,
    session_id: str | None,
) -> RuntimeChatResponse:
    error = ChatRequestError(
        request_id=request_id,
        trace_id=trace_id,
        session_id=session_id,
        code=CMP_TOOL_APPROVAL_DENIED,
        message="tool execution denied by user",
        rpc_code=-32602,
        retryable=False,
    )
    return ChatResponse(
        request_id=request_id,
        result={
            "request_id": request_id,
            "status": "denied",
            "terminal_subcode": TERMINAL_SUBCODE_DENIED_USER_EXPLICIT,
        },
        notifications=[chat_error_notification(error)],
        approval_request=None,
    )


def _run_chat_turn(  # noqa: PLR0913
    *,
    request_id: str,
    prompt: str,
    brain_container: BrainContainer,
    stream_notifications: bool,
    notification_writer: NdjsonNotificationWriter | None,
    approval_policy: ApprovalPolicyEngine,
    approval_bridge: ApprovalResponseBridge,
    approvals_pre_granted: bool,
) -> RuntimeChatResponse:
    trace_id = request_id
    session_id = None
    params = {
        "accept_version": API_VERSION,
        "request_id": request_id,
        "trace_id": trace_id,
        "messages": [{"role": "user", "content": prompt}],
    }
    side_effects_enabled = approvals_pre_granted
    while True:
        response = build_chat_send_response(
            request_id,
            params,
            approvals_pre_granted=side_effects_enabled,
            brain_container=brain_container,
            invalid_params_code=-32602,
            stream_notifications=stream_notifications,
            notification_writer=(
                notification_writer.write if notification_writer is not None else None
            ),
            approval_reader=approval_bridge.read_message,
            approval_timeout_seconds=_APPROVAL_TIMEOUT_SECONDS,
            approval_writer=approval_bridge.write_message,
        )
        if response.approval_request is None:
            return response
        tool_name = str(response.approval_request.get("tool_name") or "").strip()
        reason = str(response.approval_request.get("reason") or "").strip()
        raw_tool_input = response.approval_request.get("tool_input")
        tool_input = raw_tool_input if isinstance(raw_tool_input, dict) else {}
        approved = approval_policy.decide(
            tool_name=tool_name,
            tool_input={str(key): value for key, value in tool_input.items()},
            reason=reason,
        )
        if not approved:
            return _approval_denied_response(
                request_id=request_id,
                trace_id=trace_id,
                session_id=session_id,
            )
        side_effects_enabled = True


def _result_envelope(
    *,
    response: RuntimeChatResponse,
    response_text: str,
    config_source: str | None,
) -> dict[str, Any]:
    envelope: dict[str, Any] = {
        "request_id": response.request_id,
        "status": str(response.result.get("status") or ""),
        "result": dict(response.result),
        "response_text": response_text,
        "notifications": [dict(item) for item in response.notifications],
    }
    if config_source:
        envelope["config_source"] = config_source
    return envelope


def _error_envelope(
    *,
    request_id: str,
    code: str,
    message: str,
) -> dict[str, Any]:
    return {
        "request_id": request_id,
        "status": "error",
        "error": {
            "code": code,
            "message": message,
        },
    }


def _options_from_args(args: argparse.Namespace) -> HeadlessRunOptions:
    mode = str(
        getattr(
            args,
            "resolved_permission_mode",
            getattr(args, "permission_mode", _PERMISSION_MODE_PROMPT),
        )
    )
    return HeadlessRunOptions(
        mode=mode,
        auto_tools_pattern=getattr(args, "resolved_auto_tools_pattern", None),
        output_format=str(getattr(args, "output_format", _OUTPUT_FORMAT_TEXT)),
        prompt=str(getattr(args, "prompt", "")).strip(),
        config_arg=getattr(args, "config", None),
        request_id=f"headless_{int(time.time() * 1000)}",
    )


def _emit_json_error(*, request_id: str, code: str, message: str) -> None:
    _stdout_line(
        _error_envelope(
            request_id=request_id,
            code=code,
            message=message,
        )
    )


def _emit_runtime_error(
    *,
    output_format: str,
    request_id: str,
    code: str,
    message: str,
) -> int:
    if output_format == _OUTPUT_FORMAT_TEXT:
        _stderr(message)
        return 1
    _emit_json_error(request_id=request_id, code=code, message=message)
    return 1


def _preflight_permissions(options: HeadlessRunOptions) -> int | None:
    if options.mode != _PERMISSION_MODE_DANGEROUS:
        return None
    if _confirm_dangerous_mode(sys.stdin):
        return None
    error_message = "dangerously-skip permissions confirmation declined"
    return _emit_runtime_error(
        output_format=options.output_format,
        request_id=options.request_id,
        code=CMP_TOOL_APPROVAL_DENIED,
        message=error_message,
    )


def _configure_runtime(raw_config: dict[str, Any]) -> None:
    configure_sidecar_logging(
        _log_path(),
        log_level=str(raw_config.get("diagnostics_log_level") or "info"),
        capture_mode=str(raw_config.get("diagnostics_capture_mode") or "redacted"),
    )


def _build_approval_components(
    options: HeadlessRunOptions,
) -> tuple[ApprovalPolicyEngine, ApprovalResponseBridge, NdjsonNotificationWriter | None]:
    approval_policy = ApprovalPolicyEngine(
        mode=options.mode,
        auto_tools_pattern=options.auto_tools_pattern,
        stdin=sys.stdin,
    )
    approval_bridge = ApprovalResponseBridge(approval_policy)
    notification_writer = (
        NdjsonNotificationWriter() if options.output_format == _OUTPUT_FORMAT_STREAM_JSON else None
    )
    return approval_policy, approval_bridge, notification_writer


def _create_brain_container(raw_config: dict[str, Any]) -> BrainContainer:
    brain_container = BrainContainer()
    brain_container.configure(raw_config)
    return brain_container


def _collect_response_text(
    *,
    response: RuntimeChatResponse,
    notification_writer: NdjsonNotificationWriter | None,
) -> str:
    if notification_writer is not None:
        for notification in response.notifications:
            notification_writer.write(notification)
        fallback_text = _notification_token_text(response.notifications)
        return notification_writer.response_text or fallback_text
    return _notification_token_text(response.notifications)


def _emit_success(
    *,
    options: HeadlessRunOptions,
    response: RuntimeChatResponse,
    response_text: str,
    config_source: Path | None,
) -> int:
    status = str(response.result.get("status") or "")
    if options.output_format == _OUTPUT_FORMAT_TEXT:
        if status == "completed":
            sys.stdout.write(response_text + "\n")
            sys.stdout.flush()
        else:
            _stderr(f"headless run ended with status: {status or 'unknown'}")
        return 0 if status == "completed" else 1

    envelope = _result_envelope(
        response=response,
        response_text=response_text,
        config_source=str(config_source) if config_source is not None else None,
    )
    _stdout_line(envelope)
    return 0 if status == "completed" else 1


def _handle_chat_request_error(*, output_format: str, error: ChatRequestError) -> int:
    if output_format == _OUTPUT_FORMAT_STREAM_JSON:
        _stdout_line(chat_error_notification(error))
    if output_format == _OUTPUT_FORMAT_TEXT:
        _stderr(f"{error.code}: {error.message}")
        return 1
    _emit_json_error(
        request_id=error.request_id,
        code=error.code,
        message=error.message,
    )
    return 1


def _cleanup_runtime(
    *,
    brain_container: BrainContainer | None,
    logging_configured: bool,
) -> None:
    if brain_container is not None:
        brain_container.close()
    if logging_configured:
        shutdown_sidecar_logging()


def run_headless_from_args(args: argparse.Namespace) -> int:
    options = _options_from_args(args)
    brain_container: BrainContainer | None = None
    logging_configured = False

    preflight_exit = _preflight_permissions(options)
    if preflight_exit is not None:
        return preflight_exit

    try:
        raw_config, config_source = _load_raw_config(options.config_arg)
        _configure_runtime(raw_config)
        logging_configured = True

        (
            approval_policy,
            approval_bridge,
            notification_writer,
        ) = _build_approval_components(options)
        brain_container = _create_brain_container(raw_config)
        response = _run_chat_turn(
            request_id=options.request_id,
            prompt=options.prompt,
            brain_container=brain_container,
            stream_notifications=notification_writer is not None,
            notification_writer=notification_writer,
            approval_policy=approval_policy,
            approval_bridge=approval_bridge,
            approvals_pre_granted=(options.mode == _PERMISSION_MODE_DANGEROUS),
        )
        response_text = _collect_response_text(
            response=response,
            notification_writer=notification_writer,
        )
        return _emit_success(
            options=options,
            response=response,
            response_text=response_text,
            config_source=config_source,
        )
    except ChatRequestError as error:
        return _handle_chat_request_error(output_format=options.output_format, error=error)
    except (FileNotFoundError, ValueError) as error:
        message = str(error)
        return _emit_runtime_error(
            output_format=options.output_format,
            request_id=options.request_id,
            code=CMP_CHAT_STREAM_FAILED,
            message=message,
        )
    except Exception as error:  # noqa: BLE001
        message = str(error) or type(error).__name__
        return _emit_runtime_error(
            output_format=options.output_format,
            request_id=options.request_id,
            code=CMP_CHAT_STREAM_FAILED,
            message=message,
        )
    finally:
        _cleanup_runtime(
            brain_container=brain_container,
            logging_configured=logging_configured,
        )


def permission_mode_flag_present(raw_args: Sequence[str]) -> bool:
    """Detect both argparse spellings: ``--permission-mode value`` and
    ``--permission-mode=value``. Membership alone missed the equals form,
    letting a conflicting alias silently override an explicit mode."""
    return any(
        arg == "--permission-mode" or arg.startswith("--permission-mode=")
        for arg in raw_args
    )


def run_headless(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    raw_args = list(argv) if argv is not None else list(sys.argv[1:])
    arguments = parser.parse_args(raw_args)
    permission_mode_explicit = permission_mode_flag_present(raw_args)
    try:
        resolved_mode, resolved_pattern = resolve_permission_mode(
            permission_mode=str(arguments.permission_mode),
            permission_mode_explicit=permission_mode_explicit,
            auto_approve_readonly=bool(arguments.auto_approve_readonly),
            auto_approve_tools=(
                str(arguments.auto_approve_tools).strip()
                if isinstance(arguments.auto_approve_tools, str)
                else None
            ),
            dangerously_skip_permissions=bool(arguments.dangerously_skip_permissions),
        )
    except ValueError as error:
        parser.error(str(error))
    arguments.resolved_permission_mode = resolved_mode
    arguments.resolved_auto_tools_pattern = resolved_pattern
    return run_headless_from_args(arguments)


__all__ = [
    "ApprovalPolicyEngine",
    "ApprovalResponseBridge",
    "permission_mode_flag_present",
    "run_headless",
    "run_headless_from_args",
    "resolve_permission_mode",
]
