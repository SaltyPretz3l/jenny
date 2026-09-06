"""Red-first contract for the W2a `## Session Environment` overlay.

Every fact in the block must come from the same expression the behavior uses,
so the block can never drift from what tools actually do. The overlay is
flag-gated, fail-closed, self-replacing (registered heading), and restates the
capability snapshot with a change note when the offered tool surface moved
between turns of the same session.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.context.request_fingerprint import tool_schema_capability_hash
from sidecar.ai.context.runtime_message_markers import (
    RUNTIME_SYSTEM_MESSAGE_HEADINGS,
    SESSION_ENVIRONMENT_HEADING,
)
from sidecar.ai.context.runtime_overlays import (
    RuntimeOverlayLogContext,
    append_session_environment_runtime_system_message,
)
from sidecar.ai.tools.builtins.shell import _shell_name

_SCHEMAS = [{"name": "read_file", "parameters": {"type": "object"}}]
_OTHER_SCHEMAS = [{"name": "write_file", "parameters": {"type": "object"}}]


def _log_context() -> RuntimeOverlayLogContext:
    return RuntimeOverlayLogContext(
        logger=logging.getLogger("test.session-environment"),
        component="ai.router",
        event="ai.router.session_environment_overlay_failed",
        request_id="req-1",
        session_id="sess-1",
    )


def _config(**overrides: Any) -> SimpleNamespace:
    defaults: dict[str, Any] = {
        "session_environment_overlay_enabled": True,
        "tools_python_runtime_enabled": False,
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _render(
    *,
    workspace_root: Path | None,
    config: Any = None,
    schemas: list[dict[str, Any]] | None = None,
    session_id: str = "sess-1",
) -> list[str]:
    messages: list[str] = []
    append_session_environment_runtime_system_message(
        messages,
        config=config if config is not None else _config(),
        context_builder=ContextBuilder(workspace_root),
        tool_schemas=schemas if schemas is not None else _SCHEMAS,
        session_id=session_id,
        log_context=_log_context(),
    )
    return messages


def test_heading_is_registered_append_only() -> None:
    assert SESSION_ENVIRONMENT_HEADING == "## Session Environment"
    assert RUNTIME_SYSTEM_MESSAGE_HEADINGS[-1] == SESSION_ENVIRONMENT_HEADING
    # Existing headings keep their positions (append-only tuple).
    assert RUNTIME_SYSTEM_MESSAGE_HEADINGS[0] == "## Recalled Memories"


def test_block_states_the_root_and_the_sourced_facts(tmp_path: Path) -> None:
    messages = _render(workspace_root=tmp_path)
    assert len(messages) == 1
    block = messages[0]
    assert block.startswith(SESSION_ENVIRONMENT_HEADING)
    # pytest tmp_path sits under the user's home, so the root may render with
    # the ~ alias; accept either spelling but require the distinctive tail.
    root_line = next(line for line in block.splitlines() if line.startswith("workspace_root:"))
    assert tmp_path.name in root_line
    assert f"platform: {sys.platform}" in block
    assert f"shell: {_shell_name()}" in block
    assert "Do not guess or infer" in block
    assert "There is no /workspace, /repo, or /app on this machine." in block
    assert "Every relative path in tool arguments and output is relative to workspace_root." in block


def test_windows_path_facts() -> None:
    # This suite runs on Windows in this repo; pin the platform-derived trio.
    import os

    messages = _render(workspace_root=Path.cwd())
    block = messages[0]
    if os.name == "nt":
        assert "path_style: windows_backslash" in block
        assert "case_sensitive_paths: no" in block
    else:
        assert "path_style: posix_slash" in block
        assert "case_sensitive_paths: yes" in block


def test_git_repo_fact_uses_the_shared_probe(tmp_path: Path) -> None:
    no_repo = _render(workspace_root=tmp_path)[0]
    assert "git_repo: no" in no_repo
    assert "repo_root: none" in no_repo

    (tmp_path / ".git").mkdir()
    with_repo = _render(workspace_root=tmp_path)[0]
    assert "git_repo: yes" in with_repo
    assert "repo_root: same as workspace_root" in with_repo


def test_python_runtime_disabled_and_not_built(tmp_path: Path) -> None:
    disabled = _render(workspace_root=tmp_path, config=_config())[0]
    assert "python_runtime: disabled" in disabled

    enabled = _render(
        workspace_root=tmp_path,
        config=_config(tools_python_runtime_enabled=True),
    )[0]
    assert "python_runtime:" in enabled
    assert "python_runtime: disabled" not in enabled


def test_capability_snapshot_matches_the_shared_hash(tmp_path: Path) -> None:
    block = _render(workspace_root=tmp_path)[0]
    expected = tool_schema_capability_hash(_SCHEMAS)
    assert len(expected) == 16
    assert f"capability_snapshot: {expected}" in block


def test_capability_change_note_appears_only_on_change(tmp_path: Path) -> None:
    session = "sess-change-note"
    first = _render(workspace_root=tmp_path, schemas=_SCHEMAS, session_id=session)[0]
    assert "changed since the previous turn" not in first

    same = _render(workspace_root=tmp_path, schemas=_SCHEMAS, session_id=session)[0]
    assert "changed since the previous turn" not in same

    changed = _render(workspace_root=tmp_path, schemas=_OTHER_SCHEMAS, session_id=session)[0]
    assert "capability_snapshot changed since the previous turn; re-read Executable Tools." in changed

    # A different session is isolated from this one's history.
    other = _render(workspace_root=tmp_path, schemas=_SCHEMAS, session_id="sess-other")[0]
    assert "changed since the previous turn" not in other


def test_missing_workspace_root_is_an_explicit_refusal() -> None:
    block = _render(workspace_root=None)[0]
    assert "workspace_root: <not set" in block
    assert "git_repo:" not in block
    assert "There is no /workspace, /repo, or /app on this machine." in block


def test_flag_off_appends_nothing(tmp_path: Path) -> None:
    messages = _render(
        workspace_root=tmp_path,
        config=_config(session_environment_overlay_enabled=False),
    )
    assert messages == []


def test_fail_closed_on_broken_context_builder() -> None:
    class _Broken:
        def workspace_status(self) -> Any:
            raise RuntimeError("boom")

    messages: list[str] = []
    append_session_environment_runtime_system_message(
        messages,
        config=_config(),
        context_builder=_Broken(),
        tool_schemas=_SCHEMAS,
        session_id="sess-1",
        log_context=_log_context(),
    )
    assert messages == []


def test_home_rooted_workspace_renders_tilde_alias(tmp_path: Path, monkeypatch: Any) -> None:
    home = tmp_path / "home"
    root = home / "Projects" / "demo"
    root.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    block = _render(workspace_root=root)[0]
    root_line = next(line for line in block.splitlines() if line.startswith("workspace_root:"))
    assert root_line.startswith("workspace_root: ~")
    assert str(home) not in root_line
