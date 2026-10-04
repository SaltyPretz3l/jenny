"""Idle cleanup and request ownership regressions for MEM-010."""

from __future__ import annotations

from contextlib import ExitStack
from pathlib import Path
from threading import Event
from typing import Callable

import pytest

from sidecar.ai.tools.builtins.lsp import tools
from sidecar.ai.tools.builtins.lsp.manager import LSPManager, LSPServerCommand
from sidecar.ai.tools.builtins.lsp.protocol import LSPProtocolError
from sidecar.ai.tools.workspace import WorkspaceGuard


class FakeClock:
    now = 0.0

    def __call__(self) -> float:
        return self.now


class FakeSession:
    def __init__(self, _command: tuple[str, ...], _workspace: Path) -> None:
        self.started = False
        self.closed = Event()
        self.on_call: Callable[[str], None] = lambda _method: None
        self.on_close: Callable[[], None] = lambda: None

    @property
    def is_running(self) -> bool:
        return self.started and not self.closed.is_set()

    def start(self) -> None:
        self.started = True

    def close(self) -> None:
        self.on_close()
        self.closed.set()

    def request(self, method: str, params: dict[str, object] | None = None) -> object:
        self.on_call(method)
        return {"items": []} if method == "textDocument/diagnostic" else []

    def notify(self, method: str, params: dict[str, object]) -> None:
        self.on_call(method)


@pytest.fixture
def make_manager(monkeypatch: pytest.MonkeyPatch):
    managers: list[LSPManager] = []
    monkeypatch.setattr(tools._STATE, "manager", tools._STATE.manager)
    monkeypatch.setattr(tools._STATE, "config", tools._STATE.config)
    monkeypatch.setattr(tools._STATE, "detected_servers", tools._STATE.detected_servers)

    def create(clock: FakeClock, **kwargs) -> LSPManager:
        manager = LSPManager(
            idle_timeout_seconds=5.0, session_factory=FakeSession, clock=clock, **kwargs
        )
        managers.append(manager)
        return manager

    yield create
    for manager in managers:
        manager.shutdown()


def acquire(manager: LSPManager, root: Path) -> FakeSession:
    return manager.ensure_session(language="python", workspace_root=root, command=("fake",))


def test_idle_expiry_without_another_lsp_call(make_manager, tmp_path: Path) -> None:
    clock = FakeClock()
    manager = make_manager(clock, sweep_interval_seconds=0.01)
    assert getattr(manager, "_sweep_thread", None) is None
    session = acquire(manager, tmp_path)
    target = tmp_path / "module.py"
    target.write_text("x = 1", encoding="ascii")
    manager.ensure_initialized(session=session, language="python", workspace_root=tmp_path)
    synced = manager.sync_document(session=session, language="python", file_path=target)
    manager._record_notification(session, {
        "method": "textDocument/publishDiagnostics",
        "params": {"uri": synced.uri, "version": synced.version, "diagnostics": []},
    })
    worker = getattr(manager, "_sweep_thread", None)
    clock.now = 5.0
    assert session.closed.wait(0.5), "idle session stayed live without another LSP call"
    assert worker is not None and worker.daemon
    worker.join(0.5)
    assert not worker.is_alive(), "cleanup worker stayed alive with no sessions"
    assert not manager._sessions
    assert not manager._document_versions
    assert not manager._published_diagnostics
    assert not manager._initialized_sessions


@pytest.mark.parametrize("action", ["diagnostics", "symbols", "definition", "references"])
@pytest.mark.parametrize("phase", ["initialize", "textDocument/didOpen", "feature"])
def test_tool_activity_survives_sweep_and_refreshes_idle_time(
    make_manager, tmp_path: Path, action: str, phase: str
) -> None:
    clock = FakeClock()
    manager = make_manager(clock)
    (tmp_path / "module.py").write_text("x = 1", encoding="ascii")
    session = acquire(manager, tmp_path)
    features = {
        "diagnostics": "textDocument/diagnostic",
        "symbols": "textDocument/documentSymbol",
        "definition": "textDocument/definition",
        "references": "textDocument/references",
    }
    tested_method = features[action] if phase == "feature" else phase
    calls: list[str] = []

    def sweep_during_call(method: str) -> None:
        if method == tested_method:
            calls.append(method)
            clock.now = 1000.0
            assert manager.evict_idle_sessions() == 0, "sweep evicted in-flight LSP work"
            assert not session.closed.is_set()

    session.on_call = sweep_during_call
    tools.configure_lsp_tools(
        {"tools_lsp_enabled": True}, manager=manager,
        detected_servers={"python": LSPServerCommand("python", "fake", "configured")},
    )
    result = tools.lsp_tool(
        {"action": action, "path": "module.py", "line": 0, "character": 0},
        WorkspaceGuard(str(tmp_path)),
    )
    assert result.success
    assert calls == [tested_method]
    clock.now = 1004.0
    assert manager.evict_idle_sessions() == 0
    clock.now = 1005.0
    assert manager.evict_idle_sessions() == 1
    assert session.closed.is_set()


def test_fifth_session_evicts_lru_idle_session(make_manager, tmp_path: Path) -> None:
    clock = FakeClock()
    manager = make_manager(clock)
    sessions = []
    for index in range(4):
        clock.now = float(index)
        sessions.append(acquire(manager, tmp_path / str(index)))
    clock.now = 4.0
    assert acquire(manager, tmp_path / "0") is sessions[0]
    fifth = acquire(manager, tmp_path / "4")
    assert sessions[1].closed.is_set(), "fifth session did not evict the LRU idle session"
    assert sum(session.closed.is_set() for session in sessions) == 1
    assert not sessions[0].closed.is_set()
    assert fifth.is_running
    assert len(manager._sessions) == 4


def test_shutdown_stops_worker_and_reuse_rearms(make_manager, tmp_path: Path) -> None:
    clock = FakeClock()
    manager = make_manager(clock)
    first = acquire(manager, tmp_path)
    worker = getattr(manager, "_sweep_thread", None)
    assert worker is not None and worker.is_alive(), "first session did not arm cleanup"
    manager.shutdown()
    assert not worker.is_alive(), "shutdown left the cleanup worker alive"
    assert first.closed.is_set()
    second = acquire(manager, tmp_path)
    next_worker = manager._sweep_thread
    assert second is not first and next_worker is not worker
    assert next_worker is not None and next_worker.is_alive()
    manager.shutdown()
    assert not next_worker.is_alive()
    assert second.closed.is_set()


def test_all_busy_capacity_overrun_is_trimmed_later(make_manager, tmp_path: Path) -> None:
    clock = FakeClock()
    manager = make_manager(clock)
    with ExitStack() as leases:
        sessions = []
        for index in range(5):
            clock.now = float(index)
            sessions.append(leases.enter_context(manager.session_for_request(
                language="python", workspace_root=tmp_path / str(index), command=("fake",)
            )))
        assert len(manager._sessions) == 5
        assert manager.evict_idle_sessions() == 0
        assert all(session.is_running for session in sessions)
    assert manager.evict_idle_sessions() == 1
    assert len(manager._sessions) == 4


def test_failed_request_releases_activity(make_manager, tmp_path: Path) -> None:
    clock = FakeClock()
    manager = make_manager(clock)
    with pytest.raises(LSPProtocolError), manager.session_for_request(
        language="python", workspace_root=tmp_path, command=("fake",)
    ) as session:
        with manager.session_for_request(
            language="python", workspace_root=tmp_path, command=("fake",)
        ) as nested:
            assert nested is session
            clock.now = 100.0
            assert manager.evict_idle_sessions() == 0
        clock.now = 104.0
        assert manager.evict_idle_sessions() == 0
        raise LSPProtocolError("request failed")
    clock.now = 108.0
    assert manager.evict_idle_sessions() == 0
    clock.now = 109.0
    assert manager.evict_idle_sessions() == 1
    assert session.closed.is_set()


def test_eviction_closes_outside_manager_lock(make_manager, tmp_path: Path) -> None:
    clock = FakeClock()
    manager = make_manager(clock)
    session = acquire(manager, tmp_path)

    def check_lock() -> None:
        assert manager._lock.acquire(blocking=False), "session close held manager lock"
        manager._lock.release()

    session.on_close = check_lock
    clock.now = 5.0
    assert manager.evict_idle_sessions() == 1


def test_sweep_interval_is_injectable(make_manager, tmp_path: Path) -> None:
    manager = make_manager(FakeClock(), sweep_interval_seconds=0.01)
    acquire(manager, tmp_path)
    worker = manager._sweep_thread
    manager.shutdown()
    assert worker is not None and not worker.is_alive()

