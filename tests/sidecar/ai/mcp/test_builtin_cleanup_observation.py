"""Built-in MCP cleanup evidence propagation tests."""

from __future__ import annotations

import threading
from pathlib import Path
from types import SimpleNamespace

from sidecar.ai.mcp import builtin_server
from sidecar.ai.tools import workspace_manifest
from sidecar.ai.tools.builtins import git_ops
from sidecar.ai.tools.builtins.owned_process_observation import (
    create_process_cleanup_observer,
)
from sidecar.ai.tools.builtins.owned_process_settlement import OwnedProcessCleanupVerdict
from sidecar.ai.tools.contracts import ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_manifest import WorkspaceManifestCache

CONFIRMED = OwnedProcessCleanupVerdict(
    cleanup="confirmed",
    process_tree_terminated=True,
    output_readers_terminated=True,
)


def _call(tool: builtin_server.BuiltinTool, workspace_root: Path) -> dict:
    return builtin_server._handle_tools_call(  # noqa: SLF001
        "cleanup-observation-call",
        {tool.name: tool},
        WorkspaceGuard(str(workspace_root)),
        {"name": tool.name, "arguments": {}},
    )


def _tool(name: str, handler) -> builtin_server.BuiltinTool:
    return builtin_server.BuiltinTool(
        name=name,
        description="cleanup observation probe",
        side_effecting=False,
        input_schema={"type": "object", "properties": {}, "additionalProperties": False},
        handler=handler,
    )


def test_plain_git_string_receives_exact_owned_process_cleanup_metadata(
    monkeypatch, tmp_path: Path
) -> None:
    (tmp_path / ".git").mkdir()

    def run_git(_arguments, **_kwargs):
        observer = create_process_cleanup_observer()
        assert observer is not None
        observer(CONFIRMED)
        return SimpleNamespace(
            stdout="## main\n", stderr="", returncode=0, timed_out=False
        )

    monkeypatch.setattr(git_ops, "_run_owned_process", run_git)
    tool = builtin_server._default_tools()["git_status"]  # noqa: SLF001
    response = _call(tool, tmp_path)

    assert response["result"]["content"][0]["text"] == "## main"
    assert response["result"]["metadata"]["resource_cleanup"] == CONFIRMED.metadata()


def test_pending_background_child_remains_uncertain_at_return(tmp_path: Path) -> None:
    def start_background(_arguments, _workspace):
        assert create_process_cleanup_observer() is not None
        return "job started"

    response = _call(_tool("background_probe", start_background), tmp_path)

    assert response["result"]["metadata"]["resource_cleanup"] == {
        "cleanup": "uncertain",
        "process_tree_terminated": False,
        "output_readers_terminated": False,
        "reason": "child_cleanup_pending",
    }


def test_explicit_handler_cleanup_verdict_is_preserved(tmp_path: Path) -> None:
    explicit = {
        "cleanup": "uncertain",
        "process_tree_terminated": True,
        "output_readers_terminated": False,
        "reason": "explicit_shell_reader_pending",
    }

    def run_shell(_arguments, _workspace):
        observer = create_process_cleanup_observer()
        assert observer is not None
        observer(CONFIRMED)
        return ToolHandlerResult(output="done", metadata={"resource_cleanup": explicit})

    response = _call(_tool("run_command", run_shell), tmp_path)

    assert response["result"]["metadata"]["resource_cleanup"] == explicit


def test_soft_ttl_manifest_refresh_is_pending_before_thread_runs(
    monkeypatch, tmp_path: Path
) -> None:
    now = 1_000.0
    calls = 0
    refresh_started = threading.Event()
    release_refresh = threading.Event()
    refresh_finished = threading.Event()
    observer_seen: list[bool] = []

    def generate(root: Path) -> dict[str, object]:
        nonlocal calls
        calls += 1
        if calls == 2:
            observer = create_process_cleanup_observer()
            observer_seen.append(observer is not None)
            if observer is not None:
                observer(CONFIRMED)
            refresh_started.set()
            release_refresh.wait(timeout=5.0)
            refresh_finished.set()
        return {"version": 2, "root": str(root), "count": calls}

    cache = WorkspaceManifestCache(
        generator=generate,
        clock=lambda: now,
        soft_ttl_seconds=30.0,
        hard_ttl_seconds=300.0,
    )
    cache.read(tmp_path)
    now += 31.0
    monkeypatch.setattr(workspace_manifest, "_CACHE", cache)
    tool = builtin_server._default_tools(  # noqa: SLF001
        workspace_manifest_enabled=True
    )["workspace_manifest_read"]

    try:
        response = _call(tool, tmp_path)
        assert refresh_started.wait(timeout=1.0)
        assert observer_seen == [True]
        assert response["result"]["metadata"]["resource_cleanup"] == {
            "cleanup": "uncertain",
            "process_tree_terminated": False,
            "output_readers_terminated": False,
            "reason": "child_cleanup_pending",
        }
    finally:
        release_refresh.set()
        assert refresh_finished.wait(timeout=1.0)
