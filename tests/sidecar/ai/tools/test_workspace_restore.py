from __future__ import annotations

import errno
import os
from pathlib import Path

import pytest

from sidecar.ai.routing.mutation_change_set_lifecycle import (
    MutationChangeSetLifecycle,
    _move_operation,
    _new_record,
)
from sidecar.ai.tools import workspace_restore as restore_module
from sidecar.ai.tools import workspace_restore_staging as staging_module
from sidecar.ai.tools.builtins import delete_file, edit_file, filesystem, move_file
from sidecar.ai.tools.builtins.file_history import plan_checkpoint
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_mutation_journal_contract import (
    signature_for_path,
    workspace_identity,
)
from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore
from sidecar.ai.tools.workspace_restore import (
    WorkspaceRestoreError,
    preflight_undo,
    restore_trash_entry,
    undo_change_set,
)

CHANGE_SET_ID = "01990f9a-8c51-7ad2-a8be-41190e0e2525"
OTHER_CHANGE_SET_ID = "01990f9a-8c51-7ad2-a8be-41190e0e2526"


def _setup(tmp_path: Path) -> tuple[Path, WorkspaceGuard, WorkspaceMutationJournalStore, MutationChangeSetLifecycle]:
    root = tmp_path / "workspace"
    root.mkdir()
    store = WorkspaceMutationJournalStore(tmp_path / "recovery")
    lifecycle = MutationChangeSetLifecycle(store, root)
    guard = WorkspaceGuard(str(root), mutation_journal=lifecycle)
    return root, guard, store, lifecycle


def _args(call_id: str, **values: object) -> dict[str, object]:
    return {
        **values,
        "_jenny_session_id": "session-restore",
        "_jenny_turn_id": "turn-restore",
        "_jenny_tool_call_id": call_id,
        "_jenny_change_set_id": CHANGE_SET_ID,
    }


def _commit(lifecycle: MutationChangeSetLifecycle) -> None:
    result = lifecycle.finalize(CHANGE_SET_ID)
    assert result.ok is True
    assert result.record is not None
    assert result.record["state"] == "committed"


def _three_operation_set(tmp_path: Path) -> tuple[Path, WorkspaceMutationJournalStore]:
    root, guard, store, lifecycle = _setup(tmp_path)
    (root / "edited.txt").write_bytes(b"before edit\n")
    (root / "move.txt").write_bytes(b"move bytes\x00\xff")
    assert filesystem.write_file_tool(
        _args("write", path="created.txt", content="created\n"), guard
    ).success
    assert edit_file.edit_file_tool(
        _args(
            "edit",
            file_path="edited.txt",
            old_string="before edit",
            new_string="after edit",
        ),
        guard,
    ).success
    assert move_file.move_file_tool(
        _args("move", source="move.txt", destination="nested/moved.txt"), guard
    ).success
    _commit(lifecycle)
    return root, store


def _edited_set(tmp_path: Path) -> tuple[Path, WorkspaceMutationJournalStore]:
    root, guard, store, lifecycle = _setup(tmp_path)
    (root / "item.txt").write_text("original\n", encoding="utf-8")
    assert edit_file.edit_file_tool(
        _args("edit", file_path="item.txt", old_string="original", new_string="jenny"),
        guard,
    ).success
    _commit(lifecycle)
    return root, store


def _decisions(preflight: dict[str, object], outcome: str) -> list[dict[str, str]]:
    return [
        {"inverse_step_id": conflict["inverse_step_id"], "outcome": outcome}
        for conflict in preflight["conflicts"]
    ]


def test_reverse_order_three_operation_undo_restores_bytes(tmp_path: Path) -> None:
    root, store = _three_operation_set(tmp_path)

    review = preflight_undo(store, root, CHANGE_SET_ID)
    assert review["status"] == "preflight"
    assert review["conflicts"] == []
    receipt = undo_change_set(store, root, CHANGE_SET_ID, [])

    assert receipt["status"] == "committed"
    assert not (root / "created.txt").exists()
    assert (root / "edited.txt").read_bytes() == b"before edit\n"
    assert (root / "move.txt").read_bytes() == b"move bytes\x00\xff"
    assert not (root / "nested").exists()


@pytest.mark.parametrize("outcome", ["skip", "alternate_name", "protect_then_replace"])
def test_all_conflict_outcomes_are_honest(tmp_path: Path, outcome: str) -> None:
    root, store = _edited_set(tmp_path)
    (root / "item.txt").write_text("external occupant\n", encoding="utf-8")
    review = preflight_undo(store, root, CHANGE_SET_ID)
    assert len(review["conflicts"]) == 1
    assert review["conflicts"][0]["allowed_outcomes"] == [
        "skip",
        "alternate_name",
        "protect_then_replace",
    ]

    receipt = undo_change_set(store, root, CHANGE_SET_ID, _decisions(review, outcome))

    if outcome == "skip":
        assert (root / "item.txt").read_text(encoding="utf-8") == "external occupant\n"
        assert len(receipt["skipped"]) == 1
    elif outcome == "alternate_name":
        assert (root / "item.txt").read_text(encoding="utf-8") == "external occupant\n"
        alternate = root / receipt["renamed_to"][0]["restored_relative_path"]
        assert alternate.name == "item.jenny-restored-01990f9a-1.txt"
        assert alternate.read_text(encoding="utf-8") == "original\n"
    else:
        assert (root / "item.txt").read_text(encoding="utf-8") == "original\n"
        protected = root / receipt["protected"][0]["workspace_relative_path"]
        assert protected.read_text(encoding="utf-8") == "external occupant\n"


def test_conflict_refuses_without_explicit_decision(tmp_path: Path) -> None:
    root, store = _edited_set(tmp_path)
    (root / "item.txt").write_text("external\n", encoding="utf-8")
    preflight_undo(store, root, CHANGE_SET_ID)

    with pytest.raises(WorkspaceRestoreError) as raised:
        undo_change_set(store, root, CHANGE_SET_ID, [])

    assert raised.value.reason == "restore_decisions_incomplete"
    assert (root / "item.txt").read_text(encoding="utf-8") == "external\n"


def _move_sequence(
    tmp_path: Path,
    names: list[str],
) -> tuple[Path, WorkspaceMutationJournalStore]:
    root, _guard, store, _lifecycle = _setup(tmp_path)
    expected = {name: f"bytes-{name}\n".encode() for name in names}
    for name, content in expected.items():
        (root / name).write_bytes(content)
    signatures = {name: signature_for_path(root / name).signature for name in names}
    identity = workspace_identity(root)
    record = _new_record(
        identity.as_dict(),
        CHANGE_SET_ID,
        "session-restore",
        "turn-restore",
        "cycle",
        observed_at=store.now_provider(),
    )
    operations = []
    recoveries = []
    backup_root = root / ".jenny" / "backups"
    backup_root.mkdir(parents=True)
    for index, source in enumerate(names, start=1):
        destination = names[index % len(names)]
        backup_name = f"cycle-{index}.bin"
        (backup_root / backup_name).write_bytes(expected[destination])
        recovery = {
            "object_id": f"backup:{backup_name}",
            "store_kind": "backup",
            "workspace_relative_path": f".jenny/backups/{backup_name}",
            "role": "overwritten_destination",
            "signature": signatures[destination].as_dict(),
        }
        recoveries.append(recovery)
        operation = _move_operation(
            source,
            destination,
            signatures[source],
            signatures[destination],
            root / destination,
            root,
            recovery,
        )
        operation["inverse_steps"] = operation["inverse_steps"][:1]
        operation["sequence"] = index
        operation["tool_call_id"] = "cycle"
        operation["status"] = "applied"
        operation["inverse_steps"][0]["step_id"] = f"{index}.1"
        operations.append(operation)
    record["operations"] = operations
    record["operation_count"] = len(operations)
    record["completed_sequences"] = list(range(1, len(operations) + 1))
    record["retention"]["referenced_object_ids"] = sorted(
        recovery["object_id"] for recovery in recoveries
    )
    record["retention"]["reserved_entries"] = len(recoveries)
    record["retention"]["reserved_bytes"] = sum(
        recovery["signature"]["byte_size"] for recovery in recoveries
    )
    record["state"] = "committed"
    record["termination_reason"] = "turn_completed"
    for index, destination in enumerate(names):
        source = names[index - 1]
        (root / destination).write_bytes(expected[source])
    assert store.write_transition(record, workspace_root=root).ok
    return root, store


@pytest.mark.parametrize("names", [["a.txt", "b.txt"], ["a.txt", "b.txt", "c.txt"]])
def test_swap_and_three_cycle_use_persisted_staging(tmp_path: Path, names: list[str]) -> None:
    root, store = _move_sequence(tmp_path, names)
    review = preflight_undo(store, root, CHANGE_SET_ID)

    assert len(review["staging_entries"]) == len(names)
    assert all(
        Path(item["stage_relative_path"]).name.startswith(".jenny-restore-01990f9a-")
        for item in review["staging_entries"]
    )
    undo_change_set(store, root, CHANGE_SET_ID, [])

    assert {(name, (root / name).read_bytes()) for name in names} == {
        (name, f"bytes-{name}\n".encode()) for name in names
    }


def test_cycle_undo_falls_back_to_rename_when_hard_links_are_unsupported(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root, store = _move_sequence(tmp_path, ["a.txt", "b.txt"])
    preflight_undo(store, root, CHANGE_SET_ID)

    def _unsupported_link(_source: object, _stage: object) -> None:
        raise OSError(errno.EPERM, "hard links unsupported")

    monkeypatch.setattr(staging_module.os, "link", _unsupported_link)
    undo_change_set(store, root, CHANGE_SET_ID, [])

    assert (root / "a.txt").read_bytes() == b"bytes-a.txt\n"
    assert (root / "b.txt").read_bytes() == b"bytes-b.txt\n"


def test_resume_after_all_move_sources_are_staged_completes_cycle(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root, store = _move_sequence(tmp_path, ["a.txt", "b.txt"])
    review = preflight_undo(store, root, CHANGE_SET_ID)

    with monkeypatch.context() as scoped:
        scoped.setattr(
            restore_module,
            "_execute_missing_steps",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("after staging")),
        )
        with pytest.raises(RuntimeError, match="after staging"):
            undo_change_set(store, root, CHANGE_SET_ID, [])

    assert all((root / item["stage_relative_path"]).exists() for item in review["staging_entries"])
    undo_change_set(store, root, CHANGE_SET_ID, [])

    assert (root / "a.txt").read_bytes() == b"bytes-a.txt\n"
    assert (root / "b.txt").read_bytes() == b"bytes-b.txt\n"


def test_resume_rejects_changed_occupant_after_protection(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root, store = _edited_set(tmp_path)
    target = root / "item.txt"
    target.write_text("occupant\n", encoding="utf-8")
    review = preflight_undo(store, root, CHANGE_SET_ID)

    with monkeypatch.context() as scoped:
        scoped.setattr(
            restore_module,
            "_execute_step",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("after protect")),
        )
        with pytest.raises(RuntimeError, match="after protect"):
            undo_change_set(
                store,
                root,
                CHANGE_SET_ID,
                _decisions(review, "protect_then_replace"),
            )

    target.write_text("newer occupant\n", encoding="utf-8")
    with pytest.raises(WorkspaceRestoreError) as raised:
        undo_change_set(store, root, CHANGE_SET_ID)

    assert raised.value.reason == "restore_state_ambiguous"
    assert target.read_text(encoding="utf-8") == "newer occupant\n"


def test_resume_rejects_changed_protective_backup_before_replacing_occupant(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root, store = _edited_set(tmp_path)
    target = root / "item.txt"
    target.write_bytes(b"occupant\n")
    review = preflight_undo(store, root, CHANGE_SET_ID)
    with monkeypatch.context() as scoped:
        scoped.setattr(
            restore_module,
            "_execute_step",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("after protect")),
        )
        with pytest.raises(RuntimeError, match="after protect"):
            undo_change_set(
                store,
                root,
                CHANGE_SET_ID,
                _decisions(review, "protect_then_replace"),
            )
    record = store.load(workspace_identity(root).workspace_id, CHANGE_SET_ID).record
    assert record is not None
    protected = record["restore"]["protected_occupants"][0]
    (root / protected["workspace_relative_path"]).write_bytes(b"truncated")

    with pytest.raises(WorkspaceRestoreError) as raised:
        undo_change_set(store, root, CHANGE_SET_ID)

    assert raised.value.reason == "recovery_object_changed"
    assert raised.value.details["status"] == "needs_review"
    assert target.read_bytes() == b"occupant\n"
    updated = store.load(workspace_identity(root).workspace_id, CHANGE_SET_ID).record
    assert updated is not None
    assert updated["state"] == "interrupted"
    assert updated["restore"]["status"] == "interrupted"


def test_resume_after_protected_occupant_removal_finishes_replace(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root, store = _edited_set(tmp_path)
    target = root / "item.txt"
    target.write_text("occupant\n", encoding="utf-8")
    review = preflight_undo(store, root, CHANGE_SET_ID)

    with monkeypatch.context() as scoped:
        scoped.setattr(
            restore_module,
            "_copy_recovery_object",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("after remove")),
        )
        with pytest.raises(RuntimeError, match="after remove"):
            undo_change_set(
                store,
                root,
                CHANGE_SET_ID,
                _decisions(review, "protect_then_replace"),
            )

    assert target.exists() is False
    receipt = undo_change_set(store, root, CHANGE_SET_ID)

    assert target.read_text(encoding="utf-8") == "original\n"
    assert len(receipt["protected"]) == 1
    assert receipt["status"] == "committed"
    record = store.load(workspace_identity(root).workspace_id, CHANGE_SET_ID).record
    assert record is not None
    assert record["restore"]["partial_result"]["protected_then_replaced"] == 1


def test_restore_copy_refuses_target_created_during_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, store = _edited_set(tmp_path)
    target = root / "item.txt"
    preflight_undo(store, root, CHANGE_SET_ID)
    original_copy = restore_module._copy_exclusive

    def _racing_copy(source: Path, destination: Path) -> None:
        original_copy(source, destination)
        target.write_bytes(b"new live bytes")

    monkeypatch.setattr(restore_module, "_copy_exclusive", _racing_copy)

    with pytest.raises(WorkspaceRestoreError) as raised:
        undo_change_set(store, root, CHANGE_SET_ID, [])

    assert raised.value.reason == "restore_state_ambiguous"
    assert target.read_bytes() == b"new live bytes"
    assert list(root.glob(".jenny-restore-*")) == []


def test_staged_skip_refuses_to_overwrite_newer_original(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root, store = _move_sequence(tmp_path, ["a.txt", "b.txt"])
    review = preflight_undo(store, root, CHANGE_SET_ID)
    with monkeypatch.context() as scoped:
        scoped.setattr(
            restore_module,
            "_execute_missing_steps",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("after staging")),
        )
        with pytest.raises(RuntimeError, match="after staging"):
            undo_change_set(store, root, CHANGE_SET_ID, [])

    identity = workspace_identity(root)
    record = store.load(identity.workspace_id, CHANGE_SET_ID).record
    assert record is not None
    first_stage = review["staging_entries"][0]
    step_id = first_stage["inverse_step_id"]
    step = next(
        item
        for operation in record["operations"]
        for item in operation["inverse_steps"]
        if item["step_id"] == step_id
    )
    original = root / step["from_relative_path"]
    original.write_bytes(b"newer bytes")
    record["restore"]["decisions"] = [
        {"inverse_step_id": step_id, "outcome": "skip", "alternate_relative_path": None}
    ]
    assert store.write_transition(record, workspace_root=root).ok

    with monkeypatch.context() as scoped:
        scoped.setattr(restore_module, "_validate_resume_state", lambda *_args: None)
        with pytest.raises(WorkspaceRestoreError) as raised:
            undo_change_set(store, root, CHANGE_SET_ID)

    assert raised.value.reason == "restore_state_ambiguous"
    assert original.read_bytes() == b"newer bytes"


def test_crash_after_step_k_resumes_only_missing_steps(tmp_path: Path) -> None:
    root, store = _three_operation_set(tmp_path)
    review = preflight_undo(store, root, CHANGE_SET_ID)
    total = len(review["inverse_plan"])
    first_run: list[str] = []

    def crash_after_two(step_id: str) -> None:
        first_run.append(step_id)
        if len(first_run) == 2:
            raise RuntimeError("injected crash")

    with pytest.raises(RuntimeError, match="injected crash"):
        undo_change_set(store, root, CHANGE_SET_ID, [], after_inverse_step_persisted=crash_after_two)
    identity = workspace_identity(root)
    interrupted = store.load(identity.workspace_id, CHANGE_SET_ID).record
    assert interrupted is not None
    assert interrupted["restore"]["status"] == "in_progress"
    assert interrupted["restore"]["completed_inverse_step_ids"] == first_run

    resumed: list[str] = []
    undo_change_set(store, root, CHANGE_SET_ID, [], after_inverse_step_persisted=resumed.append)

    assert len(resumed) == total - 2
    assert set(first_run).isdisjoint(resumed)
    assert (root / "edited.txt").read_bytes() == b"before edit\n"


def test_created_parent_cleanup_requires_empty_matching_directory(tmp_path: Path) -> None:
    root, guard, store, lifecycle = _setup(tmp_path)
    (root / "move.txt").write_text("move\n", encoding="utf-8")
    assert move_file.move_file_tool(
        _args("move", source="move.txt", destination="new/child/moved.txt"), guard
    ).success
    _commit(lifecycle)
    (root / "new" / "keep.txt").write_text("outside\n", encoding="utf-8")

    undo_change_set(store, root, CHANGE_SET_ID, [])

    assert (root / "move.txt").read_text(encoding="utf-8") == "move\n"
    assert (root / "new" / "keep.txt").read_text(encoding="utf-8") == "outside\n"
    assert (root / "new").is_dir()


def test_skipped_operation_without_materialized_recovery_does_not_block_undo(
    tmp_path: Path,
) -> None:
    root, guard, store, lifecycle = _setup(tmp_path)
    first = root / "first.txt"
    second = root / "second.txt"
    first.write_text("first before\n", encoding="utf-8")
    second.write_text("second before\n", encoding="utf-8")
    assert edit_file.edit_file_tool(
        _args(
            "first",
            file_path="first.txt",
            old_string="first before",
            new_string="first after",
        ),
        guard,
    ).success
    planned = plan_checkpoint(second, root)
    pending = lifecycle.prepare_file_change(
        _args("second"),
        tool_name="write_file",
        target=second,
        relative_path="second.txt",
        new_bytes=b"second after\n",
        checkpoint=planned,
    )
    lifecycle.mark_failed_sequence(pending, pending.sequences[0])
    _commit(lifecycle)
    assert planned.display_path is not None
    assert not (root / planned.display_path).exists()

    undo_change_set(store, root, CHANGE_SET_ID, [])

    assert first.read_text(encoding="utf-8") == "first before\n"
    assert second.read_text(encoding="utf-8") == "second before\n"


def test_directory_restore_preserves_relative_symlink(tmp_path: Path) -> None:
    root, guard, store, lifecycle = _setup(tmp_path)
    directory = root / "linked-dir"
    directory.mkdir()
    (directory / "target.txt").write_text("target\n", encoding="utf-8")
    link = directory / "relative-link.txt"
    try:
        os.symlink("target.txt", link)
    except OSError as error:
        pytest.skip(f"symlink unavailable: {error}")
    result = delete_file.delete_file_tool(
        _args("delete-linked", path="linked-dir", recursive=True),
        guard,
    )
    assert result.success
    _commit(lifecycle)

    undo_change_set(store, root, CHANGE_SET_ID, [])

    restored_link = root / "linked-dir" / "relative-link.txt"
    assert restored_link.is_symlink()
    assert os.readlink(restored_link) == "target.txt"


def test_preflight_refuses_while_another_change_set_is_in_progress(tmp_path: Path) -> None:
    root, store = _edited_set(tmp_path)
    lifecycle = MutationChangeSetLifecycle(store, root)
    guard = WorkspaceGuard(str(root), mutation_journal=lifecycle)
    result = filesystem.write_file_tool(
        {
            **_args("other-write", path="other.txt", content="other\n"),
            "_jenny_change_set_id": OTHER_CHANGE_SET_ID,
        },
        guard,
    )
    assert result.success

    with pytest.raises(WorkspaceRestoreError) as raised:
        preflight_undo(store, root, CHANGE_SET_ID)

    assert raised.value.reason == "restore_workspace_busy"
    assert raised.value.details == {"status": "busy"}
    assert lifecycle.finalize(OTHER_CHANGE_SET_ID).ok
    assert preflight_undo(store, root, CHANGE_SET_ID)["status"] == "preflight"


def test_trash_restore_occupied_destination_uses_alternate_name(tmp_path: Path) -> None:
    root, guard, store, lifecycle = _setup(tmp_path)
    (root / "deleted.txt").write_text("deleted bytes\n", encoding="utf-8")
    result = delete_file.delete_file_tool(_args("delete", path="deleted.txt"), guard)
    assert result.success
    _commit(lifecycle)
    trash_name = Path(result.metadata["trashed_path"]).parts[2]
    (root / "deleted.txt").write_text("occupant\n", encoding="utf-8")

    receipt = restore_trash_entry(store, root, trash_name, "alternate_name")

    assert (root / "deleted.txt").read_text(encoding="utf-8") == "occupant\n"
    alternate = root / receipt["renamed_to"][0]["restored_relative_path"]
    assert alternate.read_text(encoding="utf-8") == "deleted bytes\n"
    assert receipt["recovery_retained"] is True


def test_trash_directory_protects_occupied_destination_before_replace(tmp_path: Path) -> None:
    root, guard, store, lifecycle = _setup(tmp_path)
    (root / "deleted-dir").mkdir()
    (root / "deleted-dir" / "original.txt").write_text("original\n", encoding="utf-8")
    result = delete_file.delete_file_tool(
        _args("delete", path="deleted-dir", recursive=True), guard
    )
    assert result.success
    _commit(lifecycle)
    trash_name = Path(result.metadata["trashed_path"]).parts[2]
    (root / "deleted-dir").mkdir()
    (root / "deleted-dir" / "occupant.txt").write_text("occupant\n", encoding="utf-8")

    receipt = restore_trash_entry(store, root, trash_name, "protect_then_replace")

    assert (root / "deleted-dir" / "original.txt").read_text(encoding="utf-8") == "original\n"
    protected = root / receipt["protected"][0]["workspace_relative_path"]
    assert (protected / "occupant.txt").read_text(encoding="utf-8") == "occupant\n"


def test_blind_spot_markers_survive_preflight_and_receipt(tmp_path: Path) -> None:
    root, guard, store, lifecycle = _setup(tmp_path)
    lifecycle.observe_tool_call("run_command", _args("shell"))
    assert filesystem.write_file_tool(
        _args("write", path="created.txt", content="created\n"), guard
    ).success
    _commit(lifecycle)

    review = preflight_undo(store, root, CHANGE_SET_ID)
    receipt = undo_change_set(store, root, CHANGE_SET_ID, [])

    for payload in (review, receipt):
        outside = payload["outside_undo_set"]
        assert outside["shell_mutations"] == "not_journaled_approval_gated"
        assert outside["explorer_rename"] == "not_journaled_until_wo_27_item_2"
        assert outside["known_unjournaled_events"] == ["shell"]


def test_completed_prefix_validation_skips_only_superseded_same_path_steps(
    tmp_path: Path,
) -> None:
    def _prepare_chain(base: Path) -> tuple[Path, WorkspaceMutationJournalStore, list[str]]:
        base.mkdir()
        root, guard, store, lifecycle = _setup(base)
        target = root / "item.txt"
        target.write_text("A", encoding="utf-8")
        assert edit_file.edit_file_tool(
            _args("edit-one", file_path="item.txt", old_string="A", new_string="B"), guard
        ).success
        assert edit_file.edit_file_tool(
            _args("edit-two", file_path="item.txt", old_string="B", new_string="C"), guard
        ).success
        _commit(lifecycle)
        preflight_undo(store, root, CHANGE_SET_ID)
        record = store.load(workspace_identity(root).workspace_id, CHANGE_SET_ID).record
        assert record is not None
        step_ids = [
            item["step"]["step_id"] for item in restore_module._inverse_plan(record)
        ]
        return root, store, step_ids

    root, store, step_ids = _prepare_chain(tmp_path / "superseded")
    (root / "item.txt").write_text("A", encoding="utf-8")
    record = store.load(workspace_identity(root).workspace_id, CHANGE_SET_ID).record
    assert record is not None
    record["restore"]["status"] = "in_progress"
    record["restore"]["completed_inverse_step_ids"] = step_ids
    assert store.write_transition(record, workspace_root=root).ok
    receipt = undo_change_set(store, root, CHANGE_SET_ID)
    assert receipt["status"] == "committed"
    assert (root / "item.txt").read_text(encoding="utf-8") == "A"

    changed_root, changed_store, changed_step_ids = _prepare_chain(tmp_path / "changed")
    (changed_root / "item.txt").write_text("user", encoding="utf-8")
    changed_record = changed_store.load(
        workspace_identity(changed_root).workspace_id, CHANGE_SET_ID
    ).record
    assert changed_record is not None
    changed_record["restore"]["status"] = "in_progress"
    changed_record["restore"]["completed_inverse_step_ids"] = changed_step_ids[:1]
    assert changed_store.write_transition(changed_record, workspace_root=changed_root).ok
    with pytest.raises(WorkspaceRestoreError) as raised:
        undo_change_set(changed_store, changed_root, CHANGE_SET_ID)
    assert raised.value.reason == "restore_state_ambiguous"
    assert (changed_root / "item.txt").read_text(encoding="utf-8") == "user"
