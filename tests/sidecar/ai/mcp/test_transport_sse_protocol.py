from __future__ import annotations

import threading
from itertools import count
from typing import Any

import pytest

from sidecar.ai.config import MCPServerConfig
from sidecar.ai.error_codes import CMP_MCP_PROTOCOL_FAILED
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.transport_sse import SSEMCPTransport


def _stub_transport() -> SSEMCPTransport:
    transport = object.__new__(SSEMCPTransport)
    transport._config = MCPServerConfig(  # type: ignore[attr-defined]
        name="remote",
        transport="sse",
        url="https://example.invalid/mcp",
    )
    transport._ids = count(1)  # type: ignore[attr-defined]
    transport._request_lock = threading.Lock()  # type: ignore[attr-defined]
    transport._request_timeout_seconds = None  # type: ignore[attr-defined]
    transport._initialized = False  # type: ignore[attr-defined]
    return transport


@pytest.mark.parametrize(
    "result",
    [None, {}, {"protocolVersion": " "}],
    ids=["nondict", "missing-version", "blank-version"],
)
def test_initialize_rejects_invalid_result_before_notification(
    monkeypatch: pytest.MonkeyPatch,
    result: object,
) -> None:
    transport = _stub_transport()
    notifications: list[str] = []
    monkeypatch.setattr(
        transport,
        "_send",
        lambda *_args, **_kwargs: {"jsonrpc": "2.0", "id": 1, "result": result},
    )
    monkeypatch.setattr(
        transport,
        "_send_notification",
        lambda method, *_args, **_kwargs: notifications.append(method),
    )

    with pytest.raises(MCPError) as excinfo:
        transport._ensure_initialized()  # noqa: SLF001

    assert excinfo.value.code == CMP_MCP_PROTOCOL_FAILED
    assert notifications == []
    assert transport._initialized is False  # noqa: SLF001


@pytest.mark.parametrize(
    "response",
    [{"jsonrpc": "2.0", "result": {}}, {"jsonrpc": "2.0", "id": 99, "result": {}}],
    ids=["missing", "mismatched"],
)
def test_send_rejects_nonmatching_response_id(
    monkeypatch: pytest.MonkeyPatch,
    response: dict[str, Any],
) -> None:
    transport = _stub_transport()
    monkeypatch.setattr(transport, "_post", lambda *_args, **_kwargs: response)

    with pytest.raises(MCPError) as excinfo:
        transport._send("tools/list", {}, timeout_seconds=1.0)  # noqa: SLF001

    assert excinfo.value.code == CMP_MCP_PROTOCOL_FAILED
