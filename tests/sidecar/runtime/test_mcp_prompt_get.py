"""Versioned prompt fetch, client validation, and off-loop routing."""

import json
import logging
import threading
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import MCPServerConfig
from sidecar.ai.error_codes import (
    CMP_MCP_CONFIG_INVALID,
    CMP_MCP_SERVER_FAILED,
    CMP_MCP_TOOL_NOT_FOUND,
)
from sidecar.ai.mcp.client import MCPClient
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.tool_surface import ToolSurfaceError
from sidecar.protocol import API_VERSION, MCP_PROMPT_GET_METHOD
from sidecar.runtime import request_dispatch_mcp as dispatch
from sidecar.runtime import server_auxiliary_workers as workers
from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.outcomes import ProcessOutcome


class _PromptTransport:
    def __init__(self) -> None:
        self.rows = [{"name": "investigate_feature", "arguments": [
            {"name": "feature", "required": True}]}]
        self.result = {"messages": [{"content": {"type": "text", "text": "rendered"}}]}
        self.calls: list[Any] = []
        self.error: Exception | None = None

    def list_prompts(self, **kwargs: Any) -> list:
        self.calls.append(("list", kwargs))
        if self.error is not None:
            raise self.error
        return self.rows

    def get_prompt(self, name: str, arguments: dict, **kwargs: Any) -> dict:
        self.calls.append(("get", name, arguments, kwargs))
        return self.result


@pytest.fixture
def connected() -> tuple[MCPClient, _PromptTransport]:
    client = MCPClient()
    transport = _PromptTransport()
    client._transports["rea"] = transport  # type: ignore[assignment]
    client._server_configs["rea"] = MCPServerConfig(name="rea", transport="stdio", command="node", request_timeout_seconds=9)
    return client, transport


def _dispatch(client: Any, params: Any) -> dict:
    brain = SimpleNamespace(stack=SimpleNamespace(mcp_client=client))
    outcome = dispatch.process_mcp_method(MCP_PROMPT_GET_METHOD, 501, params, True, brain, None)
    assert outcome is not None and outcome.response is not None
    assert outcome.notifications == []
    return outcome.response


def _params(**overrides: Any) -> dict:
    return {"accept_version": API_VERSION, "server": "rea", "name": "investigate_feature",
            "arguments": {"feature": "secret-value"}, **overrides}


def test_version_mismatch() -> None:
    response = _dispatch(SimpleNamespace(), _params(accept_version="older"))
    assert response["error"]["data"]["code"] == "CMP-PROTO-0001"


@pytest.mark.parametrize("params", [None, []])
def test_non_object_params_fail_the_handshake_like_inspect(params: Any) -> None:
    response = _dispatch(SimpleNamespace(), params)
    assert "error" in response and "result" not in response


@pytest.mark.parametrize("params", [_params(server=None), _params(name=1),
    _params(arguments=[]), _params(arguments={"feature": 1}), _params(arguments={1: "secret-value"}),
    {"accept_version": API_VERSION, "name": "x", "arguments": {}}])
def test_invalid_params(params: Any) -> None:
    response = _dispatch(SimpleNamespace(), params)
    assert response["result"]["failure"] == {"code": CMP_MCP_CONFIG_INVALID, "reason": "params_invalid"}
    assert "secret-value" not in json.dumps(response)


def test_missing_mcp_client_is_an_explicit_failure() -> None:
    response = _dispatch(None, _params())
    assert response["result"]["failure"] == {"code": CMP_MCP_SERVER_FAILED,
                                             "reason": "mcp_unavailable", "retryable": False}


def test_success_with_stub_client() -> None:
    calls = []
    def get_prompt(server: str, name: str, arguments: dict, **kwargs: Any) -> str:
        calls.append((server, name, arguments, kwargs))
        return "first\n\nsecond"
    response = _dispatch(SimpleNamespace(get_prompt=get_prompt), _params())
    assert response["result"] == {"ok": True, "server": "rea", "name": "investigate_feature",
        "text": "first\n\nsecond", "chars": 13, "api_version": API_VERSION}
    assert calls[0][:3] == ("rea", "investigate_feature", {"feature": "secret-value"})
    assert isinstance(calls[0][3]["cancel_handle"], TurnCancellationHandle)


@pytest.mark.parametrize(("overrides", "code"), [
    ({"server": "absent"}, CMP_MCP_SERVER_FAILED),
    ({"name": "absent"}, CMP_MCP_TOOL_NOT_FOUND),
    ({"name": "Upper"}, CMP_MCP_CONFIG_INVALID),
    ({"arguments": {}}, CMP_MCP_CONFIG_INVALID),
    ({"arguments": {"feature": ""}}, CMP_MCP_CONFIG_INVALID),
    ({"arguments": {"feature": "secret-value" * 400}}, CMP_MCP_CONFIG_INVALID),
    ({"arguments": {"feature": "   "}}, CMP_MCP_CONFIG_INVALID),
    ({"arguments": {"feature": "x", "extra": "secret-value"}}, CMP_MCP_CONFIG_INVALID),
    ({"arguments": {"Feature": "secret-value"}}, CMP_MCP_CONFIG_INVALID),
    ({"arguments": {f"k{i}": "v" for i in range(17)}}, CMP_MCP_CONFIG_INVALID),
])
def test_client_validation_through_dispatch(connected: Any, overrides: dict, code: str) -> None:
    client, transport = connected
    response = _dispatch(client, _params(**overrides))
    assert response["result"]["failure"] == {"code": code, "reason": "prompt_failed", "retryable": False}
    assert "secret-value" not in json.dumps(response)
    assert all(call[0] != "get" for call in transport.calls)


def test_required_argument_error_names_first_missing_argument(connected: Any) -> None:
    client, _transport = connected
    with pytest.raises(MCPError, match="feature"):
        client.get_prompt("rea", "investigate_feature", {})


def test_client_timeout_and_cancel_forwarding(connected: Any) -> None:
    client, transport = connected
    handle = TurnCancellationHandle(request_id="prompt")
    assert client.get_prompt("rea", "investigate_feature", {"feature": "x" * 4096}, cancel_handle=handle) == "rendered"
    assert transport.calls[0] == ("list", {"cancel_handle": handle})
    assert transport.calls[1][3] == {"timeout_seconds": 9, "cancel_handle": handle}
    assert client._tools_by_name == {}


def test_fetch_timeout_never_exceeds_the_server_request_timeout(connected: Any) -> None:
    client, transport = connected
    client._request_timeout_seconds = 120
    client.get_prompt("rea", "investigate_feature", {"feature": "x"})
    assert transport.calls[1][3]["timeout_seconds"] == 9
    client._request_timeout_seconds = 4
    client.get_prompt("rea", "investigate_feature", {"feature": "x"})
    assert transport.calls[3][3]["timeout_seconds"] == 4


def test_unsupported_content_through_dispatch(connected: Any) -> None:
    client, transport = connected
    transport.result = {"messages": [{"content": {"type": "image", "data": "secret-value"}}]}
    response = _dispatch(client, _params())
    assert response["result"]["failure"] == {"code": CMP_MCP_SERVER_FAILED,
        "reason": "prompt_content_unsupported", "retryable": False,
        "detail": {"reason": "prompt_content_unsupported"}}
    assert "secret-value" not in json.dumps(response)


@pytest.mark.parametrize("error", [
    MCPError(code=CMP_MCP_SERVER_FAILED, message="secret-value", retryable=True),
    MCPError(code="secret-value", message="server error", response_received=True),
    ToolSurfaceError("prompt_result_invalid"), RuntimeError("secret-value"),
])
def test_failure_never_echoes_exception_or_arguments(error: Exception) -> None:
    def get_prompt(*_a: Any, **_k: Any) -> str:
        raise error
    response = _dispatch(SimpleNamespace(get_prompt=get_prompt), _params())
    assert response["result"]["ok"] is False
    assert "secret-value" not in json.dumps(response)
    if isinstance(error, MCPError):
        assert response["result"]["failure"]["code"] == CMP_MCP_SERVER_FAILED


def test_cancelled_fetch_and_registry_cleanup() -> None:
    handle, created = dispatch.prepare_mcp_inspection(501)
    assert created
    handle.cancel(reason="sidecar_cancel")
    def get_prompt(*_a: Any, cancel_handle: Any, **_k: Any) -> str:
        cancel_handle.raise_if_cancelled()
        return "unreachable"
    response = _dispatch(SimpleNamespace(get_prompt=get_prompt), _params())
    assert response["result"]["failure"]["reason"] == "prompt_cancelled"
    assert dispatch.cancel_mcp_inspection(501) is False
    fresh, created = dispatch.prepare_mcp_inspection(501)
    assert created  # the registry no longer holds the cancelled entry
    dispatch.complete_mcp_inspection(501, fresh)


def test_transport_failure_is_not_retried_or_reconnected(connected: Any, monkeypatch: Any) -> None:
    client, transport = connected
    transport.error = MCPError(code=CMP_MCP_SERVER_FAILED, message="terminated", retryable=True)
    def forbidden(*_a: Any, **_k: Any) -> Any:
        pytest.fail("prompt fetch must not reconnect")
    monkeypatch.setattr(client, "_reconnect_transport", forbidden)
    response = _dispatch(client, _params())
    assert response["result"]["failure"]["retryable"] is True
    assert len(transport.calls) == 1


def test_prompt_worker_routing_duplicate_limit_and_cancellation() -> None:
    started, release = threading.Event(), threading.Event()
    mcp_workers: set[Any] = set()
    controls: list[dict] = []
    transport = SimpleNamespace(send_control=controls.append)
    def request_runner(message: dict, initialized: bool) -> ProcessOutcome:
        started.set()
        assert release.wait(2)
        return ProcessOutcome(initialized, False, {"id": message["id"], "result": {}}, [])
    def route(message_id: int) -> bool:
        return workers.route_auxiliary_request(method=MCP_PROMPT_GET_METHOD,
            message={"jsonrpc": "2.0", "id": message_id, "method": MCP_PROMPT_GET_METHOD},
            multiplexer=None, direct_transport=transport, hardware_worker_threads=set(),
            compact_worker_threads=set(), mcp_worker_threads=mcp_workers,
            request_runner=request_runner, send_outcome=lambda *_a, **_k: None,
            write_outcome_direct=lambda outcome: controls.append(outcome.response),
            logger=logging.getLogger(__name__))
    try:
        assert MCP_PROMPT_GET_METHOD in workers.AUXILIARY_WORKER_METHODS
        assert route(601)
        assert started.wait(1)
        assert len(mcp_workers) == 1
        assert route(601) is False
        assert controls[0]["error"]["code"] == -32600
        assert "mcp.prompt_get" in controls[0]["error"]["message"]
        assert route(602) is False
        assert dispatch.cancel_mcp_inspection(601) is True
    finally:
        release.set()
        workers.join_auxiliary_workers(worker_threads=mcp_workers, timeout_seconds=1,
            logger=logging.getLogger(__name__))
