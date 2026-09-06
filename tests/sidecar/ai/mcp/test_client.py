from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest

from sidecar.ai.config import MCPServerConfig
from sidecar.ai.mcp import client_support
from sidecar.ai.mcp.client import MCP_FAILURE_HISTORY_LIMIT, MCPClient, _extract_tool_output
from sidecar.ai.mcp.exceptions import CMP_MCP_SERVER_FAILED, MCPError
from sidecar.ai.mcp.transport_base import MCPTransport
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.cooldowns import CooldownRegistry
from sidecar.runtime.multiplexer import TurnCancellationHandle


class _FakeTransport(MCPTransport):
    def __init__(
        self,
        server_name: str,
        tools: list[dict[str, Any]],
        *,
        failures: list[MCPError] | None = None,
    ) -> None:
        self._server_name = server_name
        self._tools = tools
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.cancel_handles: list[Any] = []
        self.failures = list(failures or [])
        self.closed = False

    @property
    def server_name(self) -> str:
        return self._server_name

    def list_tools(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
        del cancel_handle
        return self._tools

    def call_tool(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        *,
        timeout_seconds: float | None = None,
        cancel_handle: Any = None,
    ) -> dict[str, Any]:
        del timeout_seconds
        self.cancel_handles.append(cancel_handle)
        self.calls.append((tool_name, arguments))
        if self.failures:
            raise self.failures.pop(0)
        return {"content": [{"type": "text", "text": f"{tool_name} ok"}]}

    def list_resources(
        self,
        *,
        cursor: str | None = None,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        del cursor, timeout_seconds
        return {"resources": []}

    def read_resource(
        self,
        uri: str,
        *,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        del uri, timeout_seconds
        return {"contents": []}

    def list_resource_templates(
        self,
        *,
        cursor: str | None = None,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        del cursor, timeout_seconds
        return {"resourceTemplates": []}

    def close(self) -> None:
        self.closed = True


def _stdio_config() -> MCPServerConfig:
    return MCPServerConfig(name="docs", transport="stdio", command="python")


def _configured_client(
    monkeypatch: pytest.MonkeyPatch,
    build_results: list[_FakeTransport | MCPError],
    *,
    client: MCPClient | None = None,
) -> MCPClient:
    client = client or MCPClient()
    queued_results = list(build_results)

    def build_transport(server: MCPServerConfig, *, sse_enabled: bool) -> _FakeTransport:
        del server, sse_enabled
        result = queued_results.pop(0)
        if isinstance(result, MCPError):
            raise result
        return result

    monkeypatch.setattr(client, "_build_transport", build_transport)
    client.configure((_stdio_config(),), sse_enabled=False)
    return client


def test_client_refuses_registration_when_approved_tool_surface_drifts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = MCPClient()
    transport = _FakeTransport("docs", [{"name": "lookup", "inputSchema": {"type": "object"}}])
    monkeypatch.setattr(client, "_build_transport", lambda *_args, **_kwargs: transport)
    client.configure((MCPServerConfig(name="docs", transport="stdio", command="python",
                                      approved_tools_digest="0" * 64),), sse_enabled=False)

    diagnostics = client.diagnostics()
    assert diagnostics.connected == ()
    assert len(diagnostics.failures) == 1
    assert diagnostics.failures[0].code == "CMP-MCP-0009"
    assert client.available_tools == []
    assert transport.closed is True


def test_execute_tool_threads_request_cancel_handle_to_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transport = _FakeTransport("docs", [{"name": "lookup", "side_effecting": False}])
    client = _configured_client(monkeypatch, [transport])
    cancel_handle = TurnCancellationHandle(request_id="req-mcp-client")

    client.execute_tool(
        "mcp__docs__lookup",
        {},
        timeout_seconds=2.0,
        cancel_handle=cancel_handle,
    )

    assert transport.cancel_handles == [cancel_handle]


def test_execute_tool_propagates_terminal_cancellation_before_transport_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transport = _FakeTransport("docs", [{"name": "lookup", "side_effecting": False}])
    client = _configured_client(monkeypatch, [transport])
    cancel_handle = TurnCancellationHandle(request_id="req-mcp-client-cancel")
    cancel_handle.cancel(reason="test_cancel")

    with pytest.raises(TerminalChatStateError):
        client.execute_tool(
            "mcp__docs__lookup",
            {},
            timeout_seconds=2.0,
            cancel_handle=cancel_handle,
        )

    assert transport.calls == []


def test_execute_tool_preserves_terminal_result_that_wins_cancellation_race(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cancel_handle = TurnCancellationHandle(request_id="req-mcp-client-committed")

    class _CommittedTransport(_FakeTransport):
        def call_tool(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
            result = super().call_tool(*args, **kwargs)
            cancel_handle.cancel(reason="after_commit")
            return result

    transport = _CommittedTransport(
        "docs",
        [{"name": "write_note", "side_effecting": True}],
    )
    client = _configured_client(monkeypatch, [transport])

    result = client.execute_tool(
        "mcp__docs__write_note",
        {"text": "done"},
        timeout_seconds=2.0,
        cancel_handle=cancel_handle,
    )

    assert result.success is True
    assert result.output == "write_note ok"


def test_extract_tool_output_prefers_explicit_content_type() -> None:
    payload = {
        "content": [{"type": "text", "text": "hello"}],
        "content_type": "mcp_ui",
        "success": True,
    }

    extracted = _extract_tool_output(payload)
    output = extracted["output"]
    content_type = extracted["content_type"]
    ui_payload = extracted["ui_payload"]
    success = extracted["success"]
    generated_artifacts = extracted["generated_artifacts"]
    error_code = extracted["error_code"]
    metadata = extracted["metadata"]

    assert output == "hello"
    assert content_type == "mcp_ui"
    assert ui_payload is None
    assert success is True
    assert generated_artifacts == ()
    assert error_code is None
    assert metadata == {}


def test_extract_tool_output_falls_back_when_content_type_is_invalid() -> None:
    payload = {
        "content": [{"type": "text", "text": "hello"}],
        "content_type": "unknown",
        "ui_payload": {"kind": "table"},
        "success": True,
    }

    extracted = _extract_tool_output(payload)
    content_type = extracted["content_type"]
    generated_artifacts = extracted["generated_artifacts"]
    error_code = extracted["error_code"]
    metadata = extracted["metadata"]

    assert content_type == "mcp_ui"
    assert generated_artifacts == ()
    assert error_code is None
    assert metadata == {}


def test_extract_tool_output_extracts_error_code_and_metadata() -> None:
    payload = {
        "content": [{"type": "text", "text": "File not found: src/missing.py"}],
        "success": False,
        "error_code": "CMP-TOOL-0004",
        "metadata": {"match_count": 0, "truncated": False},
    }

    extracted = _extract_tool_output(payload)
    output = extracted["output"]
    success = extracted["success"]
    error_code = extracted["error_code"]
    metadata = extracted["metadata"]

    assert output == "File not found: src/missing.py"
    assert success is False
    assert error_code == "CMP-TOOL-0004"
    assert metadata == {"match_count": 0, "truncated": False}


def test_extract_tool_output_defaults_error_code_and_metadata_when_absent() -> None:
    payload = {
        "content": [{"type": "text", "text": "ok"}],
        "success": True,
    }

    extracted = _extract_tool_output(payload)
    error_code = extracted["error_code"]
    metadata = extracted["metadata"]

    assert error_code is None
    assert metadata == {}


def test_extract_tool_output_honors_standard_mcp_is_error() -> None:
    extracted = _extract_tool_output(
        {"content": [{"type": "text", "text": "failed"}], "isError": True}
    )

    assert extracted["output"] == "failed"
    assert extracted["success"] is False


def test_descriptor_accepts_standard_mcp_input_schema() -> None:
    descriptor = client_support.descriptor_from_payload(
        "docs",
        {
            "name": "lookup",
            "description": "Search docs",
            "inputSchema": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    )

    assert descriptor is not None
    assert descriptor.input_schema["required"] == ["query"]


def test_client_namespaces_external_tools_and_executes_raw_server_name() -> None:
    client = MCPClient()
    transport = _FakeTransport(
        "remote_docs",
        [{"name": "lookup", "description": "Search docs", "input_schema": {"type": "object"}}],
    )

    client._register_transport(transport)  # noqa: SLF001

    descriptor = client.tool_descriptor("mcp__remote_docs__lookup")
    assert descriptor is not None
    assert descriptor.name == "mcp__remote_docs__lookup"
    assert descriptor.server_tool_name == "lookup"
    assert [item.name for item in client.available_tools] == ["mcp__remote_docs__lookup"]

    result = client.execute_tool("mcp__remote_docs__lookup", {"query": "release"})

    assert result.tool_name == "mcp__remote_docs__lookup"
    assert result.output == "lookup ok"
    assert transport.calls == [("lookup", {"query": "release"})]


def test_client_compat_resolves_unique_bare_external_tool_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[dict[str, Any]] = []

    def _capture_event(
        _logger: logging.Logger,
        _level: int,
        *,
        component: str,
        event: str,
        message: str,
        status: str,
        data: dict[str, Any],
    ) -> None:
        del component, message, status
        events.append({"event": event, "data": data})

    monkeypatch.setattr("sidecar.ai.mcp.client.log_event", _capture_event)
    client = MCPClient()
    transport = _FakeTransport("remote_docs", [{"name": "lookup"}])
    client._register_transport(transport)  # noqa: SLF001

    result = client.execute_tool("lookup", {"query": "release"})

    assert result.tool_name == "mcp__remote_docs__lookup"
    assert transport.calls == [("lookup", {"query": "release"})]
    assert events == [
        {
            "event": "ai.mcp.bare_tool_name_compat",
            "data": {
                "requested_tool": "lookup",
                "resolved_tool": "mcp__remote_docs__lookup",
                "server": "remote_docs",
            },
        }
    ]


def test_client_does_not_compat_resolve_external_builtin_name_collision() -> None:
    client = MCPClient()
    transport = _FakeTransport("remote_docs", [{"name": "read_file"}])
    client._register_transport(transport)  # noqa: SLF001

    assert client.tool_descriptor("read_file") is None
    assert client.tool_descriptor("mcp__remote_docs__read_file") is not None

    with pytest.raises(MCPError, match="read_file"):
        client.execute_tool("read_file", {})

    assert transport.calls == []


@pytest.mark.parametrize("reserved_tool", ["tool_search", "inspect_harness"])
def test_client_does_not_compat_resolve_reserved_synthetic_names(
    reserved_tool: str,
) -> None:
    client = MCPClient()
    transport = _FakeTransport("remote_docs", [{"name": reserved_tool}])
    client._register_transport(transport)  # noqa: SLF001

    assert client.tool_descriptor(reserved_tool) is None
    assert client.tool_descriptor(f"mcp__remote_docs__{reserved_tool}") is not None

    with pytest.raises(MCPError, match=reserved_tool):
        client.execute_tool(reserved_tool, {})

    assert transport.calls == []


def test_client_prevents_namespaced_external_tool_squatting() -> None:
    client = MCPClient()
    transport = _FakeTransport("remote_docs", [{"name": "mcp__notes__lookup"}])
    client._register_transport(transport)  # noqa: SLF001

    descriptor = client.tool_descriptor("mcp__remote_docs__mcp_notes_lookup")
    assert descriptor is not None
    assert descriptor.server_tool_name == "mcp__notes__lookup"
    assert client.tool_descriptor("mcp__notes__lookup") is None

    with pytest.raises(MCPError, match="mcp__notes__lookup"):
        client.execute_tool("mcp__notes__lookup", {})

    result = client.execute_tool("mcp__remote_docs__mcp_notes_lookup", {})

    assert result.tool_name == "mcp__remote_docs__mcp_notes_lookup"
    assert transport.calls == [("mcp__notes__lookup", {})]


def test_client_does_not_compat_resolve_ambiguous_bare_external_name() -> None:
    client = MCPClient()
    first = _FakeTransport("docs", [{"name": "lookup"}])
    second = _FakeTransport("notes", [{"name": "lookup"}])

    client._register_transport(first)  # noqa: SLF001
    client._register_transport(second)  # noqa: SLF001

    assert client.tool_descriptor("lookup") is None
    assert client.tool_descriptor("mcp__docs__lookup") is not None
    assert client.tool_descriptor("mcp__notes__lookup") is not None

    with pytest.raises(MCPError, match="lookup"):
        client.execute_tool("lookup", {})


def test_client_reconnects_and_retries_retryable_read_only_tool_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tools = [{"name": "lookup", "input_schema": {"type": "object"}, "side_effecting": False}]
    first = _FakeTransport(
        "docs",
        tools,
        failures=[
            MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message="mcp server 'docs' closed its pipe unexpectedly",
                retryable=True,
                operation_id="op_failed",
                generation_id="gen_old",
                completion_status="not_started",
            )
        ],
    )
    second = _FakeTransport("docs", tools)
    second.server_generation_id = "gen_new"  # type: ignore[attr-defined]
    client = _configured_client(monkeypatch, [first, second])

    result = client.execute_tool("mcp__docs__lookup", {"query": "release"})

    assert result.output == "lookup ok"
    assert first.closed is True
    assert first.calls == [("lookup", {"query": "release"})]
    assert second.calls == [("lookup", {"query": "release"})]
    assert result.metadata["mcp_retry_count"] == 1
    assert result.metadata["mcp_reconnected_server"] == "docs"
    assert result.metadata["mcp_recovered"] is True
    assert result.metadata["mcp_operation_id"] == "op_failed"
    assert result.metadata["mcp_prior_generation_id"] == "gen_old"
    assert result.metadata["mcp_current_generation_id"] == "gen_new"


def test_client_reconnects_but_does_not_retry_side_effecting_tool_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tools = [{"name": "write", "input_schema": {"type": "object"}, "side_effecting": True}]
    first = _FakeTransport(
        "docs",
        tools,
        failures=[
            MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message="mcp server 'docs' response timed out",
                retryable=True,
            )
        ],
    )
    second = _FakeTransport("docs", tools)
    client = _configured_client(monkeypatch, [first, second])

    with pytest.raises(MCPError, match="response timed out"):
        client.execute_tool("mcp__docs__write", {"path": "notes.md"})

    assert first.closed is True
    assert first.calls == [("write", {"path": "notes.md"})]
    assert second.calls == []
    assert client.tool_descriptor("mcp__docs__write") is not None


def test_client_does_not_retry_when_side_effecting_is_omitted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tools = [{"name": "write", "input_schema": {"type": "object"}}]
    first = _FakeTransport(
        "docs",
        tools,
        failures=[
            MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message="mcp server 'docs' response timed out",
                retryable=True,
            )
        ],
    )
    second = _FakeTransport("docs", tools)
    client = _configured_client(monkeypatch, [first, second])

    with pytest.raises(MCPError, match="response timed out"):
        client.execute_tool("mcp__docs__write", {"path": "notes.md"})

    assert first.closed is True
    assert first.calls == [("write", {"path": "notes.md"})]
    assert second.calls == []
    descriptor = client.tool_descriptor("mcp__docs__write")
    assert descriptor is not None
    assert descriptor.side_effecting is True


def test_client_does_not_retry_when_refreshed_descriptor_becomes_side_effecting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    read_only_tools = [
        {"name": "lookup", "input_schema": {"type": "object"}, "side_effecting": False}
    ]
    side_effecting_tools = [
        {"name": "lookup", "input_schema": {"type": "object"}, "side_effecting": True}
    ]
    first = _FakeTransport(
        "docs",
        read_only_tools,
        failures=[
            MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message="mcp server 'docs' closed its pipe unexpectedly",
                retryable=True,
            )
        ],
    )
    second = _FakeTransport("docs", side_effecting_tools)
    client = _configured_client(monkeypatch, [first, second])

    with pytest.raises(MCPError, match="closed its pipe unexpectedly"):
        client.execute_tool("mcp__docs__lookup", {"query": "release"})

    assert first.calls == [("lookup", {"query": "release"})]
    assert second.calls == []
    descriptor = client.tool_descriptor("mcp__docs__lookup")
    assert descriptor is not None
    assert descriptor.side_effecting is True


def test_client_preserves_descriptor_after_reconnect_failure_for_later_recovery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = 100.0
    cooldowns = CooldownRegistry(clock=lambda: now)
    tools = [{"name": "lookup", "input_schema": {"type": "object"}, "side_effecting": False}]
    first = _FakeTransport(
        "docs",
        tools,
        failures=[
            MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message="mcp server 'docs' closed its pipe unexpectedly",
                retryable=True,
            )
        ],
    )
    reconnect_error = MCPError(
        code=CMP_MCP_SERVER_FAILED,
        message="failed to spawn mcp server 'docs'",
        retryable=True,
    )
    second = _FakeTransport("docs", tools)
    client = _configured_client(
        monkeypatch,
        [first, reconnect_error, second],
        client=MCPClient(
            cooldown_registry=cooldowns,
            mcp_reconnect_cooldown_seconds=30.0,
        ),
    )

    with pytest.raises(MCPError, match="closed its pipe unexpectedly"):
        client.execute_tool("mcp__docs__lookup", {"query": "release"})

    assert client.tool_descriptor("mcp__docs__lookup") is not None
    assert second.calls == []
    diagnostics = client.diagnostics()
    assert diagnostics.cooldowns
    assert diagnostics.cooldowns[0].name == "docs"
    assert diagnostics.cooldowns[0].remaining_seconds == 30.0

    with pytest.raises(MCPError, match="unavailable"):
        client.execute_tool("mcp__docs__lookup", {"query": "too soon"})

    assert second.calls == []

    now = 131.0

    result = client.execute_tool("mcp__docs__lookup", {"query": "retry later"})

    assert result.output == "lookup ok"
    assert second.calls == [("lookup", {"query": "retry later"})]


def test_client_clears_mcp_cooldown_after_successful_reconnect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = 100.0
    cooldowns = CooldownRegistry(clock=lambda: now)
    tools = [{"name": "lookup", "input_schema": {"type": "object"}, "side_effecting": False}]
    first = _FakeTransport(
        "docs",
        tools,
        failures=[
            MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message="mcp server 'docs' closed its pipe unexpectedly",
                retryable=True,
            )
        ],
    )
    second = _FakeTransport("docs", tools)
    client = _configured_client(
        monkeypatch,
        [first, second],
        client=MCPClient(
            cooldown_registry=cooldowns,
            mcp_reconnect_cooldown_seconds=30.0,
        ),
    )

    result = client.execute_tool("mcp__docs__lookup", {"query": "release"})

    assert result.output == "lookup ok"
    assert client.diagnostics().cooldowns == ()


def test_concurrent_failures_share_one_replacement_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tools = [{"name": "lookup", "input_schema": {"type": "object"}, "side_effecting": False}]
    failure_barrier = threading.Barrier(2)

    class _ConcurrentFailingTransport(_FakeTransport):
        def call_tool(
            self,
            tool_name: str,
            arguments: dict[str, Any],
            *,
            timeout_seconds: float | None = None,
            cancel_handle: Any = None,
        ) -> dict[str, Any]:
            del tool_name, arguments, timeout_seconds, cancel_handle
            failure_barrier.wait(timeout=2)
            raise MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message="mcp server 'docs' closed its pipe unexpectedly",
                retryable=True,
            )

    first = _ConcurrentFailingTransport("docs", tools)
    replacement = _FakeTransport("docs", tools)
    client = _configured_client(monkeypatch, [first, replacement])

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(
                    client.execute_tool,
                    "mcp__docs__lookup",
                    {"query": f"parallel-{ordinal}"},
                )
                for ordinal in (1, 2)
            ]
            results = [future.result(timeout=3) for future in futures]

        assert [result.output for result in results] == ["lookup ok", "lookup ok"]
        assert client.diagnostics().connected == ("docs",)
        assert first.closed is True
        assert replacement.closed is False
        assert len(replacement.calls) == 2
    finally:
        client.close()


def test_client_diagnostics_bounds_mcp_failure_history(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = MCPClient()
    servers = tuple(
        MCPServerConfig(name=f"docs_{index}", transport="stdio", command="python")
        for index in range(MCP_FAILURE_HISTORY_LIMIT + 5)
    )

    def build_transport(server: MCPServerConfig, *, sse_enabled: bool) -> _FakeTransport:
        del sse_enabled
        raise MCPError(
            code=CMP_MCP_SERVER_FAILED,
            message=f"failed to spawn mcp server '{server.name}'",
            retryable=True,
        )

    monkeypatch.setattr(client, "_build_transport", build_transport)
    client.configure(servers, sse_enabled=False)

    failures = client.diagnostics().failures
    assert len(failures) == MCP_FAILURE_HISTORY_LIMIT
    assert failures[0].name == "docs_5"
    assert failures[-1].name == f"docs_{MCP_FAILURE_HISTORY_LIMIT + 4}"


def test_server_generation_id_public_accessor() -> None:
    """W8-S3: overlay wiring reads builtin liveness through a public accessor,
    not a private ``_transports`` reach-in (the W5-review finding class)."""
    client = MCPClient()
    transport = _FakeTransport("jenny_local_tools", [{"name": "lookup"}])
    transport.server_generation_id = "gen_live"  # type: ignore[attr-defined]
    client._register_transport(transport)  # noqa: SLF001

    assert client.server_generation_id("jenny_local_tools") == "gen_live"
    assert client.server_generation_id("absent_server") is None
