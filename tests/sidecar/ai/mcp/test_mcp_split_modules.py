"""Modules carved out of ``builtin_server``, ``transport_stdio`` and ``client`` (row 105)."""

from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.mcp import (
    builtin_server,
    builtin_server_cli,
    builtin_server_outcome,
    builtin_server_protocol,
    builtin_server_startup,
    client,
    client_reconnect,
    client_resources,
    transport_stdio,
    transport_stdio_channel,
)
from sidecar.ai.tools.contracts import ToolHandlerResult


def test_builtin_server_hub_aliases_are_the_carved_out_objects() -> None:
    # Tests and the server's own call sites resolve these through builtin_server.
    for name in (
        "SERVER_GENERATION_ID",
        "OUTPUT_CHUNK_NOTIFICATION_METHOD",
        "TOOL_STARTED_NOTIFICATION_METHOD",
        "_error_response",
        "_redact_error_message",
        "_result_response",
        "_safe_json_dumps",
        "_write_response",
    ):
        assert getattr(builtin_server, name) is getattr(builtin_server_protocol, name)
    for name in (
        "_add_success_trace_metadata",
        "_traced_failure_data",
        "_unpack_tool_output",
        "_workspace_changed_evidence",
    ):
        assert getattr(builtin_server, name) is getattr(builtin_server_outcome, name)
    for name in ("_build_workspace_guard", "_configure_logging"):
        assert getattr(builtin_server, name) is getattr(builtin_server_startup, name)


def test_default_tool_config_is_a_fresh_dict_per_call() -> None:
    first = builtin_server_cli.default_builtin_tool_config()
    second = builtin_server_cli.default_builtin_tool_config()

    assert first == second
    assert first["feature_flags"] == builtin_server_cli.DEFAULT_BUILTIN_FEATURE_FLAGS
    assert first["feature_flags"] is not second["feature_flags"]


def test_tool_config_from_argv_normalizes_launcher_values() -> None:
    args = builtin_server_cli.build_argument_parser().parse_args(
        ["--knowledge-root", " a ", "--knowledge-root", " ", "--shell-enabled", "yes"]
    )

    config = builtin_server_cli.builtin_tool_config(
        args,
        host_mode="desktop",
        host_execution_policy_version=None,
        desktop_execution_policy_version=None,
    )

    assert set(config) <= set(builtin_server_cli.default_builtin_tool_config())
    assert config["knowledge_roots"] == ("a",)
    assert config["tools_shell_enabled"] is True
    assert config["tools_web_rate_limit_per_min"] == 30
    assert config["feature_flags"] == builtin_server_cli.builtin_feature_flags(args)


def test_outcome_unpacks_plain_and_handler_results() -> None:
    assert builtin_server_outcome._unpack_tool_output({"a": 1}) == (
        '{"a": 1}', True, (), None, {}, ()
    )
    result = ToolHandlerResult(
        output="x", success=False, error_code="CMP-TEST-0001", metadata={"workspace_changed": True}
    )

    text, success, _artifacts, code, metadata, _attachments = (
        builtin_server_outcome._unpack_tool_output(result)
    )

    assert (text, success, code, metadata) == (
        "x", False, "CMP-TEST-0001", {"workspace_changed": True}
    )
    assert builtin_server_outcome._workspace_changed_evidence(result) is True
    assert builtin_server_outcome._workspace_changed_evidence("text") is None


def test_protocol_error_envelope_keeps_the_jsonrpc_shape() -> None:
    response = builtin_server_protocol._error_response(
        7, "CMP-TEST-0001", "boom", retryable=True, metadata={"k": 1}
    )

    assert response == {
        "jsonrpc": "2.0",
        "id": 7,
        "error": {
            "code": -32000,
            "message": "boom",
            "data": {"code": "CMP-TEST-0001", "retryable": True, "k": 1},
        },
    }


def test_transport_hub_aliases_and_channel_mixin_order() -> None:
    for name in (
        "CANCEL_NOTIFICATION_METHOD",
        "MCP_CANCEL_GRACE_SECONDS",
        "MCP_READER_QUEUE_MAX_BYTES",
        "OUTPUT_CHUNK_NOTIFICATION_METHOD",
        "ReaderBudget",
        "_CancelObserved",
        "_PendingRequest",
        "_ResponseTimeout",
        "_read_bounded_text_line",
    ):
        assert getattr(transport_stdio, name) is getattr(transport_stdio_channel, name)
    assert transport_stdio.StdioMCPTransport.__mro__[1] is transport_stdio_channel.StdioChannelMixin
    # Spawn/close/termination, the response parser and error mapping stay on the transport.
    for name in ("close", "_read_response_line", "_raise_for_error", "_terminate_after_reader_failure"):
        assert name in transport_stdio.StdioMCPTransport.__dict__
    for name in ("_send_request", "_write_line", "_pump_stdout", "_handle_out_of_band_response"):
        assert name in transport_stdio_channel.StdioChannelMixin.__dict__


def test_channel_cancel_probe_never_raises() -> None:
    assert transport_stdio_channel._cancel_observed(None) is False
    assert transport_stdio_channel._cancel_observed(SimpleNamespace(cancelled=False)) is False
    assert transport_stdio_channel._cancel_observed(SimpleNamespace(cancelled=True)) is True


def test_client_mixins_and_shared_constants() -> None:
    assert client.MCP_COOLDOWN_NAMESPACE is client_reconnect.MCP_COOLDOWN_NAMESPACE
    assert client.MCP_FAILURE_HISTORY_LIMIT == client_reconnect.MCP_FAILURE_HISTORY_LIMIT
    bases = client.MCPClient.__mro__
    assert client_resources.ClientResourcesMixin in bases
    assert client_reconnect.ClientReconnectMixin in bases

    description, schema = client.MCPClient()._resource_tool_contract("read_resource")

    assert "resource_id or uri" in description
    assert set(schema["properties"]) == {"resource_id", "uri"}
