from __future__ import annotations

import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.mcp.builtin_server import _default_tools, _handle_tools_call
from sidecar.ai.routing.mutation_change_set_lifecycle import (
    MutationChangeSetLifecycle,
    bind_run_context,
    finish_run_change_set,
    inject_tool_attribution,
)
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_execution_results import tool_result_message
from sidecar.ai.tools import workspace_mutation_live_owner as live
from sidecar.ai.tools.builtins.filesystem import write_file_tool
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_mutation_journal_contract import workspace_identity
from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore
from sidecar.ai.tools.workspace_restore import preflight_undo, undo_change_set

CHANGE_SET = "01990f9a-8c51-7ad2-a8be-41190e0e1f21"


def _fixture(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    store = WorkspaceMutationJournalStore(tmp_path / "state" / "workspace-recovery")
    lifecycle = MutationChangeSetLifecycle(store, workspace)
    identity = workspace_identity(workspace)
    path = store.live_owner_path(identity.workspace_id, CHANGE_SET)
    return workspace, store, lifecycle, path


def _arguments():
    return {
        "_jenny_session_id": "session",
        "_jenny_turn_id": "turn",
        "_jenny_change_set_id": CHANGE_SET,
        "_jenny_tool_call_id": "first",
    }


def test_lock_is_inert_for_same_turn_and_blocks_recovery(tmp_path: Path):
    workspace, store, lifecycle, path = _fixture(tmp_path)
    live.acquire_live_owner(path, session_id="session", turn_id="turn")
    try:
        live.acquire_live_owner(path, session_id="session", turn_id="turn")
        with pytest.raises(ValueError, match="another live turn"):
            live.acquire_live_owner(path, session_id="session", turn_id="other")
        guard = WorkspaceGuard(str(workspace), mutation_journal=lifecycle)
        write_file_tool(
            {**_arguments(), "file_path": "effect.txt", "file_content": "effect"}, guard
        )
        journal = store.journal_path(workspace_identity(workspace).workspace_id, CHANGE_SET)
        before = journal.read_bytes()
        assert store.reconcile_workspace(workspace) == ()
        assert journal.read_bytes() == before
        with live.recovery_ownership(path) as abandoned:
            assert not abandoned
        # Thread-local filelock contexts must not turn request-thread settlement into a leak.
        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(
                live.release_live_owner, path, session_id="session", turn_id="turn"
            ).result()
        with live.recovery_ownership(path) as abandoned:
            assert abandoned
    finally:
        live.release_live_owner(path, session_id="session", turn_id="turn")


def test_uncertain_ownership_skips_recovery_without_touching_journal(tmp_path: Path, monkeypatch):
    workspace, store, lifecycle, _path = _fixture(tmp_path)
    guard = WorkspaceGuard(str(workspace), mutation_journal=lifecycle)
    write_file_tool({**_arguments(), "file_path": "effect.txt", "file_content": "effect"}, guard)
    journal = store.journal_path(workspace_identity(workspace).workspace_id, CHANGE_SET)
    before = journal.read_bytes()

    def uncertain(_path):
        raise PermissionError("uncertain lock access")

    monkeypatch.setattr(live, "_new_lock", uncertain)
    assert store.reconcile_workspace(workspace) == ()
    assert journal.read_bytes() == before


def test_registry_capacity_fails_closed_without_publishing(tmp_path: Path, monkeypatch):
    _workspace, _store, _lifecycle, path = _fixture(tmp_path)
    monkeypatch.setattr(live, "MAX_LIVE_OWNERS", len(live._OWNERS))
    with pytest.raises(ValueError, match="capacity"):
        live.acquire_live_owner(path, session_id="session", turn_id="turn")
    assert not path.exists()


@pytest.mark.parametrize("cancelled", [False, True])
def test_logical_turn_settlement_releases_lock_after_terminal_durability(tmp_path: Path, cancelled):
    workspace, store, lifecycle, _path = _fixture(tmp_path)
    run = SimpleNamespace(
        session_id="session",
        request_id="turn",
        outcomes=[],
        kernel=SimpleNamespace(
            _config=SimpleNamespace(
                electron_state_root=str(tmp_path / "state"), tools_workspace_root=str(workspace)
            )
        ),
        runtime=SimpleNamespace(cancel_handle=SimpleNamespace(cancelled=cancelled)),
    )
    bind_run_context(run)
    attribution = inject_tool_attribution(
        tool_name="write_file", tool_call_id="first", session_id="session"
    )
    change_set = attribution["_jenny_change_set_id"]
    path = store.live_owner_path(workspace_identity(workspace).workspace_id, change_set)
    guard = WorkspaceGuard(str(workspace), mutation_journal=lifecycle)
    try:
        assert path.exists()
        write_file_tool(
            {
                **attribution,
                "_jenny_session_id": "session",
                "file_path": "effect.txt",
                "file_content": "effect",
            },
            guard,
        )
        finish_run_change_set(run, approval_paused=True, reason="approval_required")
        with live.recovery_ownership(path) as abandoned:
            assert not abandoned
        bind_run_context(run)
        finish_run_change_set(
            run, approval_paused=False, reason="turn_cancelled" if cancelled else "done"
        )
        with live.recovery_ownership(path) as abandoned:
            assert abandoned
        record = store.load(workspace_identity(workspace).workspace_id, change_set).record
        assert record["state"] == ("interrupted" if cancelled else "committed")
        assert record["termination_reason"] == ("turn_cancelled" if cancelled else "turn_completed")
        assert store.reconcile_workspace(workspace) == ()
    finally:
        live.release_live_owner(path, session_id="session", turn_id="turn")


@pytest.mark.parametrize("apply_effect", [False, True])
def test_real_owner_process_death_permits_crash_recovery_and_undo(tmp_path: Path, apply_effect):
    workspace, store, _lifecycle, path = _fixture(tmp_path)
    ready = tmp_path / "ready"
    code = """
import sys, time
from pathlib import Path
from sidecar.ai.tools.workspace_mutation_live_owner import acquire_live_owner
from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore
from sidecar.ai.tools.workspace_mutation_journal_contract import workspace_identity
from sidecar.ai.routing.mutation_change_set_lifecycle import MutationChangeSetLifecycle
root, change_set, apply = Path(sys.argv[1]), sys.argv[2], sys.argv[3] == 'True'
workspace = root / 'workspace'
store = WorkspaceMutationJournalStore(root / 'state' / 'workspace-recovery')
identity = workspace_identity(workspace)
acquire_live_owner(store.live_owner_path(identity.workspace_id, change_set), session_id='session', turn_id='turn')
lifecycle = MutationChangeSetLifecycle(store, workspace)
lifecycle.prepare_file_change({'_jenny_session_id':'session', '_jenny_turn_id':'turn',
    '_jenny_tool_call_id':'first', '_jenny_change_set_id':change_set}, tool_name='write_file',
    target=workspace/'effect.txt', relative_path='effect.txt', new_bytes=b'effect', checkpoint=None)
if apply: (workspace/'effect.txt').write_bytes(b'effect')
(root/'ready').write_text('ready')
time.sleep(60)
"""
    child = subprocess.Popen(
        [sys.executable, "-c", code, str(tmp_path), CHANGE_SET, str(apply_effect)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    try:
        deadline = time.monotonic() + 10
        while not ready.exists() and child.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        assert ready.exists(), (
            child.stderr.read() if child.poll() is not None else "owner did not become ready"
        )
        journal = store.journal_path(workspace_identity(workspace).workspace_id, CHANGE_SET)
        before = journal.read_bytes()
        assert store.reconcile_workspace(workspace) == ()
        assert journal.read_bytes() == before
        child.kill()
        child.wait(timeout=10)
        recovered = store.reconcile_workspace(workspace)[0]
        assert recovered.ok
        assert recovered.record["state"] == "interrupted"
        assert recovered.record["termination_reason"] == "process_recovered"
        assert recovered.record["completed_sequences"] == ([1] if apply_effect else [])
        assert recovered.record["retention"]["protected"]
        assert preflight_undo(store, workspace, CHANGE_SET)["conflicts"] == []
        assert undo_change_set(store, workspace, CHANGE_SET)["status"] == "committed"
        assert not (workspace / "effect.txt").exists()
        with live.recovery_ownership(path) as abandoned:
            assert abandoned
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=10)
        child.stderr.close()


@pytest.mark.parametrize("tool_name", ["write_file", "edit_file", "delete_file", "move_file"])
def test_terminal_journal_rejection_is_no_effects_and_new_turn_remediation_reaches_model(
    tmp_path: Path,
    tool_name: str,
):
    workspace, store, lifecycle, _path = _fixture(tmp_path)
    guard = WorkspaceGuard(str(workspace), mutation_journal=lifecycle)
    first = write_file_tool(
        {**_arguments(), "file_path": "effect.txt", "file_content": "effect"}, guard
    )
    assert lifecycle.finalize(CHANGE_SET).ok
    before = (workspace / "effect.txt").read_bytes()
    inputs = {
        "write_file": {
            "file_path": "effect.txt",
            "file_content": "rejected",
            "expected_read_snapshot": first.metadata["written_snapshot"],
        },
        "edit_file": {"file_path": "effect.txt", "old_string": "effect", "new_string": "rejected"},
        "delete_file": {"path": "effect.txt"},
        "move_file": {"source": "effect.txt", "destination": "moved.txt"},
    }
    response = _handle_tools_call(
        "terminal",
        _default_tools(),
        guard,
        {
            "name": tool_name,
            "arguments": {**_arguments(), "_jenny_tool_call_id": "terminal", **inputs[tool_name]},
        },
    )
    if "error" in response:
        failure = response["error"]["data"]
        output = response["error"]["message"]
        code = failure["code"]
    else:
        failure = response["result"]["metadata"]
        output = response["result"]["content"][0]["text"]
        code = response["result"]["error_code"]
        assert response["result"]["success"] is False
    assert failure["journal_state"] == "mutation_change_set_terminal"
    assert failure["effects"] == "none"
    assert failure["retryable"] is False
    assert (workspace / "effect.txt").read_bytes() == before
    assert (
        store.load(workspace_identity(workspace).workspace_id, CHANGE_SET).record["operation_count"]
        == 1
    )
    outcome = ToolExecutionOutcome(
        tool_name=tool_name,
        output=output,
        success=False,
        metadata=failure,
        error_code=code,
    )
    message = tool_result_message(
        ToolCallRequest(tool_name, {}, "terminal"),
        outcome,
        SimpleNamespace(tool_result_envelope_enabled=True),
    )
    assert "start a new turn" in message["content"]
    assert "Refresh context" not in message["content"]


def test_live_lock_files_do_not_consume_journal_scan_capacity(tmp_path, monkeypatch):
    from sidecar.ai.tools import workspace_mutation_journal_store as stores
    workspace, store, lifecycle, path = _fixture(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    for index in range(4):
        (path.parent / f"000{index}.live.lock").touch()
    write_file_tool({**_arguments(), "file_path": "effect.txt", "file_content": "effect"},
                    WorkspaceGuard(str(workspace), mutation_journal=lifecycle))
    monkeypatch.setattr(stores, "MAX_SCAN_CHANGE_SETS", 1)
    assert len(store._scan_workspace(workspace_identity(workspace).workspace_id)) == 1


def test_busy_recovery_logs_only_reason_class(tmp_path, caplog):
    _workspace, _store, _lifecycle, path = _fixture(tmp_path)
    live.acquire_live_owner(path, session_id="session", turn_id="turn")
    try:
        with caplog.at_level("DEBUG", logger=live.__name__):
            with live.recovery_ownership(path) as abandoned:
                assert not abandoned
        record = caplog.records[-1]
        assert record.reason == "Timeout"
        assert str(path) not in record.getMessage()
    finally:
        live.release_live_owner(path, session_id="session", turn_id="turn")
