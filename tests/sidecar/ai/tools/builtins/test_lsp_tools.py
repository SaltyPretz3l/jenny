from __future__ import annotations

import json
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_DISABLED, CMP_TOOL_IO_FAILED
from sidecar.ai.tools.builtins.lsp.manager import (
    LSPDocumentSyncResult,
    LSPServerCommand,
    LSPUnavailableResult,
)
from sidecar.ai.tools.builtins.lsp.paths import resolve_lsp_target
from sidecar.ai.tools.builtins.lsp.tools import (
    configure_lsp_tools,
    lsp_definition_tool,
    lsp_diagnostics_tool,
    lsp_references_tool,
    lsp_symbols_tool,
    shutdown_lsp_tools,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


class FakeSession:
    def __init__(self, responses: dict[str, object]) -> None:
        self.responses = responses
        self.requests: list[tuple[str, dict[str, object]]] = []
        self.notifications: list[tuple[str, dict[str, object]]] = []

    @property
    def is_running(self) -> bool:
        return True

    def start(self) -> None:
        return None

    def close(self) -> None:
        return None

    def touch(self) -> None:
        return None

    def notify(self, method: str, params: dict[str, object]) -> None:
        self.notifications.append((method, params))

    def request(self, method: str, params: dict[str, object] | None = None) -> object:
        payload = params or {}
        self.requests.append((method, payload))
        return self.responses.get(method)


class FakeManager:
    def __init__(
        self,
        session: FakeSession,
        *,
        sync_result: LSPDocumentSyncResult | None = None,
    ) -> None:
        self.session = session
        self.sync_result = sync_result
        self.ensure_calls: list[dict[str, object]] = []
        self.document_diagnostic_calls: list[dict[str, object]] = []
        self.lifecycle_calls: list[str] = []

    def evict_idle_sessions(self) -> int:
        self.lifecycle_calls.append("evict_idle_sessions")
        return 0

    def shutdown(self) -> None:
        self.lifecycle_calls.append("shutdown")

    def ensure_session(self, **kwargs: object) -> FakeSession:
        self.lifecycle_calls.append("ensure_session")
        self.ensure_calls.append(kwargs)
        return self.session

    def ensure_initialized(self, **kwargs: object) -> None:
        self.session.requests.append(("initialize", dict(kwargs)))

    def sync_document(self, **kwargs: object) -> LSPDocumentSyncResult:
        file_path = Path(str(kwargs["file_path"])).resolve(strict=False)
        return self.sync_result or LSPDocumentSyncResult(uri=file_path.as_uri(), version=1)

    def request_document_diagnostics(self, **kwargs: object) -> object:
        uri = str(kwargs["uri"])
        self.document_diagnostic_calls.append(kwargs)
        return self.session.request(
            "textDocument/diagnostic",
            {"textDocument": {"uri": uri}},
        )


def _server(language: str = "python") -> LSPServerCommand:
    return LSPServerCommand(
        language=language,  # type: ignore[arg-type]
        executable="fake-language-server",
        source="configured",
    )


def test_lsp_diagnostics_tool_syncs_document_and_returns_bounded_payload(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    target = workspace_root / "module.py"
    target.write_text("print('x')\n", encoding="utf-8")
    session = FakeSession(
        {
            "textDocument/diagnostic": {
                "items": [
                    {
                        "severity": 1,
                        "source": "pyright",
                        "message": "broken",
                        "range": {
                            "start": {"line": 0, "character": 0},
                            "end": {"line": 0, "character": 5},
                        },
                    }
                ]
            }
        }
    )
    manager = FakeManager(session)
    configure_lsp_tools(
        {"tools_lsp_enabled": True},
        manager=manager,
        detected_servers={"python": _server()},
    )

    result = lsp_diagnostics_tool(
        {"path": "module.py", "max_diagnostics": 5},
        WorkspaceGuard(str(workspace_root)),
    )
    payload = json.loads(result.output)

    assert result.success is True
    assert result.metadata == {
        "result_kind": "lsp_diagnostics",
        "language": "python",
        "file": "module.py",
        "truncated": False,
    }
    assert payload["status"] == "ready"
    assert payload["diagnostics"][0]["severity"] == "error"
    assert manager.ensure_calls[0]["command"] == ("fake-language-server",)
    assert manager.document_diagnostic_calls[0]["uri"] == target.as_uri()
    assert session.requests[-1] == (
        "textDocument/diagnostic",
        {"textDocument": {"uri": target.as_uri()}},
    )


def test_lsp_symbols_tool_flattens_document_symbols(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    target = workspace_root / "module.py"
    target.write_text("class Outer:\n    def method(self):\n        pass\n", encoding="utf-8")
    session = FakeSession(
        {
            "textDocument/documentSymbol": [
                {
                    "name": "Outer",
                    "kind": 5,
                    "range": {
                        "start": {"line": 0, "character": 0},
                        "end": {"line": 2, "character": 12},
                    },
                    "selectionRange": {
                        "start": {"line": 0, "character": 6},
                        "end": {"line": 0, "character": 11},
                    },
                }
            ]
        }
    )
    manager = FakeManager(session)
    configure_lsp_tools(
        {"tools_lsp_enabled": True},
        manager=manager,
        detected_servers={"python": _server()},
    )

    result = lsp_symbols_tool({"path": "module.py"}, WorkspaceGuard(str(workspace_root)))
    payload = json.loads(result.output)

    assert result.success is True
    assert result.metadata["result_kind"] == "lsp_symbols"
    assert payload["status"] == "ready"
    assert payload["symbols"][0]["kind"] == "class"
    assert session.requests[-1] == (
        "textDocument/documentSymbol",
        {"textDocument": {"uri": target.as_uri()}},
    )


def test_lsp_definition_tool_normalizes_locations_and_omits_external_targets(
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    target = workspace_root / "module.py"
    sibling = workspace_root / "other.py"
    outside = tmp_path / "outside.py"
    target.write_text("from other import thing\nthing()\n", encoding="utf-8")
    sibling.write_text("def thing():\n    pass\n", encoding="utf-8")
    outside.write_text("def hidden():\n    pass\n", encoding="utf-8")
    session = FakeSession(
        {
            "textDocument/definition": [
                {
                    "uri": sibling.as_uri(),
                    "range": {
                        "start": {"line": 0, "character": 4},
                        "end": {"line": 0, "character": 9},
                    },
                },
                {
                    "targetUri": target.as_uri(),
                    "targetRange": {
                        "start": {"line": 1, "character": 0},
                        "end": {"line": 1, "character": 5},
                    },
                    "targetSelectionRange": {
                        "start": {"line": 1, "character": 0},
                        "end": {"line": 1, "character": 5},
                    },
                },
                {
                    "uri": "https://example.invalid/external.py",
                    "range": {
                        "start": {"line": 0, "character": 0},
                        "end": {"line": 0, "character": 1},
                    },
                },
                {
                    "uri": outside.as_uri(),
                    "range": {
                        "start": {"line": 0, "character": 0},
                        "end": {"line": 0, "character": 1},
                    },
                },
                {"uri": sibling.as_uri(), "range": {"start": {"line": -1}}},
            ]
        }
    )
    configure_lsp_tools(
        {"tools_lsp_enabled": True},
        manager=FakeManager(session),
        detected_servers={"python": _server()},
    )

    result = lsp_definition_tool(
        {"path": "module.py", "line": 1, "character": 0, "max_locations": 5},
        WorkspaceGuard(str(workspace_root)),
    )
    payload = json.loads(result.output)

    assert result.success is True
    assert result.metadata == {
        "result_kind": "lsp_definition",
        "language": "python",
        "file": "module.py",
        "truncated": False,
    }
    assert session.requests[-1] == (
        "textDocument/definition",
        {
            "textDocument": {"uri": target.as_uri()},
            "position": {"line": 1, "character": 0},
        },
    )
    assert payload["definitions"] == [
        {
            "file": "other.py",
            "range": {
                "start": {"line": 0, "character": 4},
                "end": {"line": 0, "character": 9},
            },
        },
        {
            "file": "module.py",
            "range": {
                "start": {"line": 1, "character": 0},
                "end": {"line": 1, "character": 5},
            },
            "selection_range": {
                "start": {"line": 1, "character": 0},
                "end": {"line": 1, "character": 5},
            },
        },
    ]
    assert payload["total_count"] == 2
    assert payload["omitted_external_count"] == 2
    assert payload["malformed_count"] == 1
    assert payload["position"] == {"line": 1, "character": 0}
    assert str(tmp_path) not in result.output


def test_lsp_references_tool_groups_by_file_and_truncates(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    target = workspace_root / "module.py"
    sibling = workspace_root / "other.py"
    target.write_text("thing()\nthing()\n", encoding="utf-8")
    sibling.write_text("thing()\n", encoding="utf-8")
    session = FakeSession(
        {
            "textDocument/references": [
                {
                    "uri": target.as_uri(),
                    "range": {
                        "start": {"line": 0, "character": 0},
                        "end": {"line": 0, "character": 5},
                    },
                },
                {
                    "uri": target.as_uri(),
                    "range": {
                        "start": {"line": 1, "character": 0},
                        "end": {"line": 1, "character": 5},
                    },
                },
                {
                    "uri": sibling.as_uri(),
                    "range": {
                        "start": {"line": 0, "character": 0},
                        "end": {"line": 0, "character": 5},
                    },
                },
            ]
        }
    )
    configure_lsp_tools(
        {"tools_lsp_enabled": True},
        manager=FakeManager(session),
        detected_servers={"python": _server()},
    )

    result = lsp_references_tool(
        {
            "path": "module.py",
            "line": 0,
            "character": 0,
            "include_declaration": True,
            "max_references": 2,
        },
        WorkspaceGuard(str(workspace_root)),
    )
    payload = json.loads(result.output)

    assert result.success is True
    assert session.requests[-1] == (
        "textDocument/references",
        {
            "textDocument": {"uri": target.as_uri()},
            "position": {"line": 0, "character": 0},
            "context": {"includeDeclaration": True},
        },
    )
    assert payload["references_by_file"] == [
        {
            "file": "module.py",
            "references": [
                {
                    "range": {
                        "start": {"line": 0, "character": 0},
                        "end": {"line": 0, "character": 5},
                    }
                },
                {
                    "range": {
                        "start": {"line": 1, "character": 0},
                        "end": {"line": 1, "character": 5},
                    }
                },
            ],
        }
    ]
    assert payload["total_count"] == 3
    assert payload["truncated"] is True


@pytest.mark.parametrize(
    "arguments",
    [
        {"path": "module.py", "line": True, "character": 0},
        {"path": "module.py", "line": 0, "character": -1},
        {"path": "module.py", "line": 2_147_483_648, "character": 0},
    ],
)
def test_lsp_position_arguments_reject_malformed_values(
    tmp_path: Path,
    arguments: dict[str, object],
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "module.py").write_text("print('x')\n", encoding="utf-8")

    with pytest.raises(ToolExecutionFailure):
        lsp_definition_tool(arguments, WorkspaceGuard(str(workspace_root)))


def test_resolve_lsp_target_reports_supported_extensions_for_html(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "foo.html").write_text("<main></main>\n", encoding="utf-8")

    with pytest.raises(ToolExecutionFailure) as exc_info:
        resolve_lsp_target({"path": "foo.html"}, WorkspaceGuard(str(workspace_root)))

    assert exc_info.value.message == (
        "lsp does not support .html files. "
        "Supported: .ts, .tsx, .mts, .cts, .js, .jsx, .mjs, .cjs, .py, .pyi. "
        "For other file types use read_file, grep_search, or edit_file instead."
    )


def test_resolve_lsp_target_reports_extensionless_path(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "Makefile").write_text("all:\n", encoding="utf-8")

    with pytest.raises(ToolExecutionFailure) as exc_info:
        resolve_lsp_target({"path": "Makefile"}, WorkspaceGuard(str(workspace_root)))

    assert exc_info.value.message.startswith(
        "lsp does not support files without an extension. Supported:"
    )


def test_lsp_tool_returns_unavailable_when_server_missing(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "module.py").write_text("print('x')\n", encoding="utf-8")
    configure_lsp_tools(
        {"tools_lsp_enabled": True},
        manager=FakeManager(FakeSession({})),
        detected_servers={},
    )

    result = lsp_diagnostics_tool({"path": "module.py"}, WorkspaceGuard(str(workspace_root)))
    payload = json.loads(result.output)

    assert result.success is False
    assert result.error_code == CMP_TOOL_DISABLED
    assert payload["status"] == "unavailable"
    assert payload["language"] == "python"


def test_lsp_references_tool_returns_empty_group_when_server_missing(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "module.py").write_text("print('x')\n", encoding="utf-8")
    configure_lsp_tools(
        {"tools_lsp_enabled": True},
        manager=FakeManager(FakeSession({})),
        detected_servers={},
    )

    result = lsp_references_tool(
        {"path": "module.py", "line": 0, "character": 0},
        WorkspaceGuard(str(workspace_root)),
    )
    payload = json.loads(result.output)

    assert result.success is False
    assert result.error_code == CMP_TOOL_DISABLED
    assert payload["references_by_file"] == []
    assert payload["position"] == {"line": 0, "character": 0}


def test_lsp_tool_redacts_configured_command_when_unavailable(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "module.py").write_text("print('x')\n", encoding="utf-8")
    configure_lsp_tools(
        {"tools_lsp_enabled": True},
        manager=FakeManager(FakeSession({})),
        detected_servers={
            "python": LSPUnavailableResult(
                language="python",
                reason="configured command not found: C:\\Users\\example\\secret-server.exe",
                install_hint="configure tools_lsp_command_python",
                configured_command="C:\\Users\\example\\secret-server.exe",
            )
        },
    )

    result = lsp_diagnostics_tool({"path": "module.py"}, WorkspaceGuard(str(workspace_root)))
    payload = json.loads(result.output)

    assert result.success is False
    assert payload["reason"] == "configured language-server command was not found"
    assert payload["configured_command_present"] is True
    assert "secret-server" not in result.output


def test_lsp_tool_returns_stale_result_when_document_sync_fails(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    target = workspace_root / "module.py"
    target.write_text("print('x')\n", encoding="utf-8")
    configure_lsp_tools(
        {"tools_lsp_enabled": True},
        manager=FakeManager(
            FakeSession({}),
            sync_result=LSPDocumentSyncResult(
                uri=target.as_uri(),
                version=0,
                stale_content=True,
                reason="failed to read document before LSP sync: OSError",
            ),
        ),
        detected_servers={"python": _server()},
    )

    result = lsp_symbols_tool({"path": "module.py"}, WorkspaceGuard(str(workspace_root)))
    payload = json.loads(result.output)

    assert result.success is False
    assert result.error_code == CMP_TOOL_IO_FAILED
    assert payload["status"] == "stale_content"
    assert payload["stale_content"] is True
    assert payload["reason"] == "failed to read document before LSP sync: OSError"


def test_lsp_definition_tool_returns_stale_result_when_document_sync_fails(
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    target = workspace_root / "module.py"
    target.write_text("print('x')\n", encoding="utf-8")
    configure_lsp_tools(
        {"tools_lsp_enabled": True},
        manager=FakeManager(
            FakeSession({}),
            sync_result=LSPDocumentSyncResult(
                uri=target.as_uri(),
                version=0,
                stale_content=True,
                reason="failed to read document before LSP sync: OSError",
            ),
        ),
        detected_servers={"python": _server()},
    )

    result = lsp_definition_tool(
        {"path": "module.py", "line": 0, "character": 0},
        WorkspaceGuard(str(workspace_root)),
    )
    payload = json.loads(result.output)

    assert result.success is False
    assert result.error_code == CMP_TOOL_IO_FAILED
    assert payload["status"] == "stale_content"
    assert payload["definitions"] == []
    assert payload["position"] == {"line": 0, "character": 0}


def test_lsp_request_evicts_idle_sessions_before_acquisition(tmp_path: Path) -> None:
    # W2-26-F06: without an eviction checkpoint on the request path, idle
    # language servers accumulate for the sidecar's lifetime.
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    (workspace_root / "module.py").write_text("print('x')\n", encoding="utf-8")
    manager = FakeManager(FakeSession({"textDocument/diagnostic": {"items": []}}))
    configure_lsp_tools(
        {"tools_lsp_enabled": True},
        manager=manager,
        detected_servers={"python": _server()},
    )

    result = lsp_diagnostics_tool(
        {"path": "module.py"},
        WorkspaceGuard(str(workspace_root)),
    )

    assert result.success is True
    assert manager.lifecycle_calls[:2] == ["evict_idle_sessions", "ensure_session"]


def test_shutdown_lsp_tools_closes_the_configured_manager() -> None:
    manager = FakeManager(FakeSession({}))
    configure_lsp_tools(
        {"tools_lsp_enabled": True},
        manager=manager,
        detected_servers={"python": _server()},
    )

    shutdown_lsp_tools()

    assert manager.lifecycle_calls == ["shutdown"]
