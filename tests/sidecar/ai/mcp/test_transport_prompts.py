"""Prompt transport wire shapes and pagination guards."""

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.error_codes import CMP_MCP_PROTOCOL_FAILED
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.transport_base import _MAX_TOOL_PAGES, StdioPromptsMixin
from sidecar.ai.mcp.transport_sse import SSEMCPTransport
from sidecar.ai.mcp.transport_stdio import StdioMCPTransport
from sidecar.runtime.multiplexer import TurnCancellationHandle


def _transport(monkeypatch: Any, request: Any) -> StdioMCPTransport:
    transport = object.__new__(StdioMCPTransport)
    transport._config = SimpleNamespace(name="rea")
    transport._request_timeout_seconds = 10.0
    monkeypatch.setattr(transport, "_ensure_initialized", lambda **_k: None)
    monkeypatch.setattr(transport, "_send_request", request)
    assert isinstance(transport, StdioPromptsMixin)
    return transport


def test_prompt_pages_forward_cursor_cancel_and_budget(monkeypatch: Any) -> None:
    calls = []
    replies = iter([
        {"result": {"prompts": [{"name": "a"}], "nextCursor": "next"}},
        {"result": {"prompts": [{"name": "b"}]}}
    ])
    def request(method: str, params: dict, **kwargs: Any) -> dict:
        calls.append((method, params, kwargs))
        return next(replies)
    handle = TurnCancellationHandle(request_id="pages")
    transport = _transport(monkeypatch, request)
    assert transport.list_prompts(cancel_handle=handle) == [{"name": "a"}, {"name": "b"}]
    assert [(m, p) for m, p, _ in calls] == [("prompts/list", {}), ("prompts/list", {"cursor": "next"})]
    assert all(k["cancel_handle"] is handle and 0 < k["timeout_seconds"] <= 10 for _, _, k in calls)


@pytest.mark.parametrize("cursor", ["repeat", "x" * 4097, 7])
def test_prompt_cursor_bounds(monkeypatch: Any, cursor: Any) -> None:
    transport = _transport(monkeypatch, lambda *_a, **_k: {"result": {"prompts": [], "nextCursor": cursor}})
    with pytest.raises(MCPError, match="prompt.*pagination") as error:
        transport.list_prompts()
    assert error.value.code == CMP_MCP_PROTOCOL_FAILED


def test_prompt_page_limit(monkeypatch: Any) -> None:
    calls = []
    def request(*_a: Any, **_k: Any) -> dict:
        calls.append(True)
        return {"result": {"prompts": [], "nextCursor": str(len(calls))}}
    transport = _transport(monkeypatch, request)
    with pytest.raises(MCPError, match="prompt.*pagination"):
        transport.list_prompts()
    assert len(calls) == _MAX_TOOL_PAGES


def test_invalid_prompt_list_result(monkeypatch: Any) -> None:
    transport = _transport(monkeypatch, lambda *_a, **_k: {"result": None})
    with pytest.raises(MCPError, match="invalid prompts/list result"):
        transport.list_prompts()


def test_get_prompt_returns_raw_result(monkeypatch: Any) -> None:
    calls = []
    result = {"description": "rendered", "messages": []}
    def request(method: str, params: dict, **kwargs: Any) -> dict:
        calls.append((method, params, kwargs))
        return {"result": result}
    transport = _transport(monkeypatch, request)
    handle = TurnCancellationHandle(request_id="get")
    assert transport.get_prompt("investigate_feature", {"feature": "value"}, timeout_seconds=4, cancel_handle=handle) is result
    assert calls == [("prompts/get", {"name": "investigate_feature", "arguments": {"feature": "value"}}, {"timeout_seconds": 4, "cancel_handle": handle})]


def test_get_prompt_requires_a_result_object(monkeypatch: Any) -> None:
    transport = _transport(monkeypatch, lambda *_a, **_k: {"result": None})
    with pytest.raises(MCPError, match="invalid prompts/get result"):
        transport.get_prompt("feature", {})


def test_cancelled_pagination_never_sends_a_request(monkeypatch: Any) -> None:
    def forbidden(*_a: Any, **_k: Any) -> dict:
        pytest.fail("cancelled listing sent a request")
    transport = _transport(monkeypatch, forbidden)
    handle = TurnCancellationHandle(request_id="cancelled")
    handle.cancel(reason="sidecar_cancel")
    from sidecar.runtime.chat_models import TerminalChatStateError

    with pytest.raises(TerminalChatStateError):
        transport.list_prompts(cancel_handle=handle)


def test_sse_prompts_are_unavailable() -> None:
    transport = object.__new__(SSEMCPTransport)
    assert transport.list_prompts() == []
    with pytest.raises(MCPError) as error:
        transport.get_prompt("feature", {})
    assert error.value.code == CMP_MCP_PROTOCOL_FAILED
    assert error.value.retryable is False
    assert error.value.message == "MCP prompts are not supported over SSE"
