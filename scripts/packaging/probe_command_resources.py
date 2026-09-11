"""Compare native desktop command memory with the former outer MCP ceiling."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sidecar.ai.config import RuntimeConfig  # noqa: E402
from sidecar.ai.container_mcp_servers import _default_mcp_servers  # noqa: E402
from sidecar.ai.mcp.transport_stdio import StdioMCPTransport  # noqa: E402
from sidecar.runtime.process_containment import process_exists  # noqa: E402

ALLOCATION_MIB = 768


def _check_native_cleanup(transport: StdioMCPTransport, root: Path) -> None:
    (root / "child.py").write_text(
        f"import os,time\nfrom pathlib import Path\ndata=bytearray({ALLOCATION_MIB}*1024*1024)\n"
        "Path('child.pid').write_text(str(os.getpid()))\ntime.sleep(60)\n", encoding="utf-8"
    )
    (root / "parent.py").write_text(
        "import subprocess,sys,time\nsubprocess.Popen([sys.executable,'child.py'])\n"
        "time.sleep(60)\n", encoding="utf-8"
    )
    for action in ("cancel", "shutdown"):
        marker = root / "child.pid"
        marker.unlink(missing_ok=True)
        response = transport.call_tool("run_command", {
            "command": "python parent.py", "run_in_background": True, "timeout_seconds": 60,
        })
        assert not response.get("isError"), response
        receipt = json.loads(response["content"][0]["text"])
        deadline = time.monotonic() + 10
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert marker.exists(), "large-memory descendant did not start"
        pid = int(marker.read_text())
        assert process_exists(pid)
        if action == "cancel":
            response = transport.call_tool("stop_background_job", {"job_id": receipt["job_id"]})
            assert "cancelled" in response["content"][0]["text"], response
        else:
            transport.close()
        deadline = time.monotonic() + 10
        while process_exists(pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not process_exists(pid), f"descendant survived {action}"


def run_probe(artifact: Path | None = None) -> list[dict]:
    """Use real config assembly, MCP containment and command execution."""
    if sys.platform != "win32":
        raise RuntimeError("This probe qualifies Windows inherited job limits")
    old_path = os.environ.get("PATH", "")
    evidence = []
    try:
        with tempfile.TemporaryDirectory(prefix="jenny-resource-probe-") as temporary:
            root = Path(temporary)
            config = RuntimeConfig(
                tools_shell_enabled=True, operation_ledger_root=str(root / "ledger")
            )
            native = _default_mcp_servers(config, root)[0]
            assert native.memory_limit_mb is None
            if artifact is not None:
                artifact = artifact.resolve(strict=True)
                os.environ["PATH"] = str(artifact.parent) + os.pathsep + old_path
                native = replace(native, command=artifact.name,
                                 args=("--mcp-builtin-server", *native.args[2:]))
            for label, server in (("former_512_mib", replace(native, memory_limit_mb=512)),
                                  ("native_desktop", native)):
                transport = StdioMCPTransport(server)
                try:
                    response = transport.call_tool("run_command", {
                        "command": (
                            f'python -c "data=bytearray({ALLOCATION_MIB}*1024*1024); '
                            'print(len(data))"'
                        ),
                        "timeout_seconds": 30,
                    }, timeout_seconds=45)
                    result = json.loads(response["content"][0]["text"])
                    if server.memory_limit_mb is None:
                        assert not response.get("isError"), response
                        assert result["exit_code"] == 0, result
                        assert str(ALLOCATION_MIB * 1024 * 1024) in result["stdout"], result
                    else:
                        assert result["exit_code"] != 0, result
                        assert "MemoryError" in result["stderr"], result
                    followup = transport.call_tool("run_command", {"command": "echo still-alive"})
                    assert not followup.get("isError"), followup
                    assert "still-alive" in followup["content"][0]["text"]
                    evidence.append({"mode": label, "allocation_mib": ALLOCATION_MIB,
                                     "exit_code": result["exit_code"], "subsequent_call": "passed"})
                    if server.memory_limit_mb is None:
                        _check_native_cleanup(transport, root)
                        evidence[-1]["cancellation_and_shutdown"] = "passed"
                finally:
                    transport.close()
    finally:
        os.environ["PATH"] = old_path
    return evidence


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path)
    args = parser.parse_args()
    print(json.dumps(run_probe(args.artifact), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
