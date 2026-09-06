"""Red-first: create_artifact is THE fail-closed site (W5 review, spec §3.5).

Every other side-effecting builtin degrades fail-open (execute, claim nothing)
because re-running write_file with the same content is idempotent-by-content.
create_artifact picks a fresh unique filename per run, so an uncovered replay
DUPLICATES: with no key, no ledger, or a failed pending write it must refuse
to execute — zero files — instead of running uncovered.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from sidecar.ai.mcp import builtin_server
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime import operation_ledger as ledger_module
from sidecar.runtime.operation_ledger import LEDGER_OPERATIONS_DIR

ARTIFACT_KEY = "idem_a1a1a1a1a1a1a1a1a1a1a1a1"


@pytest.fixture()
def workspace_root(tmp_path: Path) -> Path:
    root = tmp_path / "workspace"
    root.mkdir()
    return root


def _artifact_files(workspace_root: Path) -> list[str]:
    artifact_dir = workspace_root / ".jenny" / "artifacts" / "session-fc"
    if not artifact_dir.exists():
        return []
    return sorted(p.name for p in artifact_dir.iterdir())


def _call_create_artifact(workspace_root: Path, arguments: dict) -> dict:
    tools = builtin_server._default_tools()  # noqa: SLF001
    return builtin_server._handle_tools_call(  # noqa: SLF001
        "fail-closed-call",
        tools,
        WorkspaceGuard(str(workspace_root)),
        {"name": "create_artifact", "arguments": arguments},
    )


def _arguments(*, key: str | None) -> dict:
    arguments = {
        "_jenny_session_id": "session-fc",
        "artifact_kind": "document",
        "title": "Fail Closed",
        "content": "# body",
        "language": "markdown",
    }
    if key is not None:
        arguments["_jenny_idempotency_key"] = key
    return arguments


def test_missing_key_refuses_and_creates_nothing(tmp_path: Path, workspace_root: Path) -> None:
    builtin_server.configure_operation_ledger(tmp_path / "ledger-root")
    try:
        response = _call_create_artifact(workspace_root, _arguments(key=None))
    finally:
        builtin_server.configure_operation_ledger(None)
    assert "error" in response
    assert _artifact_files(workspace_root) == []


def test_unavailable_ledger_root_refuses_and_creates_nothing(
    tmp_path: Path, workspace_root: Path
) -> None:
    blocker = tmp_path / "blocked"
    blocker.write_text("a file where the ledger root must go", encoding="utf-8")
    builtin_server.configure_operation_ledger(blocker / "ledger-root")
    try:
        response = _call_create_artifact(workspace_root, _arguments(key=ARTIFACT_KEY))
    finally:
        builtin_server.configure_operation_ledger(None)
    assert "error" in response
    assert _artifact_files(workspace_root) == []


def test_lock_contention_refuses_and_creates_nothing(
    tmp_path: Path, workspace_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "ledger-root"
    builtin_server.configure_operation_ledger(root)
    monkeypatch.setattr(ledger_module, "_LOCK_TIMEOUT_SECONDS", 0.2)
    try:
        # A live (fresh-mtime) foreign lock holds the ledger for the whole call.
        operations = root / LEDGER_OPERATIONS_DIR
        operations.mkdir(parents=True)
        lock_path = operations / ".lock"
        fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
        try:
            response = _call_create_artifact(workspace_root, _arguments(key=ARTIFACT_KEY))
        finally:
            os.close(fd)
            lock_path.unlink()
    finally:
        builtin_server.configure_operation_ledger(None)
    assert "error" in response
    assert _artifact_files(workspace_root) == []


def test_write_file_without_key_still_executes_fail_open(
    tmp_path: Path, workspace_root: Path
) -> None:
    # The refusal is create_artifact-specific: content-addressed tools keep the
    # spec'd fail-open degradation.
    builtin_server.configure_operation_ledger(tmp_path / "ledger-root")
    try:
        tools = builtin_server._default_tools()  # noqa: SLF001
        response = builtin_server._handle_tools_call(  # noqa: SLF001
            "fail-open-call",
            tools,
            WorkspaceGuard(str(workspace_root)),
            {
                "name": "write_file",
                "arguments": {"path": "out.txt", "content": "x", "create_dirs": True},
            },
        )
    finally:
        builtin_server.configure_operation_ledger(None)
    assert "result" in response
    assert (workspace_root / "out.txt").read_text(encoding="utf-8") == "x"
