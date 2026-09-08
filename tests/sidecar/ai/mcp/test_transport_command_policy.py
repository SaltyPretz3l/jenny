from __future__ import annotations

import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.config import MCPServerConfig
from sidecar.ai.mcp import transport_command_policy
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.transport_command_policy import validate_stdio_command


def test_relative_command_under_trusted_root_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.chdir(sys.prefix)
    config = MCPServerConfig(
        name="relative",
        transport="stdio",
        command=r"Scripts\python.exe",
    )

    with pytest.raises(MCPError, match="relative paths are blocked"):
        validate_stdio_command(config)


@pytest.mark.skipif(os.name == "nt", reason="requires POSIX absolute-path semantics")
def test_posix_distro_command_path_is_trusted() -> None:
    config = MCPServerConfig(
        name="distro",
        transport="stdio",
        command="/usr/bin/some-mcp",
    )

    validate_stdio_command(config)


def test_windows_trusted_roots_exclude_posix_system_paths(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(transport_command_policy, "os", SimpleNamespace(name="nt"))

    roots = transport_command_policy._trusted_command_roots()  # noqa: SLF001

    assert transport_command_policy._resolve_path(Path("/usr/bin")) not in roots  # noqa: SLF001
    assert transport_command_policy._resolve_path(Path("/usr/local/bin")) not in roots  # noqa: SLF001
    assert transport_command_policy._resolve_path(Path("/snap/bin")) not in roots  # noqa: SLF001
    assert transport_command_policy._resolve_path(Path("/opt/homebrew/bin")) not in roots  # noqa: SLF001
