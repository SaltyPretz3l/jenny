from dataclasses import replace

import pytest

from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.routing.tool_resource_deferral import ToolResourceDeferred
from sidecar.runtime.electron_tool_bridge import ElectronToolBridgeRequest, execute_electron_tool

TOKEN = "11111111-1111-1111-1111-111111111111"


def fixture(payload):
    events = []
    messages = []

    def write(message):
        events.append("write:" + message["params"].get("runtime_resource_gate", {}).get("phase", "legacy"))
        messages.append(message)

    def factory(rpc_id, **_kwargs):
        def read(_timeout):
            result = payload if len(messages) == 1 else {"success": True, "output": "done"}
            return {"id": rpc_id, "result": result}
        read.close = lambda: events.append("close")
        return read

    request = ElectronToolBridgeRequest(
        tool_name="jenny_status", arguments={}, request_id="request_1", trace_id=None,
        session_id="session_1", tool_call_id="call_1", write_message=write, read_message=None,
        response_reader_factory=factory, before_resource_start=lambda: events.append("executing"),
    )
    return request, events, messages


def test_ready_closes_reader_then_announces_execution_before_one_use_start():
    request, events, messages = fixture({"runtime_resource_ready": {
        "schema_version": 1, "operation_id": "call_1", "token": TOKEN,
    }})
    assert execute_electron_tool(request).success
    assert events == ["write:prepare", "close", "executing", "write:start", "close"]
    assert messages[0]["id"] != messages[1]["id"]
    assert messages[1]["params"]["runtime_resource_gate"]["token"] == TOKEN


def test_wait_closes_reader_without_execution_or_acknowledgement():
    request, events, messages = fixture({"runtime_resource_wait": {
        "schema_version": 1, "operation_id": "call_1", "status": "waiting",
        "resource_class": "tool_operations", "dependency_id": None,
    }})
    with pytest.raises(ToolResourceDeferred) as error:
        execute_electron_tool(request)
    assert error.value.wait.operation_id == "call_1"
    assert events == ["write:prepare", "close"]
    assert len(messages) == 1


@pytest.mark.parametrize("payload", [
    {"runtime_resource_ready": {"schema_version": True, "operation_id": "call_1", "token": TOKEN}},
    {"runtime_resource_ready": {"schema_version": 1, "operation_id": "other", "token": TOKEN}},
    {"runtime_resource_ready": {"schema_version": 1, "operation_id": "call_1", "token": "bad"}},
    {"runtime_resource_wait": {"schema_version": 1, "operation_id": "call_1", "status": "waiting",
                               "resource_class": "unknown", "dependency_id": None}},
    {"runtime_resource_ready": {"schema_version": 1, "operation_id": "call_1", "token": TOKEN}, "extra": True},
])
def test_malformed_gate_never_acknowledged(payload):
    request, events, _ = fixture(payload)
    with pytest.raises(MCPError):
        execute_electron_tool(request)
    assert events == ["write:prepare", "close"]


def test_legacy_response_cannot_enable_gate():
    request, events, _ = fixture({"runtime_resource_ready": {
        "schema_version": 1, "operation_id": "call_1", "token": TOKEN,
    }})
    with pytest.raises(MCPError):
        execute_electron_tool(replace(request, before_resource_start=None))
    assert events == ["write:legacy", "close"]
