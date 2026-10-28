"""Undo/Redo restore regressions: guarded restore I/O, resumable restores,
kept files edited twice, deleted files, and Redo after a protected undo."""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from sidecar.ai.tools import workspace_reapply as reapply_module
from sidecar.ai.tools import workspace_restore as restore_module
from sidecar.ai.tools import workspace_restore_io as restore_io
from sidecar.ai.tools.builtins import delete_file, edit_file
from sidecar.ai.tools.workspace_mutation_journal_contract import workspace_identity
from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore
from sidecar.ai.tools.workspace_restore import (
    WorkspaceRestoreError,
    list_change_sets,
    preflight_undo,
    undo_change_set,
)
from tests.sidecar._platform_skips import make_dir_link, posix_only
from tests.sidecar.ai.tools.test_workspace_restore import (
    CHANGE_SET_ID,
    _args,
    _commit,
    _decisions,
    _edited_set,
    _setup,
    _three_operation_set,
)


def _record(store: WorkspaceMutationJournalStore, root: Path) -> dict[str, object]:
    record = store.load(workspace_identity(root).workspace_id, CHANGE_SET_ID).record
    assert record is not None
    return record


def _deleted_nested_set(tmp_path: Path) -> tuple[Path, WorkspaceMutationJournalStore]:
    root, guard, store, lifecycle = _setup(tmp_path)
    (root / "sub").mkdir()
    (root / "sub" / "file.txt").write_bytes(b"restore me\n")
    assert delete_file.delete_file_tool(_args("delete", path="sub/file.txt"), guard).success
    _commit(lifecycle)
    return root, store


# -- A19-F1: an ancestor swapped for a link never sends restore I/O outside ------


@pytest.mark.parametrize("moment", ["before_copy", "before_commit"])
def test_restore_never_writes_outside_after_an_ancestor_swap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, moment: str
) -> None:
    root, store = _deleted_nested_set(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    preflight_undo(store, root, CHANGE_SET_ID)
    original_copy = restore_module._copy_exclusive

    def swap() -> None:
        (root / "sub").rename(root / "sub-moved")
        make_dir_link(root / "sub", outside)

    def racing_copy(source: Path, destination: Path) -> None:
        if moment == "before_copy":
            swap()
        original_copy(source, destination)
        if moment == "before_commit":
            swap()

    monkeypatch.setattr(restore_module, "_copy_exclusive", racing_copy)

    with pytest.raises(WorkspaceRestoreError) as raised:
        undo_change_set(store, root, CHANGE_SET_ID, [])

    assert raised.value.reason == "restore_path_unsafe"
    assert list(outside.iterdir()) == []
    assert _record(store, root)["restore"]["status"] == "in_progress"


def _deleted_tree_set(tmp_path: Path) -> tuple[Path, WorkspaceMutationJournalStore]:
    root, guard, store, lifecycle = _setup(tmp_path)
    (root / "sub" / "tree" / "deep").mkdir(parents=True)
    (root / "sub" / "tree" / "top.txt").write_bytes(b"top\n")
    (root / "sub" / "tree" / "deep" / "leaf.txt").write_bytes(b"leaf\n")
    assert delete_file.delete_file_tool(_args("delete", path="sub/tree", recursive=True), guard).success
    _commit(lifecycle)
    return root, store


def test_directory_restore_never_writes_outside_after_an_ancestor_swap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, store = _deleted_tree_set(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    preflight_undo(store, root, CHANGE_SET_ID)
    original_recheck = restore_io._recheck
    swapped: list[Path] = []

    def recheck_then_swap(path: Path, identity: object) -> None:
        original_recheck(path, identity)  # type: ignore[arg-type]
        if not swapped and path.parent == root / "sub":
            # The last pre-write check passed; the ancestor becomes a link now.
            swapped.append(path)
            (root / "sub").rename(root / "sub-moved")
            make_dir_link(root / "sub", outside)

    monkeypatch.setattr(restore_io, "_recheck", recheck_then_swap)

    with pytest.raises(WorkspaceRestoreError) as raised:
        undo_change_set(store, root, CHANGE_SET_ID, [])

    assert swapped
    assert raised.value.reason == "restore_path_unsafe"
    # Formerly a Windows branch accepted the directory a pathname mkdir left
    # outside, which pinned the w2f5-R1 defect; nothing is created there now.
    assert list(outside.rglob("*")) == []
    assert _record(store, root)["restore"]["status"] == "in_progress"


def test_an_ancestor_swapped_right_before_the_directory_create_leaves_outside_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # w2f5-R1: the last pathname check passed; the parent becomes a junction
    # (Windows) or symlink (POSIX) to an outside directory just before the
    # create, so only a handle-relative create keeps the node inside.
    root, store = _deleted_tree_set(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    preflight_undo(store, root, CHANGE_SET_ID)
    swapped: list[Path] = []

    def swap_before_create(path: Path) -> None:
        if not swapped and path.parent == root / "sub":
            swapped.append(path)
            (root / "sub").rename(root / "sub-moved")
            make_dir_link(root / "sub", outside)

    monkeypatch.setattr(restore_io, "_before_restore_io", swap_before_create)

    with pytest.raises(WorkspaceRestoreError) as raised:
        undo_change_set(store, root, CHANGE_SET_ID, [])

    assert swapped and swapped[0].name.startswith(".jenny-restore-")
    assert raised.value.reason == "restore_path_unsafe"
    assert "left_in_place" not in raised.value.details
    assert list(outside.rglob("*")) == []
    assert not (root / "sub-moved" / swapped[0].name).exists(), "the node created in the held parent is removed"
    assert _record(store, root)["restore"]["status"] == "in_progress"



def test_a_swap_right_after_a_directory_create_never_deletes_an_outside_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The ancestor becomes a link after mkdir succeeded but before the node was
    # identified; outside holds an unrelated empty directory of the same name.
    root, store = _deleted_tree_set(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    preflight_undo(store, root, CHANGE_SET_ID)
    original_mkdir = os.mkdir
    swapped: list[str] = []

    def mkdir_then_swap(name: object, *args: object, **kwargs: object) -> None:
        leaf = os.path.basename(os.fsdecode(name))  # type: ignore[arg-type]
        if swapped or not leaf.startswith(".jenny-restore-"):
            original_mkdir(name, *args, **kwargs)  # type: ignore[arg-type]
            return
        original_mkdir(outside / leaf)  # someone else's directory, there before the swap
        original_mkdir(name, *args, **kwargs)  # type: ignore[arg-type]
        swapped.append(leaf)
        (root / "sub").rename(root / "sub-moved")
        make_dir_link(root / "sub", outside)

    if os.name == "nt":
        # Windows creates relative to a held parent handle, not by os.mkdir.
        # While the created directory's handle is open Windows refuses to
        # rename its parent, so the latest swap it permits is just before.
        original_create = restore_io._win32.create_directory_relative

        def create_then_swap(parent: int, name: str) -> int:
            if swapped or not name.startswith(".jenny-restore-"):
                return original_create(parent, name)
            original_mkdir(outside / name)
            swapped.append(name)
            (root / "sub").rename(root / "sub-moved")
            make_dir_link(root / "sub", outside)
            return original_create(parent, name)

        monkeypatch.setattr(restore_io._win32, "create_directory_relative", create_then_swap)
    else:
        monkeypatch.setattr(restore_io.os, "mkdir", mkdir_then_swap)

    with pytest.raises(WorkspaceRestoreError) as raised:
        undo_change_set(store, root, CHANGE_SET_ID, [])
    monkeypatch.undo()

    assert swapped
    assert raised.value.reason == "restore_path_unsafe"
    assert (outside / swapped[0]).is_dir(), "the outside directory survives"
    assert sorted(path.name for path in outside.iterdir()) == swapped
    # Formerly Windows asserted `left_in_place` here, which pinned the w2f5-R1
    # defect; the node created in the held parent is now deleted by its handle.
    assert "left_in_place" not in raised.value.details
    assert not (root / "sub-moved" / swapped[0]).exists()


def test_directory_restore_rebuilds_the_nested_tree(tmp_path: Path) -> None:
    root, store = _deleted_tree_set(tmp_path)

    assert undo_change_set(store, root, CHANGE_SET_ID, [])["status"] == "committed"

    assert (root / "sub" / "tree" / "top.txt").read_bytes() == b"top\n"
    assert (root / "sub" / "tree" / "deep" / "leaf.txt").read_bytes() == b"leaf\n"
    assert sorted(path.name for path in (root / "sub").iterdir()) == ["tree"]


@posix_only("directory permission bits; Windows has no equivalent mode")
def test_directory_restore_keeps_directory_modes_and_stays_private_while_filling(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, guard, store, lifecycle = _setup(tmp_path)
    secret = root / "secret"
    (secret / "inner").mkdir(parents=True)
    (secret / "inner" / "notes.txt").write_bytes(b"private\n")
    os.chmod(secret / "inner" / "notes.txt", 0o644)
    os.chmod(secret / "inner", 0o750)
    os.chmod(secret, 0o700)
    assert delete_file.delete_file_tool(_args("delete", path="secret", recursive=True), guard).success
    _commit(lifecycle)
    seen: list[int] = []
    original_copy = restore_io.copy_new

    def watching_copy(source: Path, destination: Path) -> None:
        if source.is_file():
            seen.extend(stat.S_IMODE(parent.stat().st_mode) for parent in (destination.parent, destination.parent.parent))
        original_copy(source, destination)

    monkeypatch.setattr(restore_io, "copy_new", watching_copy)
    previous = os.umask(0o022)
    try:
        assert undo_change_set(store, root, CHANGE_SET_ID, [])["status"] == "committed"
    finally:
        os.umask(previous)

    assert seen and all(mode & 0o077 == 0 for mode in seen)  # nobody else can enter while it fills
    assert stat.S_IMODE(secret.stat().st_mode) == 0o700
    assert stat.S_IMODE((secret / "inner").stat().st_mode) == 0o750
    assert stat.S_IMODE((secret / "inner" / "notes.txt").stat().st_mode) == 0o644
    assert (secret / "inner" / "notes.txt").read_bytes() == b"private\n"


# -- A19-F3 + A16-F3: a stopped Undo keeps its receipt and resumes via preflight --


def _fail_second_step(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    original = restore_module._execute_step
    ran: list[str] = []

    def failing(root, record, step, stage, decision):  # type: ignore[no-untyped-def]
        if ran:
            raise PermissionError(13, "destination is not writable")
        ran.append(step["step_id"])
        return original(root, record, step, stage, decision)

    monkeypatch.setattr(restore_module, "_execute_step", failing)
    return ran


def test_io_failure_mid_undo_keeps_receipt_and_resumes_only_remaining_steps(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, store = _three_operation_set(tmp_path)
    total = len(preflight_undo(store, root, CHANGE_SET_ID)["inverse_plan"])
    with monkeypatch.context() as scoped:
        ran = _fail_second_step(scoped)
        with pytest.raises(WorkspaceRestoreError) as raised:
            undo_change_set(store, root, CHANGE_SET_ID, [])

    assert raised.value.reason == "restore_io_failed"
    assert raised.value.details["status"] == "in_progress"
    assert raised.value.details["completed_count"] == len(ran) == 1
    stopped = _record(store, root)
    assert stopped["restore"]["status"] == "in_progress"
    assert stopped["restore"]["completed_inverse_step_ids"] == ran

    journal = store.journal_path(workspace_identity(root).workspace_id, CHANGE_SET_ID)
    before = journal.read_bytes()
    review = preflight_undo(store, root, CHANGE_SET_ID)
    assert journal.read_bytes() == before  # the resumable preflight writes nothing
    assert review["status"] == "preflight"
    assert review["conflicts"] == []
    assert review["resume"]["restore_status"] == "in_progress"
    assert review["resume"]["completed_inverse_step_ids"] == ran
    assert [row["inverse_step_id"] for row in review["resume"]["receipt"]["restored"]] == ran
    assert {step["inverse_step_id"] for step in review["inverse_plan"]}.isdisjoint(ran)

    resumed: list[str] = []
    final = undo_change_set(store, root, CHANGE_SET_ID, {}, after_inverse_step_persisted=resumed.append)

    assert final["status"] == "committed"
    assert len(resumed) == total - 1
    assert set(resumed).isdisjoint(ran)
    assert not (root / "created.txt").exists()
    assert (root / "edited.txt").read_bytes() == b"before edit\n"
    assert (root / "move.txt").read_bytes() == b"move bytes\x00\xff"


def test_preflight_after_a_crash_reports_the_resumable_restore(tmp_path: Path) -> None:
    root, store = _three_operation_set(tmp_path)
    preflight_undo(store, root, CHANGE_SET_ID)
    first: list[str] = []

    def crash(step_id: str) -> None:
        first.append(step_id)
        raise RuntimeError("injected crash")

    with pytest.raises(RuntimeError, match="injected crash"):
        undo_change_set(store, root, CHANGE_SET_ID, [], after_inverse_step_persisted=crash)

    review = preflight_undo(store, root, CHANGE_SET_ID)

    assert review["resume"]["completed_inverse_step_ids"] == first
    assert review["inverse_plan"] and all(step["inverse_step_id"] not in first for step in review["inverse_plan"])
    assert undo_change_set(store, root, CHANGE_SET_ID, {})["status"] == "committed"


def test_a_crash_after_the_final_persisted_step_resumes_as_finalization_only(tmp_path: Path) -> None:
    root, store = _three_operation_set(tmp_path)
    total = len(preflight_undo(store, root, CHANGE_SET_ID)["inverse_plan"])
    persisted: list[str] = []

    def crash_after_last(step_id: str) -> None:
        persisted.append(step_id)
        if len(persisted) == total:
            raise RuntimeError("injected crash before commit")

    with pytest.raises(RuntimeError, match="before commit"):
        undo_change_set(store, root, CHANGE_SET_ID, [], after_inverse_step_persisted=crash_after_last)
    assert _record(store, root)["restore"]["status"] == "in_progress"
    on_disk = {name: (root / name).read_bytes() for name in ("edited.txt", "move.txt")}

    review = preflight_undo(store, root, CHANGE_SET_ID)
    assert review["inverse_plan"] == []
    assert review["resume"]["completed_inverse_step_ids"] == persisted

    rerun: list[str] = []
    final = undo_change_set(store, root, CHANGE_SET_ID, {}, after_inverse_step_persisted=rerun.append)

    assert final["status"] == "committed"
    assert rerun == []  # no inverse step ran again
    assert {name: (root / name).read_bytes() for name in on_disk} == on_disk
    assert _record(store, root)["state"] == "rolled_back"


# -- A19-F5: keeping a conflicted file that the change set edited twice ----------


def _twice_edited_set(tmp_path: Path) -> tuple[Path, WorkspaceMutationJournalStore]:
    root, guard, store, lifecycle = _setup(tmp_path)
    (root / "twice.txt").write_text("zero\n", encoding="utf-8")
    (root / "other.txt").write_text("other before\n", encoding="utf-8")
    for call_id, old, new, name in (
        ("one", "zero", "one", "twice.txt"),
        ("two", "one", "two", "twice.txt"),
        ("other", "other before", "other after", "other.txt"),
    ):
        assert edit_file.edit_file_tool(
            _args(call_id, file_path=name, old_string=old, new_string=new), guard
        ).success
    _commit(lifecycle)
    return root, store


@pytest.mark.parametrize("outcome", ["skip", "protect_then_replace"])
def test_keeping_a_twice_edited_file_leaves_it_and_undoes_the_rest(tmp_path: Path, outcome: str) -> None:
    root, store = _twice_edited_set(tmp_path)
    (root / "twice.txt").write_text("user\n", encoding="utf-8")
    review = preflight_undo(store, root, CHANGE_SET_ID)
    assert [conflict["relative_path"] for conflict in review["conflicts"]] == ["twice.txt"]

    receipt = undo_change_set(store, root, CHANGE_SET_ID, _decisions(review, outcome))

    assert receipt["status"] == "committed"
    assert (root / "other.txt").read_text(encoding="utf-8") == "other before\n"
    if outcome == "skip":
        assert (root / "twice.txt").read_text(encoding="utf-8") == "user\n"
        assert {row["relative_path"] for row in receipt["skipped"]} == {"twice.txt"}
        assert len(receipt["skipped"]) == 2
    else:
        assert (root / "twice.txt").read_text(encoding="utf-8") == "zero\n"
        protected = root / receipt["protected"][0]["workspace_relative_path"]
        assert protected.read_text(encoding="utf-8") == "user\n"


# -- A19-F6: a modified file the user then deleted is a conflict ------------------


@pytest.mark.parametrize("outcome", ["skip", "protect_then_replace"])
def test_a_deleted_modified_file_is_shown_and_follows_the_decision(tmp_path: Path, outcome: str) -> None:
    root, store = _edited_set(tmp_path)
    (root / "item.txt").unlink()

    review = preflight_undo(store, root, CHANGE_SET_ID)

    assert [(item["relative_path"], item["reasons"]) for item in review["conflicts"]] == [
        ("item.txt", ["destination_missing"])
    ]
    receipt = undo_change_set(store, root, CHANGE_SET_ID, _decisions(review, outcome))
    assert receipt["status"] == "committed"
    assert receipt["protected"] == []
    if outcome == "skip":
        assert not (root / "item.txt").exists()
    else:
        assert (root / "item.txt").read_text(encoding="utf-8") == "original\n"
    assert _record(store, root)["state"] == "rolled_back"


# -- A19-F7: Redo after a protected undo puts the user's bytes back, so it re-arms --


def test_reapply_rearms_a_protected_undo_once_redo_put_the_protected_bytes_back(tmp_path: Path) -> None:
    root, store = _edited_set(tmp_path)
    (root / "item.txt").write_text("external occupant\n", encoding="utf-8")
    review = preflight_undo(store, root, CHANGE_SET_ID)
    undo_change_set(store, root, CHANGE_SET_ID, _decisions(review, "protect_then_replace"))
    assert (root / "item.txt").read_text(encoding="utf-8") == "original\n"
    # The Redo safety copy holds what was on disk before the undo: the user's bytes.
    (root / "item.txt").write_text("external occupant\n", encoding="utf-8")

    summary = reapply_module.reapply_change_set(store, root, CHANGE_SET_ID)

    assert summary["state"] == "committed"
    assert summary["restore_status"] == "not_requested"
    listed = next(item for item in list_change_sets(store, root)["change_sets"] if item["change_set_id"] == CHANGE_SET_ID)
    assert listed["restore_status"] == "not_requested"
    again = preflight_undo(store, root, CHANGE_SET_ID)
    assert [item["relative_path"] for item in again["conflicts"]] == ["item.txt"]


def test_the_resume_preflight_names_each_completed_move_with_both_ends(tmp_path: Path) -> None:
    # A reloaded renderer rebuilds a move's Redo entry from this, since the
    # resumed plan no longer holds the move step.
    root, store = _three_operation_set(tmp_path)
    plan = preflight_undo(store, root, CHANGE_SET_ID)["inverse_plan"]
    moves = [step for step in plan if step["kind"] == "move_back"]
    assert moves
    persisted: list[str] = []

    def crash_after_last(step_id: str) -> None:
        persisted.append(step_id)
        if len(persisted) == len(plan):
            raise RuntimeError("injected crash before commit")

    with pytest.raises(RuntimeError, match="before commit"):
        undo_change_set(store, root, CHANGE_SET_ID, [], after_inverse_step_persisted=crash_after_last)

    review = preflight_undo(store, root, CHANGE_SET_ID)

    assert review["resume"]["completed_moves"] == [
        {
            "inverse_step_id": step["inverse_step_id"],
            "from_relative_path": step["from_relative_path"],
            "to_relative_path": step["to_relative_path"],
        }
        for step in moves
    ]
