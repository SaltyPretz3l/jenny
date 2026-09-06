"""Trusted executable-path policy for stdio MCP servers."""

from __future__ import annotations

import sys
from pathlib import Path

from sidecar.ai.config import MCPServerConfig, read_environment_value
from sidecar.ai.error_codes import CMP_MCP_SERVER_FAILED
from sidecar.ai.mcp.exceptions import MCPError


def _path_is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _resolve_path(path: Path) -> Path:
    try:
        return path.expanduser().resolve(strict=False)
    except OSError:
        return path.expanduser().absolute()


def _is_current_frozen_executable(candidate: Path) -> bool:
    if not getattr(sys, "frozen", False):
        return False
    raw_executable = str(getattr(sys, "executable", "") or "").strip()
    return bool(raw_executable) and candidate == _resolve_path(Path(raw_executable))


def _trusted_command_roots() -> tuple[Path, ...]:
    roots: list[Path] = []
    local_app_data = read_environment_value("LOCALAPPDATA")
    for raw in (
        read_environment_value("ProgramFiles"),
        read_environment_value("ProgramFiles(x86)"),
        str(Path(local_app_data) / "Programs") if local_app_data else "",
        str(Path.home() / ".local" / "bin"),
        sys.prefix,
        sys.base_prefix,
    ):
        if raw:
            roots.append(_resolve_path(Path(raw)))
    return tuple(dict.fromkeys(roots))


def validate_stdio_command(config: MCPServerConfig) -> None:
    command = str(config.command or "").strip()
    if not command:
        raise MCPError(
            code=CMP_MCP_SERVER_FAILED,
            message=f"stdio transport requires a command for '{config.name}'",
            retryable=False,
        )
    if "/" not in command and "\\" not in command:
        return
    candidate_path = Path(command).expanduser()
    if not candidate_path.is_absolute():
        raise MCPError(
            code=CMP_MCP_SERVER_FAILED,
            message=f"untrusted mcp server command for '{config.name}': relative paths are blocked",
            retryable=False,
        )
    candidate = _resolve_path(candidate_path)
    if _is_current_frozen_executable(candidate):
        return
    if any(
        candidate == root or _path_is_relative_to(candidate, root)
        for root in _trusted_command_roots()
    ):
        return
    raise MCPError(
        code=CMP_MCP_SERVER_FAILED,
        message=(
            f"untrusted mcp server command for '{config.name}': "
            "command path is outside trusted roots"
        ),
        retryable=False,
    )
