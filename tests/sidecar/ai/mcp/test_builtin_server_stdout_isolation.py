from __future__ import annotations

import sys
from pathlib import Path

import pytest

from sidecar.ai.config import MCPServerConfig
from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.transport_stdio import StdioMCPTransport


def test_tool_import_stdout_cannot_corrupt_builtin_protocol(tmp_path: Path) -> None:
    fake_site = tmp_path / "fake-site"
    pillow = fake_site / "PIL"
    pillow.mkdir(parents=True)
    (pillow / "__init__.py").write_text("", encoding="utf-8")
    (pillow / "Image.py").write_text(
        "import os\n"
        'print("stray Python stdout", flush=True)\n'
        'os.write(1, b"stray fd 1 stdout\\n")\n'
        'raise ImportError("synthetic Pillow import failure")\n',
        encoding="utf-8",
    )
    (tmp_path / "image.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    bootstrap = (
        "import runpy, sys; "
        f"sys.path.insert(0, {str(fake_site)!r}); "
        "sys.argv = ['builtin-server', '--workspace-root', "
        f"{str(tmp_path)!r}, '--image-read-enabled', '1']; "
        "runpy.run_module('sidecar.ai.mcp.builtin_server', run_name='__main__')"
    )
    transport = StdioMCPTransport(
        MCPServerConfig(
            name="jenny_local_tools",
            transport="stdio",
            command=sys.executable,
            args=("-c", bootstrap),
            memory_limit_mb=None,
        ),
        request_timeout_seconds=20,
    )
    try:
        with pytest.raises(MCPError) as raised:
            transport.call_tool("read_file", {"path": "image.png"})
    finally:
        transport.close()

    assert raised.value.code == CMP_TOOL_EXECUTION_FAILED
    assert raised.value.response_received is True
