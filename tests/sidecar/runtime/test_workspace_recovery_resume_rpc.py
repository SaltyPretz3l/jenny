"""A stopped Undo reaches the RPC edge as a typed, resumable failure (A19-F3/A16-F3)."""

from __future__ import annotations

import logging
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.routing.mutation_change_set_lifecycle import MutationChangeSetLifecycle
from sidecar.ai.tools import workspace_restore as restore_module
from sidecar.ai.tools.builtins import filesystem
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore
from sidecar.protocol import (
    API_VERSION,
    WORKSPACE_PREFLIGHT_UNDO_METHOD,
    WORKSPACE_UNDO_CHANGE_SET_METHOD,
)
from sidecar.runtime.workspace_recovery_rpc import process_workspace_recovery_method

CHANGE_SET_ID = "01990f9a-8c51-7ad2-a8be-41190e0e2599"
LOGGER = logging.getLogger(__name__)


def _runtime(tmp_path: Path) -> tuple[Path, SimpleNamespace]:
    root = tmp_path / "workspace"
    state_root = tmp_path / "state"
    root.mkdir()
    store = WorkspaceMutationJournalStore(state_root / "workspace-recovery")
    lifecycle = MutationChangeSetLifecycle(store, root)
    guard = WorkspaceGuard(str(root), mutation_journal=lifecycle)
    for name in ("first.txt", "second.txt"):
        assert filesystem.write_file_tool(
            {
                "path": name,
                "content": f"{name}\n",
                "_jenny_session_id": "session-rpc",
                "_jenny_turn_id": "turn-rpc",
                "_jenny_tool_call_id": name,
                "_jenny_change_set_id": CHANGE_SET_ID,
            },
            guard,
        ).success
    assert lifecycle.finalize(CHANGE_SET_ID).ok
    config = SimpleNamespace(tools_workspace_root=str(root), electron_state_root=str(state_root))
    return root, SimpleNamespace(stack=SimpleNamespace(config=config))


def _call(method: str, params: dict[str, object], container: SimpleNamespace) -> dict:
    outcome = process_workspace_recovery_method(
        method, 7, {"accept_version": API_VERSION, **params}, True, container, LOGGER
    )
    assert outcome is not None
    return outcome.response


def test_io_failure_mid_undo_returns_a_resumable_receipt_then_resumes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, container = _runtime(tmp_path)
    original = restore_module._execute_step
    ran: list[str] = []

    def failing(*args):  # type: ignore[no-untyped-def]
        if ran:
            raise OSError(28, "No space left on device")
        ran.append(args[2]["step_id"])
        return original(*args)

    with monkeypatch.context() as scoped:
        scoped.setattr(restore_module, "_execute_step", failing)
        stopped = _call(WORKSPACE_UNDO_CHANGE_SET_METHOD, {"change_set_id": CHANGE_SET_ID}, container)

    data = stopped["error"]["data"]
    assert data["reason"] == "restore_io_failed"
    assert data["status"] == "in_progress"
    assert data["completed_count"] == 1

    review = _call(WORKSPACE_PREFLIGHT_UNDO_METHOD, {"change_set_id": CHANGE_SET_ID}, container)
    assert review["result"]["status"] == "preflight"
    assert review["result"]["resume"]["completed_inverse_step_ids"] == ran
    assert [row["inverse_step_id"] for row in review["result"]["resume"]["receipt"]["restored"]] == ran
    assert len(review["result"]["inverse_plan"]) == 1

    resumed = _call(WORKSPACE_UNDO_CHANGE_SET_METHOD, {"change_set_id": CHANGE_SET_ID, "decisions": {}}, container)
    assert resumed["result"]["status"] == "committed"
    assert not (root / "first.txt").exists()
    assert not (root / "second.txt").exists()
