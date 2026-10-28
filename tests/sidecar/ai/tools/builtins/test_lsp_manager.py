"""LSP Phase 1 tests — detection and language resolution only.

Phase 2 tests for JSON-RPC framing, session lifecycle, and tool handlers
will live in test_lsp_protocol.py / test_lsp_tools.py once those layers ship.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.tools.builtins.lsp import (
    LSPUnavailableResult,
    detect_language_servers,
    resolve_language_for_path,
    server_detection,
)
from sidecar.ai.tools.builtins.lsp.manager import LSPServerCommand
from tests.sidecar._platform_skips import windows_only


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("src/main.py", "python"),
        ("lib/util.ts", "typescript"),
        ("lib/util.tsx", "typescript"),
        ("lib/util.mts", "typescript"),
        ("lib/util.js", "javascript"),
        ("lib/util.mjs", "javascript"),
        ("lib/util.cjs", "javascript"),
        ("docs/readme.md", None),
        ("scripts/run.sh", None),
        ("noext_file", None),
    ],
)
def test_resolve_language_for_path(path: str, expected: str | None) -> None:
    assert resolve_language_for_path(path) == expected


def test_resolve_language_handles_pathlib_path(tmp_path: Path) -> None:
    target = tmp_path / "module.py"
    assert resolve_language_for_path(target) == "python"


def test_detect_language_servers_returns_unavailable_when_nothing_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Force the PATH lookup to always miss so we test the unavailable path.
    monkeypatch.setattr(server_detection, "_which_on_path", lambda _name: None)
    result = detect_language_servers()
    assert set(result.keys()) == {"typescript", "python"}
    for entry in result.values():
        assert isinstance(entry, LSPUnavailableResult)
        assert entry.install_hint is not None


def test_detect_language_servers_uses_configured_command(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Pretend a configured TypeScript command exists as an absolute file path.
    fake_server = tmp_path / "typescript-server"
    fake_server.write_text("#!/usr/bin/env node\n", encoding="utf-8")

    # Disable PATH discovery so we only test the configured branch.
    monkeypatch.setattr(server_detection, "_which_on_path", lambda _name: None)

    result = detect_language_servers(
        configured_typescript_command=str(fake_server),
        configured_python_command=None,
    )
    ts_entry = result["typescript"]
    assert isinstance(ts_entry, LSPServerCommand)
    assert ts_entry.executable == str(fake_server)
    assert ts_entry.source == "configured"

    py_entry = result["python"]
    assert isinstance(py_entry, LSPUnavailableResult)


def test_detect_language_servers_rejects_configured_directory(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    configured_directory = tmp_path / "language-server"
    configured_directory.mkdir()
    monkeypatch.setattr(server_detection, "_which_on_path", lambda _name: None)

    result = detect_language_servers(
        configured_typescript_command=str(configured_directory),
    )

    assert isinstance(result["typescript"], LSPUnavailableResult)


def test_detect_language_servers_falls_back_to_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Pretend `pyright-langserver` is on PATH but typescript-language-server is not.
    def fake_which(name: str) -> str | None:
        return f"/usr/local/bin/{name}" if name == "pyright-langserver" else None

    monkeypatch.setattr(server_detection, "_which_on_path", fake_which)
    result = detect_language_servers()
    py_entry = result["python"]
    assert isinstance(py_entry, LSPServerCommand)
    assert py_entry.executable == "/usr/local/bin/pyright-langserver"
    assert py_entry.source == "path"

    ts_entry = result["typescript"]
    assert isinstance(ts_entry, LSPUnavailableResult)


def test_detect_language_servers_does_not_treat_tsserver_as_lsp(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_which(name: str) -> str | None:
        return "/usr/local/bin/tsserver" if name == "tsserver" else None

    monkeypatch.setattr(server_detection, "_which_on_path", fake_which)
    result = detect_language_servers()

    assert isinstance(result["typescript"], LSPUnavailableResult)


def test_detect_language_servers_reports_configured_command_when_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_detection, "_which_on_path", lambda _name: None)
    result = detect_language_servers(
        configured_typescript_command="/nonexistent/path/to/server",
    )
    ts_entry = result["typescript"]
    assert isinstance(ts_entry, LSPUnavailableResult)
    assert ts_entry.configured_command == "/nonexistent/path/to/server"
    assert "not found" in ts_entry.reason
    assert "/nonexistent/path/to/server" not in ts_entry.reason


# Copied from the 2026-10-25 network/launch-point audit: shutil.which searches
# the current directory before PATH on Windows, so a launcher planted in the
# process cwd (repo root in a dev checkout, install dir when packaged) won.


@windows_only("shutil.which searches the CWD first")
def test_bug_lsp_detection_ignores_a_launcher_planted_in_the_cwd(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "pylsp.bat").write_text("@echo planted\r\n", encoding="ascii")
    empty_path = tmp_path / "empty-path"
    empty_path.mkdir()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PATH", str(empty_path))
    result = detect_language_servers()["python"]
    assert isinstance(result, LSPUnavailableResult), result


@windows_only("shutil.which searches the CWD first")
def test_bug_lsp_configured_bare_name_is_not_resolved_from_the_cwd(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "my-pyright.cmd").write_text("@echo planted\r\n", encoding="ascii")
    empty_path = tmp_path / "empty-path"
    empty_path.mkdir()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PATH", str(empty_path))
    result = detect_language_servers(configured_python_command="my-pyright")["python"]
    assert isinstance(result, LSPUnavailableResult), result
