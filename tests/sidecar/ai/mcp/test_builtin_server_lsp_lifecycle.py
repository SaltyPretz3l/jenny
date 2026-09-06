"""The builtin server's exit path must shut down cached LSP sessions.

W2-26-F06: language-server child processes are cached by the process-local
LSPManager; without a shutdown hook on the server's loop exit they orphan
when the builtin server leaves its stdin loop.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.mcp import builtin_server


def test_main_shuts_down_lsp_sessions_when_the_stdin_loop_exits(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        builtin_server,
        "shutdown_lsp_tools",
        lambda: calls.append("shutdown_lsp_tools"),
    )
    monkeypatch.setattr(
        builtin_server.sys,
        "stdin",
        type("EmptyStdin", (), {"readline": staticmethod(lambda: "")})(),
    )

    builtin_server.main(["--workspace-root", str(tmp_path)])

    assert calls == ["shutdown_lsp_tools"]
