"""Row-level stdio extensions (row 53 S2): env reaches the real child; timeouts clamp to 1800 s."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from sidecar.ai.config import MCPServerConfig
from sidecar.ai.config_parsing import _parse_mcp_servers
from sidecar.ai.mcp import transport_stdio
from sidecar.ai.mcp.transport_stdio import StdioMCPTransport

_ECHO_ENV_SERVER = "\n".join([
    "import json, os, sys",
    "for line in sys.stdin:",
    "    request = json.loads(line)",
    "    if 'id' not in request:",
    "        continue",
    "    if request.get('method') == 'initialize':",
    "        result = {'protocolVersion': '2025-03-26', 'capabilities': {}}",
    "    else:",
    "        seen = {key: os.environ.get(key) for key in ('REA_LOG_LEVEL', 'NODE_OPTIONS', 'PATH')}",
    "        result = {'content': [{'type': 'text', 'text': json.dumps(seen)}]}",
    "    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)",
]) + "\n"


def test_row_env_reaches_the_spawned_child(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    script = tmp_path / "echo_env_server.py"
    script.write_text(_ECHO_ENV_SERVER, encoding="utf-8")
    monkeypatch.setattr(transport_stdio, "_validate_stdio_command", lambda _config: None)
    [config] = _parse_mcp_servers(
        [{"name": "rea", "transport": "stdio", "command": sys.executable, "args": [str(script)],
          "env": {"REA_LOG_LEVEL": "debug"}}],
        sse_enabled=False,
    )
    transport = StdioMCPTransport(config, request_timeout_seconds=20.0)
    try:
        result = transport.call_tool("echo_env", {})
    finally:
        transport.close()
    seen = json.loads(result["content"][0]["text"])
    assert seen["REA_LOG_LEVEL"] == "debug"
    assert seen["NODE_OPTIONS"] is None
    assert str(Path(sys.executable).resolve().parent) in str(seen["PATH"])


@pytest.mark.parametrize(("configured", "expected"), [(900.0, 900.0), (5000.0, 1800.0), (0.1, 1.0)])
def test_config_request_timeout_clamps_to_the_row_bound(configured: float, expected: float) -> None:
    config = MCPServerConfig(name="rea", transport="stdio", command="npx",
                             request_timeout_seconds=configured)
    assert transport_stdio._request_timeout_from_config(config) == expected
