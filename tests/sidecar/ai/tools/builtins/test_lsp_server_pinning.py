"""Regression coverage for trusted TypeScript implementation pinning."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins.lsp import LSPProtocolError
from sidecar.ai.tools.builtins.lsp.manager import LSPManager, LSPServerCommand
from sidecar.ai.tools.builtins.lsp.tools import configure_lsp_tools, lsp_symbols_tool
from sidecar.ai.tools.workspace import WorkspaceGuard


class FakeSession:
    def __init__(self, command: tuple[str, ...], workspace_root: Path) -> None:
        self.command = command
        self.workspace_root = workspace_root
        self.started = False
        self.closed = False
        self.requests: list[tuple[str, dict[str, object] | None]] = []
        self.notifications: list[tuple[str, dict[str, object]]] = []

    @property
    def is_running(self) -> bool:
        return self.started and not self.closed

    def start(self) -> None:
        self.started = True

    def close(self) -> None:
        self.closed = True

    def request(self, method: str, params: dict[str, object] | None = None) -> object:
        self.requests.append((method, params))
        return {}

    def notify(self, method: str, params: dict[str, object]) -> None:
        self.notifications.append((method, params))


def _write_file(path: Path, content: str = "// marker\n") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def test_typescript_initialize_pins_sibling_implementation(tmp_path: Path) -> None:
    install_root = tmp_path / "trusted-install"
    launcher = _write_file(install_root / "typescript-language-server.cmd", "@echo off\n")
    trusted_tsserver = _write_file(
        install_root / "node_modules" / "typescript" / "lib" / "tsserver.js"
    )
    workspace = tmp_path / "workspace"
    workspace_tsserver = _write_file(
        workspace / "node_modules" / "typescript" / "lib" / "tsserver.js",
        "// untrusted workspace marker\n",
    )
    manager = LSPManager(session_factory=FakeSession)

    session = manager.ensure_session(
        language="typescript",
        workspace_root=workspace,
        command=(str(launcher), "--stdio"),
    )
    manager.ensure_initialized(
        session=session,
        language="typescript",
        workspace_root=workspace,
    )

    method, params = session.requests[0]
    assert method == "initialize"
    assert params is not None
    assert params["initializationOptions"] == {
        "language": "typescript",
        "tsserver": {"path": str(trusted_tsserver.resolve())},
        "disableAutomaticTypingAcquisition": True,
    }
    assert str(workspace_tsserver.resolve()) not in str(params)


def test_typescript_without_sibling_implementation_never_starts(
    tmp_path: Path,
) -> None:
    launcher = _write_file(
        tmp_path / "trusted-install" / "typescript-language-server.cmd",
        "@echo off\n",
    )
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    created: list[FakeSession] = []

    def factory(command: tuple[str, ...], workspace_root: Path) -> FakeSession:
        session = FakeSession(command, workspace_root)
        created.append(session)
        return session

    manager = LSPManager(session_factory=factory)
    session = manager.ensure_session(
        language="typescript",
        workspace_root=workspace,
        command=(str(launcher), "--stdio"),
    )

    with pytest.raises(LSPProtocolError, match="lsp_server_not_pinned"):
        manager.ensure_initialized(
            session=session,
            language="typescript",
            workspace_root=workspace,
        )

    assert created == [session]
    assert session.started is False
    assert session.requests == []


def test_typescript_pin_failure_returns_legible_tool_result(tmp_path: Path) -> None:
    launcher = _write_file(
        tmp_path / "trusted-install" / "typescript-language-server.cmd",
        "@echo off\n",
    )
    workspace = tmp_path / "workspace"
    target = _write_file(workspace / "module.ts", "const value = 1;\n")
    created: list[FakeSession] = []

    def factory(command: tuple[str, ...], workspace_root: Path) -> FakeSession:
        session = FakeSession(command, workspace_root)
        created.append(session)
        return session

    configure_lsp_tools(
        {"tools_lsp_enabled": True},
        manager=LSPManager(session_factory=factory),
        detected_servers={
            "typescript": LSPServerCommand(
                language="typescript",
                executable=str(launcher),
                source="configured",
            )
        },
    )

    result = lsp_symbols_tool({"path": target.name}, WorkspaceGuard(str(workspace)))
    payload = json.loads(result.output)

    assert result.success is False
    assert payload["status"] == "degraded"
    assert payload["reason"] == "LSP request failed: lsp_server_not_pinned"
    assert len(created) == 1
    assert created[0].started is False
    assert created[0].requests == []
