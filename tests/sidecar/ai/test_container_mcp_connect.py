"""The builtin MCP connect overlaps candidate-stack construction (row 62 Wave C).

``BrainContainer`` starts ``MCPClient.configure`` on a worker before the engine
probe, re-plans it once the effective config is known, and joins it before the
router is built. Failures surface exactly as before and never leak the worker
or the client.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable
from unittest.mock import MagicMock

import pytest

import sidecar.ai.container as container_mod
from sidecar.ai.container import BrainContainer
from sidecar.ai.mcp import client_reuse

_CONFIG = {"engine_type": "ollama", "model": "plain-model"}


class _FakeClient:
    instances: list[_FakeClient] = []
    on_configure: Callable[[_FakeClient], None] = staticmethod(lambda _client: None)

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.configure_calls: list[tuple[Any, dict[str, Any]]] = []
        self.events: list[str] = []
        self.close_calls = 0
        # What client_reuse.return_adopted reads on an unwinding candidate.
        self._transport_registry_lock = threading.RLock()
        self._reuse = client_reuse.ReuseState()
        self._transports: dict[str, Any] = {}
        _FakeClient.instances.append(self)

    def configure(self, servers: Any, **kwargs: Any) -> None:
        self.configure_calls.append((servers, kwargs))
        self.events.append("configure_start")
        try:
            type(self).on_configure(self)
        finally:
            self.events.append("configure_end")

    def close(self) -> None:
        self.events.append("close")
        self.close_calls += 1


def _selection(engine_type: str = "ollama") -> Any:
    from sidecar.ai.engines.factory import EngineSelection

    return EngineSelection(engine=MagicMock(), engine_type=engine_type, model="plain-model")


@pytest.fixture()
def fakes(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> type[_FakeClient]:
    _FakeClient.instances = []
    _FakeClient.on_configure = staticmethod(lambda _client: None)
    monkeypatch.setattr(container_mod, "MemoryStore", lambda path: MagicMock())
    monkeypatch.setattr(container_mod, "ContextBuilder", lambda *a, **kw: MagicMock())
    monkeypatch.setattr(container_mod, "ChatRouter", lambda **kw: MagicMock())
    monkeypatch.setattr(container_mod, "HarnessSnapshotBuilder", lambda **kw: MagicMock())
    monkeypatch.setattr(container_mod, "resolve_memory_db_path", lambda cfg: str(tmp_path / "m.db"))
    monkeypatch.setattr(
        container_mod, "resolve_background_runtime_root", lambda cfg: tmp_path / "runtime"
    )
    monkeypatch.setattr(container_mod, "MCPClient", _FakeClient)
    return _FakeClient


def _connect_threads() -> list[threading.Thread]:
    return [t for t in threading.enumerate() if t.name == "jenny-mcp-connect" and t.is_alive()]


def test_mcp_connect_runs_while_the_engine_probe_runs(
    fakes: type[_FakeClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    started = threading.Event()
    fakes.on_configure = staticmethod(lambda _client: started.set())
    seen_during_probe: list[bool] = []

    def create_engine(_config: Any, **_kwargs: Any) -> Any:
        seen_during_probe.append(started.wait(2.0))
        return _selection()

    monkeypatch.setattr(container_mod, "create_engine", create_engine)
    stack = BrainContainer().configure(dict(_CONFIG))

    assert seen_during_probe == [True]
    assert len(fakes.instances) == 1
    client = fakes.instances[0]
    assert stack.mcp_client is client
    assert client.events == ["configure_start", "configure_end"]
    servers, kwargs = client.configure_calls[0]
    assert stack.config.mcp_servers == servers
    assert kwargs["reuse_from"] is None
    assert _connect_threads() == []


def test_an_engine_fallback_replans_and_reconnects_from_the_effective_config(
    fakes: type[_FakeClient], monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    # The builtin server's argv carries the engine type, so a fallback changes the plan.
    monkeypatch.setattr(container_mod, "create_engine", lambda _c, **_k: _selection("mock"))
    with caplog.at_level(logging.INFO, logger="sidecar.ai.container"):
        stack = BrainContainer().configure(dict(_CONFIG))

    early, final = fakes.instances
    assert early.events == ["configure_start", "configure_end", "close"]
    assert stack.mcp_client is final
    assert final.close_calls == 0
    final_argv = final.configure_calls[0][0][0].args
    assert final_argv[final_argv.index("--connections-engine-type") + 1] == "mock"
    assert stack.config.mcp_servers == final.configure_calls[0][0]
    assert any("MCP connect plan" in record.getMessage() for record in caplog.records)
    assert _connect_threads() == []


def test_a_configure_error_surfaces_unchanged_and_closes_the_client(
    fakes: type[_FakeClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    boom = RuntimeError("mcp configure exploded")

    def fail(_client: _FakeClient) -> None:
        raise boom

    fakes.on_configure = staticmethod(fail)
    monkeypatch.setattr(container_mod, "create_engine", lambda _c, **_k: _selection())
    container = BrainContainer()

    with pytest.raises(RuntimeError) as caught:
        container.configure(dict(_CONFIG))

    assert caught.value is boom
    (client,) = fakes.instances
    assert client.close_calls >= 1
    assert container._stack is None
    assert _connect_threads() == []


def test_an_engine_failure_joins_the_connect_before_closing_its_client(
    fakes: type[_FakeClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    fakes.on_configure = staticmethod(lambda _client: time.sleep(0.2))

    def create_engine(_config: Any, **_kwargs: Any) -> Any:
        raise ConnectionError("engine probe failed")

    monkeypatch.setattr(container_mod, "create_engine", create_engine)

    with pytest.raises(ConnectionError, match="engine probe failed"):
        BrainContainer().configure(dict(_CONFIG))

    (client,) = fakes.instances
    assert client.events[:3] == ["configure_start", "configure_end", "close"]
    assert _connect_threads() == []


def test_reinitialize_still_reuses_the_live_builtin_transport(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any, caplog: pytest.LogCaptureFixture
) -> None:
    from sidecar.ai.mcp.client import MCPClient
    from sidecar.ai.mcp.transport_base import MCPTransport

    class _Transport(MCPTransport):
        server_name = ""  # set per instance below
        close_calls = 0

        def __init__(self, name: str) -> None:
            self.server_name = name

        def list_tools(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
            return [
                {"name": "lookup", "description": "Look up.", "inputSchema": {"type": "object"}}
            ]

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

        def get_prompt(
            self, name: str, arguments: dict[str, str], **_kwargs: Any
        ) -> dict[str, Any]:
            raise NotImplementedError

        def close(self) -> None:
            self.close_calls += 1

    spawned: list[_Transport] = []

    def build(_client: MCPClient, server: Any, **_kwargs: Any) -> _Transport:
        spawned.append(_Transport(server.name))
        return spawned[-1]

    monkeypatch.setattr(MCPClient, "_build_transport", build)
    monkeypatch.setattr(container_mod, "MemoryStore", lambda path: MagicMock())
    monkeypatch.setattr(container_mod, "ContextBuilder", lambda *a, **kw: MagicMock())
    monkeypatch.setattr(container_mod, "ChatRouter", lambda **kw: MagicMock())
    monkeypatch.setattr(container_mod, "HarnessSnapshotBuilder", lambda **kw: MagicMock())
    monkeypatch.setattr(container_mod, "resolve_memory_db_path", lambda cfg: str(tmp_path / "m.db"))
    monkeypatch.setattr(
        container_mod, "resolve_background_runtime_root", lambda cfg: tmp_path / "runtime"
    )
    monkeypatch.setattr(container_mod, "create_engine", lambda _c, **_k: _selection())
    container = BrainContainer()

    first = container.configure(dict(_CONFIG))
    with caplog.at_level(logging.INFO, logger="sidecar.ai.mcp.client"):
        second = container.configure(dict(_CONFIG))

    assert len(spawned) == 1
    assert second.mcp_client is not first.mcp_client
    assert any("reused across generations" in r.getMessage() for r in caplog.records)
    # The retired first generation handed the transport off instead of closing it.
    assert spawned[0].close_calls == 0
    assert [tool.name for tool in second.mcp_client.available_tools] == ["lookup"]
    container.close()
    assert spawned[0].close_calls == 1
    assert _connect_threads() == []


def test_a_replanned_reinitialize_hands_adopted_transports_back_before_closing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    # The early connect adopts the published generation's live builtin process;
    # when the effective config then changes the plan, discarding that early
    # client must return the process, not close it under the serving stack.
    from sidecar.ai.mcp.client import MCPClient
    from sidecar.ai.mcp.transport_base import MCPTransport

    container = BrainContainer()
    events: list[str] = []

    class _Transport(MCPTransport):
        server_name = ""  # set per instance below

        def __init__(self, name: str) -> None:
            self.server_name = name

        def list_tools(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
            return [
                {"name": "lookup", "description": "Look up.", "inputSchema": {"type": "object"}}
            ]

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

        def get_prompt(
            self, name: str, arguments: dict[str, str], **_kwargs: Any
        ) -> dict[str, Any]:
            raise NotImplementedError

        def close(self) -> None:
            events.append(f"close:{spawned.index(self)}")

    spawned: list[_Transport] = []

    def build(_client: MCPClient, server: Any, **_kwargs: Any) -> _Transport:
        spawned.append(_Transport(server.name))
        events.append(f"build:{len(spawned) - 1}")
        return spawned[-1]

    selections = iter([_selection(), _selection("mock")])
    monkeypatch.setattr(MCPClient, "_build_transport", build)
    monkeypatch.setattr(container_mod, "MemoryStore", lambda path: MagicMock())
    monkeypatch.setattr(container_mod, "ContextBuilder", lambda *a, **kw: MagicMock())
    monkeypatch.setattr(container_mod, "ChatRouter", lambda **kw: MagicMock())
    monkeypatch.setattr(container_mod, "HarnessSnapshotBuilder", lambda **kw: MagicMock())
    monkeypatch.setattr(container_mod, "resolve_memory_db_path", lambda cfg: str(tmp_path / "m.db"))
    monkeypatch.setattr(
        container_mod, "resolve_background_runtime_root", lambda cfg: tmp_path / "runtime"
    )
    monkeypatch.setattr(container_mod, "create_engine", lambda _c, **_k: next(selections))

    container.configure(dict(_CONFIG))
    # Second generation: the engine falls back, so the early connect is discarded.
    container.configure(dict(_CONFIG))

    # The early connect adopted the live process (no spawn); the replanned one spawned anew.
    assert len(spawned) == 2
    # Retiring the first generation closes its process, only after the
    # replanned connect is built: discarding the early connect returned it.
    assert events == ["build:0", "build:1", "close:0"]
    container.close()
    assert _connect_threads() == []
