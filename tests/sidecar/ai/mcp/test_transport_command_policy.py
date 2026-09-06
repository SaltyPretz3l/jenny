from __future__ import annotations

import sys

import pytest

from sidecar.ai.config import MCPServerConfig
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
