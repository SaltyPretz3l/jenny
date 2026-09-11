"""Headless, disposable-workspace qualification of the actual builtin MCP server."""

from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sidecar.ai.config import MCPServerConfig  # noqa: E402
from sidecar.ai.mcp.process_containment import _minimal_env  # noqa: E402

FAILURE_EXIT_CODE = 7
UNICODE_TEXT = "Arrow \u2192 caf\u00e9 \u4e2d\u6587 \U0001f642\n"
UNICODE_PATH = "read-\u4e2d\u6587.txt"


class ToolProbe:
    """Bounded JSON-line client; drains both pipes and owns only its child."""

    def __init__(self, command: list[str], workspace: Path, *, desktop_env: bool = False):
        config = MCPServerConfig(
            name="jenny_local_tools",
            transport="stdio",
            command=command[0],
            args=("--host-mode", "desktop"),
        )
        env = (
            _minimal_env(config, command_path=Path(command[0]).resolve())
            if desktop_env
            else dict(os.environ)
        )
        env["PYTHONIOENCODING"] = "cp1252"
        self.process = subprocess.Popen(
            [*command, "--workspace-root", str(workspace), "--shell-enabled", "1"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=ROOT,
            env=env,
        )
        self.lines: queue.Queue[bytes | None] = queue.Queue(maxsize=128)
        self.stderr = bytearray()
        self.sequence = 0
        self.notifications: list[dict] = []
        self.readers = [
            threading.Thread(target=self._read_stdout, daemon=True),
            threading.Thread(target=self._read_stderr, daemon=True),
        ]
        for reader in self.readers:
            reader.start()

    def _read_stdout(self):
        for line in self.process.stdout:
            try:
                self.lines.put(line, timeout=5)
            except queue.Full:
                return
        self.lines.put(None, timeout=5)

    def _read_stderr(self):
        for line in self.process.stderr:
            self.stderr.extend(line)
            del self.stderr[:-8192]

    def request(
        self, method: str, params: dict, timeout: float = 45, *, allow_failure: bool = False
    ) -> dict:
        self.sequence += 1
        request = {"jsonrpc": "2.0", "id": self.sequence, "method": method, "params": params}
        self.process.stdin.write((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
        self.process.stdin.flush()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                line = self.lines.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty as error:
                raise RuntimeError(f"Probe timed out: {method}") from error
            if line is None:
                raise RuntimeError(f"Tool server exited: {self.stderr.decode('utf-8', 'replace')}")
            response = json.loads(line.decode("utf-8"))
            if response.get("id") != self.sequence:
                self.notifications.append(response)
                self.notifications = self.notifications[-128:]
                continue
            if "error" in response:
                raise RuntimeError(f"Probe RPC failed: {response['error']}")
            result = response["result"]
            if result.get("isError") and not allow_failure:
                raise RuntimeError(f"Probe tool failed: {result}")
            return result
        raise RuntimeError(f"Probe deadline exhausted: {method}")

    def call(self, name: str, **arguments) -> dict:
        return self.request("tools/call", {"name": name, "arguments": arguments})

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=10)
        for reader in self.readers:
            reader.join(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()


def result_text(result: dict) -> str:
    return "\n".join(item.get("text", "") for item in result.get("content", []))


def run_probe(
    command: list[str], *, desktop_env: bool = False, long_seconds: float = 0
) -> list[str]:
    evidence = []
    with tempfile.TemporaryDirectory(prefix="jenny-tool-probe-") as temporary:
        workspace = Path(temporary)
        probe = ToolProbe(command, workspace, desktop_env=desktop_env)
        try:
            probe.request("initialize", {})
            probe.call("write_file", path=UNICODE_PATH, content=UNICODE_TEXT)
            read = probe.call("read_file", path=UNICODE_PATH)
            assert UNICODE_TEXT.strip() in result_text(read)
            assert UNICODE_PATH in result_text(probe.call("list_dir", path="."))
            assert UNICODE_PATH in result_text(probe.call("glob_files", pattern="*.txt"))
            probe.call(
                "edit_file", file_path=UNICODE_PATH, old_string="Arrow", new_string="Changed"
            )
            assert (workspace / UNICODE_PATH).read_text(encoding="utf-8") == UNICODE_TEXT.replace(
                "Arrow", "Changed"
            )
            probe.call("move_file", source=UNICODE_PATH, destination="moved.txt")
            assert not (workspace / UNICODE_PATH).exists()
            probe.call("delete_file", path="moved.txt")
            assert not (workspace / "moved.txt").exists()
            script = "echo temp-script-ok"
            assert "temp-script-ok" in result_text(probe.call("run_temp_script", script=script))
            probe.call("write_file", path="after.txt", content=UNICODE_TEXT)
            assert UNICODE_TEXT.strip() in result_text(probe.call("read_file", path="after.txt"))
            evidence.append("unicode + read/write/list/glob/edit/move/delete/temp-script")
            if desktop_env:
                for tool in ("python --version", "node --version", "npm --version"):
                    result = json.loads(
                        result_text(probe.call("run_command", command=tool, timeout_seconds=30))
                    )
                    assert result["exit_code"] == 0, result
                    evidence.append(tool)
                run_lifecycle_probe(probe, workspace)
                evidence.append("background failure/timeout/cancellation/partial-output")
            if long_seconds:
                run_router_background_probe(command, workspace, long_seconds)
                evidence.append(f"background survived {long_seconds:g}s and completed")
        finally:
            probe.close()
    return evidence


def run_lifecycle_probe(probe: ToolProbe, workspace: Path) -> None:
    """Prove negative terminal outcomes through the same packaged server."""

    def state(job_id):
        return json.loads(
            result_text(
                probe.request(
                    "tools/call",
                    {"name": "check_background_job", "arguments": {"job_id": job_id}},
                    allow_failure=True,
                )
            )
        )

    def wait_terminal(job_id):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            result = state(job_id)
            if result["state"] != "running":
                return result
            time.sleep(0.05)
        raise RuntimeError("Lifecycle probe did not settle")

    receipt = json.loads(
        result_text(
            probe.call(
                "run_command",
                command='python -c "raise SystemExit(7)"',
                run_in_background=True,
                timeout_seconds=30,
            )
        )
    )
    failed = wait_terminal(receipt["job_id"])
    assert failed["state"] == "failed" and failed["exit_code"] == FAILURE_EXIT_CODE, failed
    source = "import time\nprint('partial-output', flush=True)\ntime.sleep(30)\n"
    probe.call("write_file", path="timeout.py", content=source)
    receipt = json.loads(
        result_text(
            probe.call(
                "run_command",
                command="python timeout.py",
                run_in_background=True,
                timeout_seconds=2,
            )
        )
    )
    timed_out = wait_terminal(receipt["job_id"])
    assert timed_out["state"] == "failed" and "timed out" in timed_out["error"], timed_out
    assert "partial-output" in timed_out["stdout"], timed_out
    receipt = json.loads(
        result_text(
            probe.call(
                "run_command",
                command="python timeout.py",
                run_in_background=True,
                timeout_seconds=5400,
            )
        )
    )
    stopped = json.loads(result_text(probe.call("stop_background_job", job_id=receipt["job_id"])))
    assert stopped["state"] == "failed" and "cancelled" in stopped["error"], stopped


def run_shutdown_probe(command: list[str]) -> None:
    from sidecar.runtime.process_containment import process_exists  # noqa: PLC0415

    with tempfile.TemporaryDirectory(prefix="jenny-shutdown-probe-") as temporary:
        root = Path(temporary)
        probe = ToolProbe(command, root, desktop_env=True)
        try:
            probe.request("initialize", {})
            probe.call(
                "write_file",
                path="child.py",
                content=(
                    "import os,time\nfrom pathlib import Path\n"
                    "Path('child.pid').write_text(str(os.getpid()))\ntime.sleep(60)\n"
                ),
            )
            probe.call(
                "write_file",
                path="parent.py",
                content=(
                    "import subprocess,sys,time\nsubprocess.Popen([sys.executable, 'child.py'])\n"
                    "time.sleep(60)\n"
                ),
            )
            probe.call(
                "run_command",
                command="python parent.py",
                run_in_background=True,
                timeout_seconds=5400,
            )
            deadline = time.monotonic() + 10
            marker = root / "child.pid"
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            assert marker.exists(), "child did not start"
            pid = int(marker.read_text())
            assert process_exists(pid), "child positive control failed"
        finally:
            probe.close()
        deadline = time.monotonic() + 10
        while process_exists(pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not process_exists(pid), "child survived packaged server shutdown"


def run_router_background_probe(command: list[str], workspace: Path, duration: float) -> None:  # noqa: PLC0415
    """A completed production router turn must leave its packaged background job alive."""
    from sidecar.ai.config import RuntimeConfig  # noqa: PLC0415 - optional long-run probe
    from sidecar.ai.context.builder import ContextBuilder  # noqa: PLC0415
    from sidecar.ai.engines.mock import MockEngine  # noqa: PLC0415
    from sidecar.ai.mcp.client import MCPClient  # noqa: PLC0415
    from sidecar.ai.routing.router import ChatRouter  # noqa: PLC0415
    from sidecar.ai.tools.models import GenerationResult, ToolCallRequest  # noqa: PLC0415

    old_path = os.environ.get("PATH", "")
    executable = Path(command[0]).resolve()
    os.environ["PATH"] = str(executable.parent) + os.pathsep + old_path
    client = MCPClient()
    try:
        client.configure(
            (
                MCPServerConfig(
                    name="jenny_local_tools",
                    transport="stdio",
                    command=executable.name,
                    args=tuple(
                        [
                            *command[1:],
                            "--workspace-root",
                            str(workspace),
                            "--shell-enabled",
                            "1",
                            "--host-mode",
                            "desktop",
                        ]
                    ),
                    max_processes=16,
                    cooperative_cancel=True,
                ),
            ),
            sse_enabled=False,
        )
        shell_command = (
            f'python -c "import time; print(123, flush=True); time.sleep({duration}); print(456)"'
        )
        engine = MockEngine(
            tool_call_responses=[
                GenerationResult(
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="run_command",
                            call_id="background-probe",
                            arguments={
                                "command": shell_command,
                                "run_in_background": True,
                                "timeout_seconds": duration + 60,
                            },
                        ),
                    )
                )
            ]
        )
        router = ChatRouter(
            config=RuntimeConfig(
                engine_type="mock",
                model="mock-v1",
                mode="assist",
                tools_enabled=True,
                tools_shell_enabled=True,
                tools_workspace_root=str(workspace),
            ),
            engine=engine,
            mcp_client=client,
            context_builder=ContextBuilder(None),
        )
        decision = router.build_chat_decision(
            request_id="background-probe-turn",
            session_id="background-probe-session",
            messages=[{"role": "user", "content": "Run the bounded background probe."}],
            latest_user_content="Run the bounded background probe.",
            mode="assist",
            approvals_pre_granted=True,
        )
        assert decision.terminal_error_code is None, decision
        assert decision.response_text and decision.tool_results, decision
        result = decision.tool_results[0]
        assert result.success, result
        receipt = json.loads(result.output)
        job_id = receipt["job_id"]
        started = time.monotonic()
        print("PASS: router turn completed; background job still owned", flush=True)
        while time.monotonic() - started < duration + 45:
            result = client.execute_tool(
                "check_background_job", {"job_id": job_id}, timeout_seconds=30
            )
            assert result.success, result
            state = json.loads(result.output)
            if state.get("state") != "running":
                assert state.get("exit_code") == 0, state
                assert "456" in json.dumps(state), state
                assert time.monotonic() - started >= duration - 5
                return
            print(
                f"Background running after turn completion: {time.monotonic() - started:.0f}s",
                flush=True,
            )
            time.sleep(min(30, duration))
        raise RuntimeError("Background job did not settle")
    finally:
        client.close()
        os.environ["PATH"] = old_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--desktop-env", action="store_true")
    parser.add_argument("--long-seconds", type=float, default=0)
    args = parser.parse_args()
    for item in run_probe(
        [str(args.artifact.resolve()), "--mcp-builtin-server"],
        desktop_env=args.desktop_env,
        long_seconds=args.long_seconds,
    ):
        print(f"PASS: {item}", flush=True)
    if args.desktop_env:
        run_shutdown_probe([str(args.artifact.resolve()), "--mcp-builtin-server"])
        print("PASS: packaged shutdown terminates background descendants", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
