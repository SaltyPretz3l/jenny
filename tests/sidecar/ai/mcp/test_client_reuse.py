"""Row 53 S3: MCP server reuse across sidecar stack generations."""

from __future__ import annotations

import dataclasses
import logging
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.config import MCPServerAuth, MCPServerConfig
from sidecar.ai.mcp import transport_stdio
from sidecar.ai.mcp.client import MCP_COOLDOWN_NAMESPACE, MCPClient
from sidecar.ai.mcp.client_reuse import reuse_key
from sidecar.ai.mcp.models import MCPServerFailure
from sidecar.ai.mcp.tool_surface import summarize_tools, tools_digest
from sidecar.ai.mcp.transport_base import MCPTransport

_TOOLS = [{"name": "lookup", "description": "Look up.", "inputSchema": {"type": "object"}}]
_INPUTS: dict[str, bool] = {
    "sse_enabled": False,
    "resources_enabled": False,
    "allow_private_addresses": False,
}

_STUB_SERVER = """\
import json, sys
for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    if method == 'initialize':
        result = {'protocolVersion': '2025-03-26', 'capabilities': {}}
    elif method == 'tools/list':
        result = {'tools': [{'name': 'lookup', 'description': 'Look up.',
                             'inputSchema': {'type': 'object'}}]}
    elif method == 'tools/call':
        result = {'content': [{'type': 'text', 'text': 'pong'}]}
    else:
        continue
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
"""


class _Abort(BaseException):
    """Escapes the per-server setup isolation, like an interrupt mid-configure."""


class _CountingTransport(MCPTransport):
    def __init__(self, server_name: str) -> None:
        self._server_name = server_name
        self.close_calls = 0

    @property
    def server_name(self) -> str:
        return self._server_name

    def list_tools(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
        return list(_TOOLS)

    def call_tool(self, tool_name: str, arguments: dict[str, Any], **_kwargs: Any) -> Any:
        return {"content": [{"type": "text", "text": "ok"}]}

    def list_resources(self, **_kwargs: Any) -> dict[str, Any]:
        return {"resources": []}

    def read_resource(self, uri: str, **_kwargs: Any) -> dict[str, Any]:
        return {"contents": []}

    def list_resource_templates(self, **_kwargs: Any) -> dict[str, Any]:
        return {"resourceTemplates": []}

    def list_prompts(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
        return []

    def get_prompt(self, name: str, arguments: dict[str, str], **_kwargs: Any) -> dict[str, Any]:
        raise NotImplementedError

    def close(self) -> None:
        self.close_calls += 1

    @property
    def is_terminated(self) -> bool:
        return self.close_calls > 0


class _Builds:
    """Patches MCPClient._build_transport so every spawn is counted."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.spawned: list[_CountingTransport] = []

        def build(_client: MCPClient, server: MCPServerConfig, **_kwargs: Any) -> MCPTransport:
            transport = _CountingTransport(server.name)
            self.spawned.append(transport)
            return transport

        monkeypatch.setattr(MCPClient, "_build_transport", build)


def _config(**changes: Any) -> MCPServerConfig:
    base = MCPServerConfig(name="rea", transport="stdio", command="rea", args=("--stdio",))
    return dataclasses.replace(base, **changes)


def _configured(
    servers: tuple[MCPServerConfig, ...],
    *,
    reuse_from: MCPClient | None = None,
    **inputs: bool,
) -> MCPClient:
    client = MCPClient()
    client.configure(servers, **{**_INPUTS, **inputs}, reuse_from=reuse_from)
    return client


def test_identical_row_and_inputs_reuse_the_live_transport(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    builds = _Builds(monkeypatch)
    previous = _configured((_config(),))
    caplog.set_level(logging.INFO, logger="sidecar.ai.mcp")

    current = _configured((_config(),), reuse_from=previous)

    assert len(builds.spawned) == 1
    transport = builds.spawned[0]
    assert current._transports["rea"] is transport
    assert [tool.name for tool in current.available_tools] == ["mcp__rea__lookup"]
    assert current.diagnostics().connected == ("rea",)
    reused = [r for r in caplog.records if getattr(r, "event", "") == "ai.mcp.transport_reused"]
    assert [r.data for r in reused] == [{"server": "rea"}]  # type: ignore[attr-defined]
    assert current.execute_tool("mcp__rea__lookup", {}).output == "ok"

    previous.close()  # the retired generation never closes what it handed off
    assert transport.close_calls == 0
    current.close()
    assert transport.close_calls == 1


@pytest.mark.parametrize(
    ("previous_row", "current_row", "inputs"),
    [
        (_config(), _config(args=("--stdio", "--verbose")), {}),
        (_config(), _config(command="rea2"), {}),
        (_config(), _config(request_timeout_seconds=45.0), {}),
        (_config(env=(("REA_LOG_LEVEL", "info"),)), _config(env=(("REA_LOG_LEVEL", "debug"),)), {}),
        (_config(approved_tools_digest="sha256:a"), _config(approved_tools_digest="sha256:b"), {}),
        (
            _config(auth=MCPServerAuth(token="old-secret")),
            _config(auth=MCPServerAuth(token="rotated-secret")),
            {},
        ),
        (_config(), _config(), {"allow_private_addresses": True}),
        (_config(), _config(), {"resources_enabled": True}),
        (_config(), _config(), {"sse_enabled": True}),
    ],
)
def test_a_changed_row_or_transport_input_respawns(
    monkeypatch: pytest.MonkeyPatch,
    previous_row: MCPServerConfig,
    current_row: MCPServerConfig,
    inputs: dict[str, bool],
) -> None:
    builds = _Builds(monkeypatch)
    monkeypatch.setattr(MCPClient, "_register_transport", _register_without_list_tools)
    previous = _configured((previous_row,))

    current = _configured((current_row,), reuse_from=previous, **inputs)

    assert len(builds.spawned) == 2
    first, second = builds.spawned
    assert current._transports["rea"] is second
    previous.close()
    assert first.close_calls == 1
    current.close()
    assert second.close_calls == 1


def _register_without_list_tools(client: MCPClient, transport: MCPTransport) -> None:
    client._transports[transport.server_name] = transport
    client._connected.append(transport.server_name)


def test_only_the_changed_row_respawns(monkeypatch: pytest.MonkeyPatch) -> None:
    builds = _Builds(monkeypatch)
    docs = MCPServerConfig(name="docs", transport="stdio", command="docs")
    previous = _configured((_config(), docs))

    current = _configured((_config(), dataclasses.replace(docs, args=("-v",))), reuse_from=previous)

    assert [t.server_name for t in builds.spawned] == ["rea", "docs", "docs"]
    assert current._transports["rea"] is builds.spawned[0]
    assert current._transports["docs"] is builds.spawned[2]


def test_a_different_client_request_timeout_respawns(monkeypatch: pytest.MonkeyPatch) -> None:
    builds = _Builds(monkeypatch)
    previous = _configured((_config(),))
    current = MCPClient(request_timeout_seconds=12.0)

    current.configure((_config(),), **_INPUTS, reuse_from=previous)

    assert len(builds.spawned) == 2


def test_a_terminated_transport_is_not_adopted(monkeypatch: pytest.MonkeyPatch) -> None:
    builds = _Builds(monkeypatch)
    previous = _configured((_config(),))
    builds.spawned[0].close_calls = 1  # the process died after the last call

    _configured((_config(),), reuse_from=previous)

    assert len(builds.spawned) == 2


def test_cooldown_and_failure_records_carry_over_with_an_adopted_server(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _Builds(monkeypatch)
    previous = _configured((_config(),))
    previous._cooldowns.mark(
        MCP_COOLDOWN_NAMESPACE, "rea", duration_seconds=60.0, reason="reconnect_failed"
    )
    failure = MCPServerFailure(name="rea", code="CMP-MCP-0004", message="earlier failure")
    previous._failures.append(failure)

    current = _configured((_config(),), reuse_from=previous)

    cooldowns = current.diagnostics().cooldowns
    assert [(c.name, c.reason) for c in cooldowns] == [("rea", "reconnect_failed")]
    assert failure in current.diagnostics().failures


def test_a_transport_is_handed_off_to_only_one_candidate(monkeypatch: pytest.MonkeyPatch) -> None:
    builds = _Builds(monkeypatch)
    previous = _configured((_config(),))

    first = _configured((_config(),), reuse_from=previous)
    second = _configured((_config(),), reuse_from=previous)

    assert first._transports["rea"] is builds.spawned[0]
    assert second._transports["rea"] is builds.spawned[1]


def test_a_failed_candidate_configure_hands_adoptions_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    builds = _Builds(monkeypatch)
    docs = MCPServerConfig(name="docs", transport="stdio", command="docs")
    previous = _configured((_config(),))
    adopted = builds.spawned[0]
    original_register = MCPClient._register_transport

    def register(client: MCPClient, transport: MCPTransport) -> None:
        if transport.server_name == "docs":
            raise _Abort()
        original_register(client, transport)

    monkeypatch.setattr(MCPClient, "_register_transport", register)
    candidate = MCPClient()
    with pytest.raises(_Abort):
        candidate.configure((_config(), docs), **_INPUTS, reuse_from=previous)
    candidate.close()  # the staged unwind closes the candidate

    assert adopted.close_calls == 0
    assert builds.spawned[1].server_name == "docs" and builds.spawned[1].close_calls == 1
    assert previous._transports["rea"] is adopted
    assert previous.execute_tool("mcp__rea__lookup", {}).output == "ok"
    previous.close()
    assert adopted.close_calls == 1


def test_a_retiring_generation_hands_a_transport_back_to_a_still_open_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    builds = _Builds(monkeypatch)
    first = _configured((_config(),))  # generation A, still serving a leased turn
    second = _configured((_config(),), reuse_from=first)  # B adopted A's process
    third = _configured((_config(args=("--changed",)),), reuse_from=second)  # C respawns
    adopted = builds.spawned[0]

    second.close()  # B retires before A's lease drained

    assert adopted.close_calls == 0
    assert first._transports["rea"] is adopted
    assert first.execute_tool("mcp__rea__lookup", {}).output == "ok"
    first.close()
    assert adopted.close_calls == 1
    third.close()
    assert builds.spawned[1].close_calls == 1


def test_returning_adoptions_to_a_closed_previous_client_closes_them(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from sidecar.ai.mcp.client_reuse import return_adopted

    builds = _Builds(monkeypatch)
    previous = _configured((_config(),))
    candidate = _configured((_config(),), reuse_from=previous)
    adopted = builds.spawned[0]
    previous.close()
    assert adopted.close_calls == 0

    return_adopted(candidate)
    return_adopted(candidate)
    candidate.close()

    assert adopted.close_calls == 1


def test_reuse_key_covers_every_config_field_and_the_transport_inputs() -> None:
    base = _config()
    key = reuse_key(base, **_INPUTS)
    assert key == reuse_key(_config(), **_INPUTS)
    names = {field.name for field in dataclasses.fields(MCPServerConfig)}
    assert {"env", "inspect_timeout_seconds", "read_only_auto_allow"} <= names
    for field in dataclasses.fields(MCPServerConfig):
        variant = _changed(field.name, getattr(base, field.name))
        changed = dataclasses.replace(base, **{field.name: variant})
        assert reuse_key(changed, **_INPUTS) != key, field.name
    for name in _INPUTS:
        assert reuse_key(base, **{**_INPUTS, name: True}) != key, name


def _changed(name: str, value: Any) -> Any:
    if name == "auth":
        return MCPServerAuth(token="t")
    variants: dict[type, Any] = {
        type(None): lambda _v: "changed",
        bool: lambda v: not v,
        int: lambda v: v + 1,
        float: lambda v: v + 1.0,
        str: lambda v: v + "-changed",
        tuple: lambda v: (*v, "changed"),
        dict: lambda v: {**v, "CHANGED": "1"},
    }
    return variants[type(value)](value)


def test_reuse_key_digests_the_auth_secret_without_carrying_it() -> None:
    first = _config(auth=MCPServerAuth(token="secret-one"))
    rotated = _config(auth=MCPServerAuth(token="secret-two"))
    client_secret = _config(
        auth=MCPServerAuth(kind="oauth_client_credentials", client_secret="secret-one")
    )

    key = reuse_key(first, **_INPUTS)

    assert key == reuse_key(_config(auth=MCPServerAuth(token="secret-one")), **_INPUTS)
    assert key != reuse_key(rotated, **_INPUTS)
    assert key != reuse_key(client_secret, **_INPUTS)
    assert key != reuse_key(_config(), **_INPUTS)
    assert "secret" not in key
    assert len(key) == 64


def _stub_server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[MCPServerConfig, list]:
    script = tmp_path / "reuse_stub.py"
    script.write_text(_STUB_SERVER, encoding="utf-8")
    monkeypatch.setattr(transport_stdio, "_validate_stdio_command", lambda _config: None)
    real_popen = transport_stdio.subprocess.Popen
    spawned: list[subprocess.Popen[str]] = []

    def counting_popen(*args: Any, **kwargs: Any) -> subprocess.Popen[str]:
        process = real_popen(*args, **kwargs)
        spawned.append(process)
        return process

    monkeypatch.setattr(transport_stdio.subprocess, "Popen", counting_popen)
    digest = tools_digest(summarize_tools(_TOOLS))
    config = MCPServerConfig(
        name="rea",
        transport="stdio",
        command=sys.executable,
        args=("-u", str(script)),
        approved_tools_digest=digest,
    )
    return config, spawned


def test_a_live_stdio_server_survives_a_generation_change_without_respawn(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config, spawned = _stub_server(tmp_path, monkeypatch)
    previous = MCPClient(request_timeout_seconds=10.0)
    current = MCPClient(request_timeout_seconds=10.0)
    try:
        previous.configure((config,), **_INPUTS)
        current.configure((config,), **_INPUTS, reuse_from=previous)

        assert len(spawned) == 1
        assert current._transports["rea"] is previous._transports["rea"]
        previous.close()  # retired generation
        assert spawned[0].poll() is None
        assert current.execute_tool("mcp__rea__lookup", {}).output == "pong"
    finally:
        previous.close()
        current.close()
    spawned[0].wait(timeout=5.0)
    assert spawned[0].poll() is not None


def test_a_failed_candidate_leaves_the_previous_owner_and_no_orphan_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config, spawned = _stub_server(tmp_path, monkeypatch)
    docs = dataclasses.replace(config, name="docs", approved_tools_digest=None)
    previous = MCPClient(request_timeout_seconds=10.0)
    candidate = MCPClient(request_timeout_seconds=10.0)
    original_register = MCPClient._register_transport

    def register(client: MCPClient, transport: MCPTransport) -> None:
        if client is candidate and transport.server_name == "docs":
            raise _Abort()
        original_register(client, transport)

    monkeypatch.setattr(MCPClient, "_register_transport", register)
    try:
        previous.configure((config,), **_INPUTS)
        with pytest.raises(_Abort):
            candidate.configure((config, docs), **_INPUTS, reuse_from=previous)
        candidate.close()

        assert len(spawned) == 2  # rea once (adopted, handed back) plus docs
        assert spawned[0].poll() is None
        assert previous.execute_tool("mcp__rea__lookup", {}).output == "pong"
    finally:
        candidate.close()
        previous.close()
    for process in spawned:
        process.wait(timeout=5.0)
        assert process.poll() is not None
