"""Process-local settings for LSP tool handlers."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal, Mapping

if TYPE_CHECKING:
    from sidecar.ai.tools.builtins.lsp.manager import LSPServerCommand, LSPUnavailableResult

LSPLanguage = Literal["typescript", "javascript", "python"]


class _LSPToolState:
    def __init__(self) -> None:
        self.manager: Any = None
        self.config: Any | None = None
        self.detected_servers: Mapping[
            LSPLanguage, LSPServerCommand | LSPUnavailableResult
        ] | None = None


_STATE = _LSPToolState()


def configure_lsp_tools(
    config: Any | None,
    *,
    manager: Any | None = None,
    detected_servers: Mapping[str, LSPServerCommand | LSPUnavailableResult] | None = None,
) -> None:
    """Configure process-local LSP tool dependencies."""

    _STATE.config = config
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


def _normalize_language(value: object) -> LSPLanguage | None:
    token = str(value or "").strip().lower()
    if token in {"typescript", "javascript", "python"}:
        return token  # type: ignore[return-value]
    return None
