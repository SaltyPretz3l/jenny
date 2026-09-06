from __future__ import annotations

import logging
from pathlib import Path
from types import SimpleNamespace

from sidecar.ai.routing.mutation_change_set_lifecycle import MutationChangeSetLifecycle
from sidecar.ai.tools.builtins import filesystem
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_mutation_journal_contract import workspace_identity
from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore
from sidecar.protocol import (
    API_VERSION,
    WORKSPACE_ABANDON_RESTORE_METHOD,
    WORKSPACE_ACKNOWLEDGE_RECOVERY_REVIEW_METHOD,
    WORKSPACE_LIST_CHANGE_SETS_METHOD,
    WORKSPACE_PREFLIGHT_UNDO_METHOD,
    WORKSPACE_RESTORE_TRASH_ENTRY_METHOD,
    WORKSPACE_UNDO_CHANGE_SET_METHOD,
)
from sidecar.runtime.server_auxiliary_workers import AUXILIARY_FAMILY_BY_METHOD
from sidecar.runtime.workspace_recovery_rpc import process_workspace_recovery_method

CHANGE_SET_ID = "01990f9a-8c51-7ad2-a8be-41190e0e2599"
UNKNOWN_ID = "01990f9a-8c51-7ad2-a8be-41190e0e2600"
LOGGER = logging.getLogger(__name__)


def _runtime(tmp_path: Path) -> tuple[Path, SimpleNamespace]:
    root = tmp_path / "workspace"
    state_root = tmp_path / "state"
    root.mkdir()
    store = WorkspaceMutationJournalStore(state_root / "workspace-recovery")
    lifecycle = MutationChangeSetLifecycle(store, root)
    guard = WorkspaceGuard(str(root), mutation_journal=lifecycle)
    result = filesystem.write_file_tool(
        {
            "path": "created.txt",
            "content": "created\n",
            "_jenny_session_id": "session-rpc",
            "_jenny_turn_id": "turn-rpc",
            "_jenny_tool_call_id": "write",
            "_jenny_change_set_id": CHANGE_SET_ID,
        },
        guard,
    )
    assert result.success
    assert lifecycle.finalize(CHANGE_SET_ID).ok
    config = SimpleNamespace(
        tools_workspace_root=str(root),
        electron_state_root=str(state_root),
    )
    return root, SimpleNamespace(stack=SimpleNamespace(config=config))


def _call(
    method: str,
    params: dict[str, object],
    container: SimpleNamespace,
    message_id: int = 7,
):
    outcome = process_workspace_recovery_method(
        method,
        message_id,
        {"accept_version": API_VERSION, **params},
        True,
        container,
        LOGGER,
    )
    assert outcome is not None
    assert outcome.notifications == []
    return outcome.response


def test_rpc_round_trips_list_preflight_decisions_and_undo(tmp_path: Path) -> None:
    root, container = _runtime(tmp_path)

    listed = _call(WORKSPACE_LIST_CHANGE_SETS_METHOD, {}, container)
    assert listed["id"] == 7
    assert listed["result"]["change_sets"][0]["change_set_id"] == CHANGE_SET_ID

    review = _call(
        WORKSPACE_PREFLIGHT_UNDO_METHOD,
        {"change_set_id": CHANGE_SET_ID},
        container,
    )
    assert review["result"]["status"] == "preflight"
    assert review["result"]["conflicts"] == []

    undone = _call(
        WORKSPACE_UNDO_CHANGE_SET_METHOD,
        {"change_set_id": CHANGE_SET_ID, "decisions": []},
        container,
    )
    assert undone["result"]["change_set_id"] == CHANGE_SET_ID
    assert undone["result"]["status"] == "committed"
    assert not (root / "created.txt").exists()


def test_unknown_change_set_id_returns_structured_error(tmp_path: Path) -> None:
    _root, container = _runtime(tmp_path)

    response = _call(
        WORKSPACE_PREFLIGHT_UNDO_METHOD,
        {"change_set_id": UNKNOWN_ID},
        container,
    )

    assert response["error"]["code"] == -32004
    assert response["error"]["data"]["error_code"] == "CMP-TOOL-0008"
    assert response["error"]["data"]["reason"] == "journal_not_found"


def test_abandon_interrupted_restore_rolls_back_and_releases_retention(
    tmp_path: Path,
) -> None:
    root, container = _runtime(tmp_path)
    identity = workspace_identity(root)
    state_root = Path(container.stack.config.electron_state_root)
    store = WorkspaceMutationJournalStore(state_root / "workspace-recovery")
    loaded = store.load(identity.workspace_id, CHANGE_SET_ID)
    assert loaded.ok and loaded.record is not None
    record = loaded.record
    record["state"] = "interrupted"
    record["restore"]["status"] = "interrupted"
    assert store.write_transition(record, workspace_root=root).ok

    response = _call(
        WORKSPACE_ABANDON_RESTORE_METHOD,
        {"workspace_id": identity.workspace_id, "change_set_id": CHANGE_SET_ID},
        container,
    )

    assert response["result"]["state"] == "rolled_back"
    assert response["result"]["restore_status"] == "abandoned"
    persisted = store.load(identity.workspace_id, CHANGE_SET_ID)
    assert persisted.ok and persisted.record is not None
    assert persisted.record["retention"]["protected"] is False


def test_abandon_committed_restore_returns_not_interrupted(tmp_path: Path) -> None:
    root, container = _runtime(tmp_path)

    response = _call(
        WORKSPACE_ABANDON_RESTORE_METHOD,
        {
            "workspace_id": workspace_identity(root).workspace_id,
            "change_set_id": CHANGE_SET_ID,
        },
        container,
    )

    assert response["error"]["data"]["reason"] == "restore_not_interrupted"


def test_rpc_rejects_bad_params_and_unknown_methods(tmp_path: Path) -> None:
    _root, container = _runtime(tmp_path)

    invalid = _call(WORKSPACE_PREFLIGHT_UNDO_METHOD, {}, container)
    unknown = process_workspace_recovery_method(
        "workspace.unknown",
        9,
        {"accept_version": API_VERSION},
        True,
        container,
        LOGGER,
    )

    assert invalid["error"]["data"]["reason"] == "invalid_params"
    assert unknown is None


def test_all_recovery_methods_run_on_one_capped_auxiliary_family() -> None:
    methods = {
        WORKSPACE_LIST_CHANGE_SETS_METHOD,
        WORKSPACE_PREFLIGHT_UNDO_METHOD,
        WORKSPACE_UNDO_CHANGE_SET_METHOD,
        WORKSPACE_RESTORE_TRASH_ENTRY_METHOD,
        WORKSPACE_ACKNOWLEDGE_RECOVERY_REVIEW_METHOD,
        WORKSPACE_ABANDON_RESTORE_METHOD,
    }

    assert {AUXILIARY_FAMILY_BY_METHOD[method] for method in methods} == {
        "workspace_recovery"
    }
