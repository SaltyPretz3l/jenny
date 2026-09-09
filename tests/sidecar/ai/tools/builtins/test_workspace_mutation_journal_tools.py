from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.routing.mutation_change_set_lifecycle import MutationChangeSetLifecycle
from sidecar.ai.tools.builtins import delete_file, edit_file, filesystem, move_file
from sidecar.ai.tools.builtins.file_history import create_checkpoint
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_mutation_journal_contract import workspace_identity
from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore

CHANGE_SET_ID = "01990f9a-8c51-7ad2-a8be-41190e0e1f21"


def _journaled_guard(tmp_path: Path) -> tuple[WorkspaceGuard, WorkspaceMutationJournalStore]:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    store = WorkspaceMutationJournalStore(tmp_path / "recovery")
    lifecycle = MutationChangeSetLifecycle(store, workspace)
    return WorkspaceGuard(str(workspace), mutation_journal=lifecycle), store


def _args(tool_call_id: str, **values: object) -> dict[str, object]:
    return {
        **values,
        "_jenny_session_id": "session-journal-tools",
        "_jenny_turn_id": "turn-journal-tools",
        "_jenny_tool_call_id": tool_call_id,
        "_jenny_change_set_id": CHANGE_SET_ID,
    }


def _record(guard: WorkspaceGuard, store: WorkspaceMutationJournalStore) -> dict[str, object]:
    identity = workspace_identity(guard.require_root())
    loaded = store.load(identity.workspace_id, CHANGE_SET_ID)
    assert loaded.ok is True
    assert loaded.record is not None
    return loaded.record


def test_all_four_typed_tools_share_one_real_change_set(tmp_path: Path) -> None:
    guard, store = _journaled_guard(tmp_path)
    root = guard.require_root()

    write_result = filesystem.write_file_tool(
        _args("call-write", path="notes.txt", content="alpha\n"), guard
    )
    edit_result = edit_file.edit_file_tool(
        _args(
            "call-edit",
            file_path="notes.txt",
            old_string="alpha",
            new_string="beta",
        ),
        guard,
    )
    (root / "move-me.txt").write_text("move\n", encoding="utf-8")
    move_result = move_file.move_file_tool(
        _args("call-move", source="move-me.txt", destination="archive/moved.txt"),
        guard,
    )
    (root / "delete-me.txt").write_text("delete\n", encoding="utf-8")
    delete_result = delete_file.delete_file_tool(_args("call-delete", path="delete-me.txt"), guard)

    assert all(result.success for result in (write_result, edit_result, move_result, delete_result))
    assert {
        result.metadata["workspace_change_set"]["change_set_id"]
        for result in (write_result, edit_result, move_result, delete_result)
    } == {CHANGE_SET_ID}
    record = _record(guard, store)
    assert record["operation_count"] == 4
    assert [item["kind"] for item in record["operations"]] == [
        "create",
        "modify",
        "move",
        "delete",
    ]
    assert record["completed_sequences"] == [1, 2, 3, 4]
    assert record["tool_call_ids"] == [
        "call-write",
        "call-edit",
        "call-move",
        "call-delete",
    ]


def test_modify_delete_and_move_overwrite_reference_existing_recovery_objects(
    tmp_path: Path,
) -> None:
    guard, store = _journaled_guard(tmp_path)
    root = guard.require_root()
    (root / "edit.txt").write_text("before edit\n", encoding="utf-8")
    (root / "delete.txt").write_text("before delete\n", encoding="utf-8")
    (root / "source.txt").write_text("new destination\n", encoding="utf-8")
    (root / "destination.txt").write_text("old destination\n", encoding="utf-8")

    assert edit_file.edit_file_tool(
        _args(
            "call-edit",
            file_path="edit.txt",
            old_string="before edit",
            new_string="after edit",
        ),
        guard,
    ).success
    assert delete_file.delete_file_tool(_args("call-delete", path="delete.txt"), guard).success
    assert move_file.move_file_tool(
        _args(
            "call-move",
            source="source.txt",
            destination="destination.txt",
            overwrite=True,
        ),
        guard,
    ).success

    record = _record(guard, store)
    edit_recovery = record["operations"][0]["recovery_objects"][0]
    delete_recovery = record["operations"][1]["recovery_objects"][0]
    move_recovery = record["operations"][2]["recovery_objects"][0]
    assert edit_recovery["store_kind"] == "backup"
    assert delete_recovery["store_kind"] == "trash"
    assert move_recovery["role"] == "overwritten_destination"
    for recovery in (edit_recovery, delete_recovery, move_recovery):
        assert (root / recovery["workspace_relative_path"]).exists()
        assert recovery["object_id"] in record["retention"]["referenced_object_ids"]


def test_move_batch_is_fully_planned_before_first_parent_creation(tmp_path: Path) -> None:
    guard, store = _journaled_guard(tmp_path)
    root = guard.require_root()
    (root / "one.txt").write_text("one", encoding="utf-8")
    (root / "two.txt").write_text("two", encoding="utf-8")
    lifecycle = guard.mutation_journal
    original_begin = lifecycle.begin_sequence
    observed: list[tuple[int, int, bool]] = []

    def _observe(prepared: object, sequence: int) -> dict[str, object]:
        record = _record(guard, store)
        observed.append((record["operation_count"], sequence, (root / "nested").exists()))
        return original_begin(prepared, sequence)

    lifecycle.begin_sequence = _observe
    result = move_file.move_file_tool(
        _args(
            "call-batch",
            moves=[
                {"source": "one.txt", "destination": "nested/one.txt"},
                {"source": "two.txt", "destination": "nested/two.txt"},
            ],
        ),
        guard,
    )

    assert result.success is True
    assert observed[0] == (2, 1, False)
    assert observed[1][0:2] == (2, 2)
    assert _record(guard, store)["completed_sequences"] == [1, 2]


def test_typed_tool_failure_before_mutation_is_durably_skipped(tmp_path: Path) -> None:
    guard, store = _journaled_guard(tmp_path)
    root = guard.require_root()
    lifecycle = guard.mutation_journal
    prepared = lifecycle.prepare_file_change(
        _args("call-failed"),
        tool_name="write_file",
        target=root / "never.txt",
        relative_path="never.txt",
        new_bytes=b"never",
        checkpoint=None,
    )

    summary = lifecycle.mark_failed_sequence(prepared, prepared.sequences[0])

    assert summary["protected"] is True
    record = _record(guard, store)
    assert record["operations"][0]["status"] == "skipped"
    assert record["completed_sequences"] == []
    assert not (root / "never.txt").exists()


def test_edit_flushes_inverse_before_checkpoint_creation(tmp_path: Path) -> None:
    class InjectedCrash(RuntimeError):
        pass

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target = workspace / "edit.txt"
    target.write_text("before\n", encoding="utf-8")

    def _crash() -> None:
        assert target.read_text(encoding="utf-8") == "before\n"
        assert list((workspace / ".jenny" / "backups").glob("*.bak")) == []
        raise InjectedCrash("before-checkpoint")

    store = WorkspaceMutationJournalStore(
        tmp_path / "recovery",
        after_in_progress_flush_before_first_workspace_mutation=_crash,
    )
    lifecycle = MutationChangeSetLifecycle(store, workspace)
    guard = WorkspaceGuard(str(workspace), mutation_journal=lifecycle)

    with pytest.raises(InjectedCrash):
        edit_file.edit_file_tool(
            _args(
                "call-edit-crash",
                file_path="edit.txt",
                old_string="before",
                new_string="after",
            ),
            guard,
        )

    record = _record(guard, store)
    recovery = record["operations"][0]["recovery_objects"][0]
    assert target.read_text(encoding="utf-8") == "before\n"
    assert (workspace / recovery["workspace_relative_path"]).exists() is False


@pytest.mark.parametrize("interrupted", [False, True])
def test_closed_edit_set_rejects_late_dispatch_without_changing_recovery(
    tmp_path: Path, interrupted: bool,
) -> None:
    guard, store = _journaled_guard(tmp_path)
    root = guard.require_root()
    target = root / "edit.txt"
    target.write_bytes(b"alpha")
    assert edit_file.edit_file_tool(
        _args("first", file_path="edit.txt", old_string="alpha", new_string="beta"), guard,
    ).success
    guard.mutation_journal.finalize(CHANGE_SET_ID, interrupted=interrupted)
    record = _record(guard, store)
    journal_path = store.journal_path(workspace_identity(root).workspace_id, CHANGE_SET_ID)
    journal_bytes = journal_path.read_bytes()
    recovery = {
        item["workspace_relative_path"]: (root / item["workspace_relative_path"]).read_bytes()
        for operation in record["operations"] for item in operation["recovery_objects"]
    }
    for call_id in ("late", "retry"):
        result = edit_file.edit_file_tool(
            _args(call_id, file_path="edit.txt", old_string="beta", new_string="gamma"), guard,
        )
        assert not result.success
        assert result.error_code == "CMP-TOOL-0006"
        assert result.metadata["effects"] == "none"
        assert result.metadata["failure_class"] == "conflict"
        assert "already terminal" in result.output
        assert target.read_bytes() == b"beta"
        assert journal_path.read_bytes() == journal_bytes
        assert all((root / path).read_bytes() == data for path, data in recovery.items())


@pytest.mark.parametrize("foreign_key", ["_jenny_session_id", "_jenny_turn_id"])
def test_edit_cannot_append_to_foreign_open_journal(tmp_path: Path, foreign_key: str) -> None:
    guard, store = _journaled_guard(tmp_path)
    target = guard.require_root() / "edit.txt"
    target.write_bytes(b"alpha")
    assert edit_file.edit_file_tool(
        _args("owner", file_path="edit.txt", old_string="alpha", new_string="beta"), guard,
    ).success
    original = _record(guard, store)
    result = edit_file.edit_file_tool({
        **_args("foreign", file_path="edit.txt", old_string="beta", new_string="gamma"),
        foreign_key: "foreign",
    }, guard)
    assert not result.success
    assert result.metadata["effects"] == "none"
    assert result.metadata["failure_class"] == "conflict"
    assert target.read_bytes() == b"beta"
    assert _record(guard, store) == original


@pytest.mark.parametrize("effect", ["unapplied", "applied", "ambiguous"])
def test_cancellation_settles_an_applying_edit_without_losing_evidence(
    tmp_path: Path, effect: str,
) -> None:
    guard, store = _journaled_guard(tmp_path)
    target = guard.require_root() / "edit.txt"
    target.write_bytes(b"alpha")
    journal = guard.mutation_journal
    checkpoint = create_checkpoint(target, guard.require_root())
    prepared = journal.prepare_file_change(
        _args("inflight"), tool_name="edit_file", target=target,
        relative_path="edit.txt", new_bytes=b"beta", checkpoint=checkpoint,
    )
    if effect != "unapplied":
        target.write_bytes(b"beta" if effect == "applied" else b"external")
    result = journal.finalize(prepared.change_set_id, interrupted=True)
    assert result.record["state"] == "interrupted"
    expected_status = {"unapplied": "planned", "applied": "applied", "ambiguous": "unknown"}
    assert result.record["operations"][0]["status"] == expected_status[effect]
    assert result.record["completed_sequences"] == ([1] if effect == "applied" else [])
    before = target.read_bytes()
    with pytest.raises(ToolExecutionFailure) as caught:
        journal.prepare_file_change(
            _args("late"), tool_name="edit_file", target=target,
            relative_path="edit.txt", new_bytes=b"late", checkpoint=checkpoint,
        )
    assert caught.value.retryable is False
    assert caught.value.effects == "none"
    assert target.read_bytes() == before
    assert _record(guard, store) == result.record
