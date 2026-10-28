"""A failed scope enter unwinds the ContextVars it already pushed (tool review C6 #4).

``with scope:`` never calls ``__exit__`` when ``__enter__`` raises, so the
knowledge-registry and skill-state scopes of a request whose hosted file-IO
binding failed used to stay bound in the single dispatch thread.
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

import pytest

from sidecar.ai.mcp import builtin_request_scope as scope_module
from sidecar.ai.tools.workspace import WorkspaceGuard


def test_enter_failure_exits_already_entered_scopes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    events: list[str] = []

    @contextmanager
    def _recording(*_args, **_kwargs):
        events.append("enter")
        try:
            yield
        finally:
            events.append("exit")

    def _boom(*_args, **_kwargs):
        raise RuntimeError("hosted root mismatch")

    monkeypatch.setattr(scope_module, "scoped_knowledge_tools", _recording)
    monkeypatch.setattr(scope_module, "scoped_skill_tool", _recording)
    monkeypatch.setattr(scope_module._hosted_file_io, "scoped_hosted_file_io", _boom)
    scope = scope_module.BuiltinRequestScope(
        workspace=WorkspaceGuard(str(tmp_path)),
        workspace_device_id=None,
        workspace_inode=None,
        knowledge_roots=(),
        skills_config=None,
        hosted=False,
    )

    with pytest.raises(RuntimeError, match="hosted root mismatch"):
        scope.__enter__()

    assert events == ["enter", "enter", "exit", "exit"]
