"""LSP Phase 2 manager lifecycle tests."""

from __future__ import annotations

from pathlib import Path

from sidecar.ai.tools.builtins.lsp import LSPProtocolError
from sidecar.ai.tools.builtins.lsp.manager import LSPManager


class FakeSession:
    def __init__(self, command: tuple[str, ...], workspace_root: Path) -> None:
        self.command = command
        self.workspace_root = workspace_root
        self.started = False
        self.closed = False
        self.notifications: list[tuple[str, dict]] = []
        self.requests: list[tuple[str, dict | None]] = []

    @property
    def is_running(self) -> bool:
        return self.started and not self.closed

    def start(self) -> None:
        self.started = True

    def close(self) -> None:
        self.closed = True

    def notify(self, method: str, params: dict) -> None:
        self.notifications.append((method, params))

    def request(self, method: str, params: dict | None = None) -> object:
        self.requests.append((method, params))
        return {}


class FailingNotifySession(FakeSession):
    def notify(self, method: str, params: dict) -> None:
        raise LSPProtocolError("notify failed for C:\\Users\\example\\secret.py")


class PullUnsupportedDiagnosticsSession(FakeSession):
    def __init__(self, command: tuple[str, ...], workspace_root: Path) -> None:
        super().__init__(command, workspace_root)
        self.notifications_to_drain: list[dict] = []

    def request(self, method: str, params: dict | None = None) -> object:
        raise LSPProtocolError("method not found")

    def drain_notifications(self) -> list[dict]:
        notifications = list(self.notifications_to_drain)
        self.notifications_to_drain.clear()
        return notifications


def test_manager_reuses_session_for_same_workspace_and_language(tmp_path: Path) -> None:
    created: list[FakeSession] = []

    def factory(command: tuple[str, ...], workspace_root: Path) -> FakeSession:
        session = FakeSession(command, workspace_root)
        created.append(session)
        return session

    manager = LSPManager(session_factory=factory)
    command = ("fake-server",)

    first = manager.ensure_session(
        language="python",
        workspace_root=tmp_path,
        command=command,
    )
    second = manager.ensure_session(
        language="python",
        workspace_root=tmp_path,
        command=command,
    )

    assert first is second
    assert len(created) == 1
    assert first.is_running


def test_manager_replaces_closed_session(tmp_path: Path) -> None:
    created: list[FakeSession] = []

    def factory(command: tuple[str, ...], workspace_root: Path) -> FakeSession:
        session = FakeSession(command, workspace_root)
        created.append(session)
        return session

    manager = LSPManager(session_factory=factory)
    first = manager.ensure_session(
        language="python",
        workspace_root=tmp_path,
        command=("fake-server",),
    )
    first.close()

    second = manager.ensure_session(
        language="python",
        workspace_root=tmp_path,
        command=("fake-server",),
    )

    assert second is not first
    assert len(created) == 2
    assert second.is_running


def test_manager_replaces_closed_session_clears_old_document_state(tmp_path: Path) -> None:
    created: list[FakeSession] = []

    def factory(command: tuple[str, ...], workspace_root: Path) -> FakeSession:
        session = FakeSession(command, workspace_root)
        created.append(session)
        return session

    manager = LSPManager(session_factory=factory)
    target = tmp_path / "module.py"
    target.write_text("print('one')\n", encoding="utf-8")
    first = manager.ensure_session(
        language="python",
        workspace_root=tmp_path,
        command=("fake-server",),
    )
    first_sync = manager.sync_document(session=first, language="python", file_path=target)
    first.close()

    second = manager.ensure_session(
        language="python",
        workspace_root=tmp_path,
        command=("fake-server",),
    )
    target.write_text("print('two')\n", encoding="utf-8")
    second_sync = manager.sync_document(session=second, language="python", file_path=target)

    assert first_sync.version == 1
    assert second_sync.version == 1
    assert second.notifications[0][0] == "textDocument/didOpen"
    assert all(key[0] != id(first) for key in manager._document_versions)


def test_manager_evicts_idle_sessions(tmp_path: Path, monkeypatch) -> None:
    now = 1_000.0
    manager = LSPManager(
        idle_timeout_seconds=5.0,
        session_factory=FakeSession,
        clock=lambda: now,
    )
    session = manager.ensure_session(
        language="python",
        workspace_root=tmp_path,
        command=("fake-server",),
    )

    now = 1_006.0
    evicted = manager.evict_idle_sessions()

    assert evicted == 1
    assert session.closed


def test_manager_shutdown_closes_all_sessions(tmp_path: Path) -> None:
    manager = LSPManager(session_factory=FakeSession)
    first = manager.ensure_session(
        language="python",
        workspace_root=tmp_path,
        command=("python-server",),
    )
    second = manager.ensure_session(
        language="typescript",
        workspace_root=tmp_path,
        command=("ts-server",),
    )

    manager.shutdown()

    assert first.closed
    assert second.closed


def test_manager_initialize_advertises_definition_and_references(tmp_path: Path) -> None:
    manager = LSPManager(session_factory=FakeSession)
    session = manager.ensure_session(
        language="python",
        workspace_root=tmp_path,
        command=("python-server",),
    )

    manager.ensure_initialized(session=session, language="python", workspace_root=tmp_path)

    assert session.requests[0][0] == "initialize"
    capabilities = session.requests[0][1]["capabilities"]["textDocument"]  # type: ignore[index]
    assert capabilities["definition"] == {"linkSupport": True}
    assert capabilities["references"] == {}
    assert session.notifications[-1] == ("initialized", {})


def test_manager_sync_document_sends_open_then_change(tmp_path: Path) -> None:
    manager = LSPManager(session_factory=FakeSession)
    session = manager.ensure_session(
        language="python",
        workspace_root=tmp_path,
        command=("python-server",),
    )
    target = tmp_path / "module.py"
    target.write_text("print('one')\n", encoding="utf-8")

    first = manager.sync_document(session=session, language="python", file_path=target)
    target.write_text("print('two')\n", encoding="utf-8")
    second = manager.sync_document(session=session, language="python", file_path=target)

    assert first.stale_content is False
    assert first.version == 1
    assert second.stale_content is False
    assert second.version == 2
    assert session.notifications[0][0] == "textDocument/didOpen"
    assert session.notifications[0][1]["textDocument"]["text"] == "print('one')\n"
    assert session.notifications[1][0] == "textDocument/didChange"
    assert session.notifications[1][1]["contentChanges"] == [{"text": "print('two')\n"}]


def test_manager_sync_document_reports_stale_when_file_cannot_be_read(
    tmp_path: Path,
) -> None:
    manager = LSPManager(session_factory=FakeSession)
    session = manager.ensure_session(
        language="python",
        workspace_root=tmp_path,
        command=("python-server",),
    )

    result = manager.sync_document(
        session=session,
        language="python",
        file_path=tmp_path / "missing.py",
    )

    assert result.stale_content is True
    assert result.version == 0
    assert str(tmp_path) not in result.reason
    assert session.notifications == []


def test_manager_sync_document_reports_stale_when_notify_fails(tmp_path: Path) -> None:
    manager = LSPManager(session_factory=FailingNotifySession)
    session = manager.ensure_session(
        language="python",
        workspace_root=tmp_path,
        command=("python-server",),
    )
    target = tmp_path / "module.py"
    target.write_text("print('one')\n", encoding="utf-8")

    result = manager.sync_document(session=session, language="python", file_path=target)

    assert result.stale_content is True
    assert result.version == 0
    assert "LSPProtocolError" in result.reason
    assert "secret.py" not in result.reason


def test_manager_falls_back_to_published_diagnostics_when_pull_is_unsupported(
    tmp_path: Path,
) -> None:
    manager = LSPManager(session_factory=PullUnsupportedDiagnosticsSession)
    session = manager.ensure_session(
        language="python",
        workspace_root=tmp_path,
        command=("python-server",),
    )
    target = tmp_path / "module.py"
    target.write_text("print('one')\n", encoding="utf-8")
    uri = target.as_uri()
    session.notifications_to_drain.append(
        {
            "method": "textDocument/publishDiagnostics",
            "params": {
                "uri": uri,
                "diagnostics": [{"severity": 1, "message": "broken"}],
            },
        }
    )

    result = manager.request_document_diagnostics(session=session, uri=uri)

    assert result == {
        "diagnostics": [{"severity": 1, "message": "broken"}],
        "source": "publishDiagnostics",
    }
