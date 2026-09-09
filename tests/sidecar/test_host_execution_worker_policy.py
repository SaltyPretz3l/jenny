from types import SimpleNamespace

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.host_policy import host_tool_decision
from sidecar.ai.routing.tool_resolution import _electron_bridge_runtime_descriptors


def _config(version=2, worker=True, shell=True, workspace="/inputs"):
    return {
        "host_mode": "server",
        "host_execution_policy_version": version,
        "host_execution_worker_enabled": worker,
        "electron_tool_bridge_enabled": True,
        "tools_shell_enabled": shell,
        "tools_workspace_root": workspace,
    }


def test_policy_v1_keeps_run_command_closed():
    allowed, reason = host_tool_decision("run_command", _config(version=1))
    assert allowed is False
    assert reason


def test_policy_v2_requires_worker_bridge_and_workspace():
    descriptor = SimpleNamespace(name="run_command", source_kind="builtin")
    allowed, reason = host_tool_decision(descriptor, _config(worker=False))
    assert allowed is False
    assert "worker" in reason

    allowed, reason = host_tool_decision(descriptor, _config(workspace=""))
    assert allowed is False
    assert "worker" in reason


def test_policy_v2_allows_only_worker_backed_run_command():
    descriptor = SimpleNamespace(name="run_command", source_kind="builtin")
    assert host_tool_decision(descriptor, _config()) == (True, None)


def test_v2_bridge_descriptor_is_absent_until_worker_capability_is_ready():
    unavailable = parse_runtime_config(_config(worker=False))
    assert all(
        descriptor.name != "run_command"
        for descriptor in _electron_bridge_runtime_descriptors(unavailable)
    )

    ready = parse_runtime_config(_config())
    descriptors = _electron_bridge_runtime_descriptors(ready)
    run_command = next(descriptor for descriptor in descriptors if descriptor.name == "run_command")
    assert run_command.server_name == "electron_tool_bridge"


def test_frozen_approval_metadata_stays_out_of_worker_bridge_arguments(monkeypatch):
    from sidecar.ai.routing import tool_execution
    from sidecar.ai.routing.tool_execution_snapshots import freeze_effective_execution_inputs
    from sidecar.runtime.tool_execution_support import ToolCallRequest

    config = parse_runtime_config(_config())
    descriptor = next(d for d in _electron_bridge_runtime_descriptors(config) if d.name == "run_command")
    kernel = SimpleNamespace(_config=config, _mcp_client=SimpleNamespace(tool_descriptor=lambda _: descriptor))
    call = ToolCallRequest(call_id="proof-call", tool_id="run_command", arguments={
        "command": "printf proof", "cwd": ".", "timeout_seconds": 5,
    })
    frozen = freeze_effective_execution_inputs(kernel, call, session_id="proof-session", read_snapshot_cache={})
    assert "_jenny_session_id" in frozen.effective_tool_arguments
    seen = []
    monkeypatch.setattr(tool_execution, "execute_electron_tool", lambda request: seen.append(request))
    tool_execution._dispatch_tool_call(
        kernel=kernel, call=call, tool_arguments=dict(frozen.effective_tool_arguments),
        descriptor=descriptor, request_id="proof-stream", session_id="proof-session",
        runtime=SimpleNamespace(request_context=SimpleNamespace(plan_mode=False, read_only=False)),
        timeout_seconds=60, cancel_handle=None,
    )
    assert seen[0].arguments == call.arguments
    assert seen[0].session_id == "proof-session"
    assert seen[0].request_id == "proof-stream"
    assert seen[0].read_only is False
