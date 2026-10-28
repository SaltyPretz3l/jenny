"""Process-local settings for LSP tool handlers."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any, Literal, Mapping

if TYPE_CHECKING:
    from sidecar.ai.tools.builtins.lsp.server_detection import (
        LSPServerCommand,
        LSPUnavailableResult,
    )

# The one declaration; server_detection imports it (this module stays import-light).
LSPLanguage = Literal["typescript", "javascript", "python"]

# Feature requests (diagnostics, symbols, ...); initialize gets the longer
# protocol default. A timeout still stops the server, so keep this generous.
DEFAULT_LSP_REQUEST_TIMEOUT_SECONDS = 15.0
MIN_LSP_REQUEST_TIMEOUT_SECONDS = 1.0
MAX_LSP_REQUEST_TIMEOUT_SECONDS = 120.0

_COMMAND_KEYS = ("tools_lsp_command_typescript", "tools_lsp_command_python")


class _LSPToolState:
    def __init__(self) -> None:
        self.manager: Any = None
        self.config: Any | None = None
        self.detected_servers: Mapping[
            LSPLanguage, LSPServerCommand | LSPUnavailableResult
        ] | None = None
        self.request_timeout_seconds = DEFAULT_LSP_REQUEST_TIMEOUT_SECONDS
        self.configured_commands: tuple[str | None, ...] | None = None


_STATE = _LSPToolState()


def configure_lsp_tools(
    config: Any | None,
    *,
    manager: Any | None = None,
    detected_servers: Mapping[str, LSPServerCommand | LSPUnavailableResult] | None = None,
) -> None:
    """Configure process-local LSP tool dependencies."""

    commands = tuple(_config_string(config, key) for key in _COMMAND_KEYS)
    commands_changed = (
        _STATE.configured_commands is not None and commands != _STATE.configured_commands
    )
    _STATE.configured_commands = commands
    if commands_changed and _STATE.manager is not None:
        # Servers launched from the old command must not outlive the change.
        _STATE.manager.retire_sessions()
    _STATE.config = config
    _STATE.request_timeout_seconds = _request_timeout_seconds(config)
    if manager is not None:
        _STATE.manager = manager
    if detected_servers is not None:
        _STATE.detected_servers = {
            language: result
            for raw_language, result in detected_servers.items()
            if (language := _normalize_language(raw_language)) is not None
        }
        return
    _STATE.detected_servers = None


def _config_string(config: Any | None, key: str) -> str | None:
    if isinstance(config, dict):
        value = config.get(key)
    else:
        value = getattr(config, key, None)
    if not isinstance(value, str):
        return None
    token = value.strip()
    return token if token else None


def _request_timeout_seconds(config: Any | None) -> float:
    key = "tools_lsp_request_timeout_seconds"
    value = config.get(key) if isinstance(config, dict) else getattr(config, key, None)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or math.isnan(value):
        return DEFAULT_LSP_REQUEST_TIMEOUT_SECONDS
    return min(
        MAX_LSP_REQUEST_TIMEOUT_SECONDS, max(MIN_LSP_REQUEST_TIMEOUT_SECONDS, float(value))
    )


def _normalize_language(value: object) -> LSPLanguage | None:
    token = str(value or "").strip().lower()
    if token in {"typescript", "javascript", "python"}:
        return token  # type: ignore[return-value]
    return None
