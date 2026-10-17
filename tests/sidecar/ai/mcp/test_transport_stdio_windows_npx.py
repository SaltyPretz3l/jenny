"""Opt-in Windows environment probe: how the stdio MCP transport launches ``npx``.

This is an environment probe recorded in the row 53 plan, not a regression
test. It runs only on Windows with ``JENNY_REA_PROBE=1`` and
``JENNY_REA_PROBE_PREFIX`` naming a primed ``rea-agents`` install directory, so
CI collects and skips it. Each launch form is an observation written to
``npx-probe-results.jsonl`` under the pytest basetemp; only the direct
``node.exe`` form is asserted to succeed.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.config import MCPServerConfig
from sidecar.ai.mcp.transport_stdio import StdioMCPTransport
from sidecar.ai.tools.sanitization import sanitize_tool_output

_PREFIX = os.environ.get("JENNY_REA_PROBE_PREFIX", "")
pytestmark = pytest.mark.skipif(
    sys.platform != "win32"
    or os.environ.get("JENNY_REA_PROBE") != "1"
    or not _PREFIX
    or not Path(_PREFIX).is_dir(),
    reason="opt-in Windows probe: needs JENNY_REA_PROBE=1 and JENNY_REA_PROBE_PREFIX",
)

_NODE_DIR = r"C:\Program Files\nodejs"
_REA_ARGS = ("-y", "rea-agents@6.4.0", "mcp")
_EXPECTED_TOOLS = 170


def _forms() -> dict[str, tuple[str, tuple[str, ...]]]:
    rea_script = str(Path(_PREFIX) / "node_modules" / "rea-agents" / "scripts" / "rea.mjs")
    return {
        "A_npx_cmd_absolute": (rf"{_NODE_DIR}\npx.cmd", _REA_ARGS),
        "B_npx_bare": ("npx", _REA_ARGS),
        "C_cmd_exe_c_npx": ("cmd.exe", ("/d", "/c", "npx", *_REA_ARGS)),
        "D_node_exe_script": (rf"{_NODE_DIR}\node.exe", (rea_script, "mcp")),
    }


def _powershell(script: str) -> str:
    done = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True, text=True, timeout=60, check=False,
    )
    return done.stdout


def _process_tree(root_pid: int) -> list[dict[str, Any]]:
    """Descendants of ``root_pid`` as ``{pid, parent, name}`` rows (breadth first)."""
    rows: list[dict[str, Any]] = []
    frontier = [root_pid]
    while frontier:
        parent = frontier.pop(0)
        raw = _powershell(
            f'Get-CimInstance Win32_Process -Filter "ParentProcessId={parent}" '
            "| Select-Object ProcessId,Name | ConvertTo-Json -Compress"
        ).strip()
        if not raw:
            continue
        found = json.loads(raw)
        for item in found if isinstance(found, list) else [found]:
            rows.append({"pid": item["ProcessId"], "parent": parent, "name": item["Name"]})
            frontier.append(item["ProcessId"])
    return rows


def _alive(pids: list[int]) -> list[int]:
    if not pids:
        return []
    listing = _powershell(
        "Get-Process -Id " + ",".join(str(pid) for pid in pids) + " -ErrorAction SilentlyContinue "
        "| Select-Object -ExpandProperty Id"
    )
    return [int(token) for token in listing.split() if token.isdigit()]


def _probe(command: str, args: tuple[str, ...]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "initialized": False, "seconds_to_tools": None, "tool_count": None,
        "error_type": None, "error": None, "root_pid": None, "children": [], "leaked_pids": [],
    }
    config = MCPServerConfig(
        name="rea_probe", transport="stdio", command=command, args=args,
        request_timeout_seconds=180, memory_limit_mb=2048, max_processes=16,
    )
    started = time.monotonic()
    transport: StdioMCPTransport | None = None
    try:
        transport = StdioMCPTransport(config)
        result["root_pid"] = transport._process.pid
        tools = transport.list_tools()
        result["seconds_to_tools"] = round(time.monotonic() - started, 2)
        result["tool_count"] = len(tools)
        result["initialized"] = bool(transport._initialized)
    except Exception as error:  # noqa: BLE001 - the failure is the observation
        result["error_type"] = type(error).__name__
        result["error"] = sanitize_tool_output(str(error), max_chars=1500, tool_name="mcp_stdio")
        result["seconds_to_failure"] = round(time.monotonic() - started, 2)
        if transport is not None:
            result["initialized"] = bool(transport._initialized)
    finally:
        if transport is not None:
            result["children"] = _process_tree(transport._process.pid)
            transport.close()
            watched = [result["root_pid"], *(row["pid"] for row in result["children"])]
            time.sleep(1.0)
            result["leaked_pids"] = _alive(watched)
    return result


@pytest.mark.parametrize("form", list(_forms()))
def test_launch_form_against_rea(form: str, tmp_path_factory: pytest.TempPathFactory) -> None:
    command, args = _forms()[form]
    outcome = {"form": form, "command": command, "args": list(args), **_probe(command, args)}
    results = tmp_path_factory.getbasetemp() / "npx-probe-results.jsonl"
    with results.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(outcome) + "\n")

    if outcome["tool_count"] is None:
        assert outcome["error_type"] and outcome["error"] is not None
    else:
        assert outcome["tool_count"] == _EXPECTED_TOOLS
    if form.startswith("D_"):
        assert outcome["tool_count"] == _EXPECTED_TOOLS, outcome["error"]
