"""Batch 3 / C7 restore review: newest-first trash lookup, the restore byte cap,
one busy scan per Undo, and ancestors created one pinned level at a time."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_CAP_EXCEEDED
from sidecar.ai.routing.mutation_change_set_lifecycle import MutationChangeSetLifecycle
from sidecar.ai.tools import workspace_reapply as reapply_module
from sidecar.ai.tools import workspace_restore as restore_module
from sidecar.ai.tools import workspace_restore_io as restore_io
from sidecar.ai.tools.builtins import delete_file, filesystem
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_mutation_journal_contract import workspace_identity
from sidecar.ai.tools.workspace_mutation_live_owner import owned_mutation_attribution
from sidecar.ai.tools.workspace_restore import (
    MAX_LISTED_CHANGE_SETS,
    WorkspaceRestoreError,
    restore_trash_entry,
    undo_change_set,
)
from tests.sidecar._platform_skips import make_dir_link
from tests.sidecar.ai.tools.test_workspace_restore import (
    CHANGE_SET_ID,
    OTHER_CHANGE_SET_ID,
    _args,
    _commit,
    _edited_set,
    _setup,
)
from tests.sidecar.ai.tools.test_workspace_restore_fixes import _record


def test_trash_restore_finds_the_newest_set_behind_more_than_the_listing_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, guard, store, lifecycle = _setup(tmp_path)
    (root / "deleted.txt").write_text("deleted bytes\n", encoding="utf-8")
    result = delete_file.delete_file_tool(_args("delete", path="deleted.txt"), guard)
    assert result.success
    _commit(lifecycle)
    trash_name = Path(result.metadata["trashed_path"]).parts[2]
    workspace_dir = store.version_root / workspace_identity(root).workspace_id
    # Older UUIDv7 names sort first in an NTFS listing, ahead of the real set.
    for index in range(MAX_LISTED_CHANGE_SETS + 10):
        (workspace_dir / f"00000000-0000-7000-8000-{index:012x}").mkdir()
    loads: list[str] = []
    original_load = store.load
    monkeypatch.setattr(store, "load", lambda ws, cs: loads.append(cs) or original_load(ws, cs))

    receipt = restore_trash_entry(store, root, trash_name)

    assert receipt["restored"] == [{"relative_path": "deleted.txt"}]
    assert (root / "deleted.txt").read_text(encoding="utf-8") == "deleted bytes\n"
    assert loads == [CHANGE_SET_ID], "the newest set matches first and the scan stops there"


def test_restore_copy_refuses_a_file_over_the_cap_before_writing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "big.bin").write_bytes(b"x" * 17)
    monkeypatch.setattr(restore_io, "MAX_RESTORE_FILE_BYTES", 16)

    with restore_io.bound_workspace(root), pytest.raises(ToolExecutionFailure) as raised:
        restore_io.copy_new(root / "big.bin", root / "copy.bin")

    assert raised.value.code == CMP_TOOL_CAP_EXCEEDED
    assert raised.value.retryable is False
    assert not (root / "copy.bin").exists()


def test_restore_copy_round_trips_a_multi_chunk_file_at_the_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    data = os.urandom(3 * 65_536 + 7)
    (root / "source.bin").write_bytes(data)
    monkeypatch.setattr(restore_io, "MAX_RESTORE_FILE_BYTES", len(data))

    with restore_io.bound_workspace(root):
        restore_io.copy_new(root / "source.bin", root / "copy.bin")

    assert (root / "copy.bin").read_bytes() == data


def test_an_oversized_recovery_object_stops_undo_resumably(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, store = _edited_set(tmp_path)
    monkeypatch.setattr(restore_io, "MAX_RESTORE_FILE_BYTES", 1)

    with pytest.raises(WorkspaceRestoreError) as raised:
        undo_change_set(store, root, CHANGE_SET_ID, [])

    assert raised.value.reason == "recovery_object_too_large"
    assert _record(store, root)["restore"]["status"] == "in_progress"
    assert (root / "item.txt").read_text(encoding="utf-8") == "jenny\n"
    monkeypatch.setattr(restore_io, "MAX_RESTORE_FILE_BYTES", 1 << 20)
    assert undo_change_set(store, root, CHANGE_SET_ID, [])["status"] == "committed"
    assert (root / "item.txt").read_text(encoding="utf-8") == "original\n"


def test_undo_reconciles_and_checks_for_other_open_sets_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, store = _edited_set(tmp_path)
    busy_checks: list[str] = []
    reconciles: list[object] = []
    original_check = restore_module._assert_no_other_active_set
    original_reconcile = store.reconcile_workspace

    def counting_check(*args: object) -> None:
        busy_checks.append(str(args[2]))
        original_check(*args)  # type: ignore[arg-type]

    monkeypatch.setattr(restore_module, "_assert_no_other_active_set", counting_check)
    monkeypatch.setattr(store, "reconcile_workspace",
                        lambda workspace: reconciles.append(workspace) or original_reconcile(workspace))

    assert undo_change_set(store, root, CHANGE_SET_ID, [])["status"] == "committed"

    assert busy_checks == [CHANGE_SET_ID]
    assert len(reconciles) == 1


def test_redo_refuses_while_another_change_set_is_in_progress(tmp_path: Path) -> None:
    root, store = _edited_set(tmp_path)
    undo_change_set(store, root, CHANGE_SET_ID, [])
    (root / "item.txt").write_text("jenny\n", encoding="utf-8")  # the Redo safety copy
    guard = WorkspaceGuard(str(root), mutation_journal=MutationChangeSetLifecycle(store, root))
    with owned_mutation_attribution(
        store, root, change_set_id=OTHER_CHANGE_SET_ID,
        session_id="session-restore", turn_id="turn-restore",
    ) as attribution:
        assert filesystem.write_file_tool(
            {**_args("other-write", path="other.txt", content="other\n"), **attribution}, guard,
        ).success
        with pytest.raises(WorkspaceRestoreError) as raised:
            reapply_module.reapply_change_set(store, root, CHANGE_SET_ID)
    assert raised.value.reason == "restore_workspace_busy"
    assert raised.value.details == {"status": "busy"}


def _deleted_deep_set(tmp_path: Path) -> tuple[Path, object]:
    root, guard, store, lifecycle = _setup(tmp_path)
    (root / "deep" / "er").mkdir(parents=True)
    (root / "deep" / "er" / "file.txt").write_bytes(b"restore me\n")
    assert delete_file.delete_file_tool(_args("delete", path="deep/er/file.txt"), guard).success
    _commit(lifecycle)
    shutil.rmtree(root / "deep")  # the user removed the whole folder afterwards
    return root, store


def test_undo_recreates_each_missing_ancestor_through_a_pinned_create(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, store = _deleted_deep_set(tmp_path)
    created: list[Path] = []
    original_create = restore_io._create_pinned

    def recording_create(path: Path, **kwargs: object) -> None:
        created.append(path)
        original_create(path, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(restore_io, "_create_pinned", recording_create)

    undo_change_set(store, root, CHANGE_SET_ID, [])

    assert created[:2] == [root / "deep", root / "deep" / "er"]
    assert (root / "deep" / "er" / "file.txt").read_bytes() == b"restore me\n"


def test_an_ancestor_swapped_before_parents_are_created_creates_nothing_outside(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, store = _deleted_deep_set(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    original_validate = restore_io._validate_parent
    swapped: list[Path] = []

    def validate_then_swap(path: Path) -> None:
        original_validate(path)
        deep = root / "deep"
        if not swapped and (path == deep or deep in path.parents):
            swapped.append(path)  # validation passed; the missing ancestor appears as a link
            make_dir_link(deep, outside)

    monkeypatch.setattr(restore_io, "_validate_parent", validate_then_swap)

    with pytest.raises(WorkspaceRestoreError) as raised:
        undo_change_set(store, root, CHANGE_SET_ID, [])

    assert swapped
    assert raised.value.reason == "restore_path_unsafe"
    assert list(outside.rglob("*")) == []
