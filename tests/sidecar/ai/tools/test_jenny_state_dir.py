"""A project's ``.jenny`` folder ignores itself for Git (``.jenny/.gitignore`` = ``*``)."""

from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.tools import jenny_state_dir
from sidecar.ai.tools.jenny_state_dir import (
    JENNY_GITIGNORE_CONTENT,
    ensure_jenny_dir_gitignore,
)
from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore
from sidecar.ai.tools.workspace_store import GuardedWorkspaceStore, WorkspaceStoreKind
from tests.sidecar.ai.tools.test_workspace_mutation_journal import _create_record


def _gitignore(root: Path) -> Path:
    return root / ".jenny" / ".gitignore"


def test_content_ignores_everything_and_names_its_creator() -> None:
    first, second, *_ = JENNY_GITIGNORE_CONTENT.split("\n")
    assert first.startswith("# Created by Jenny")
    assert second == "*"


def test_helper_writes_star_gitignore_into_a_fresh_jenny_dir(tmp_path: Path) -> None:
    (tmp_path / ".jenny").mkdir()
    assert ensure_jenny_dir_gitignore(tmp_path / ".jenny") is True
    assert _gitignore(tmp_path).read_bytes() == JENNY_GITIGNORE_CONTENT.encode("utf-8")


def test_existing_gitignore_is_left_byte_identical(tmp_path: Path) -> None:
    (tmp_path / ".jenny").mkdir()
    owned = b"# mine\r\n!keep.json\r\n"
    _gitignore(tmp_path).write_bytes(owned)
    assert ensure_jenny_dir_gitignore(tmp_path / ".jenny") is False
    assert _gitignore(tmp_path).read_bytes() == owned


def test_write_failure_is_swallowed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / ".jenny").mkdir()

    def _denied(*_args: object, **_kwargs: object) -> int:
        raise PermissionError("denied")

    monkeypatch.setattr(jenny_state_dir.os, "open", _denied)
    assert ensure_jenny_dir_gitignore(tmp_path / ".jenny") is False
    assert not _gitignore(tmp_path).exists()


def test_missing_or_non_jenny_dirs_are_quiet_no_ops(tmp_path: Path) -> None:
    assert ensure_jenny_dir_gitignore(tmp_path / ".jenny") is False
    assert not (tmp_path / ".jenny").exists()
    assert ensure_jenny_dir_gitignore(tmp_path) is False
    assert not (tmp_path / ".gitignore").exists()
    (tmp_path / ".jenny").write_text("not a dir", encoding="utf-8")
    assert ensure_jenny_dir_gitignore(tmp_path / ".jenny") is False


def test_guarded_store_write_leaves_jenny_self_ignoring(tmp_path: Path) -> None:
    store = GuardedWorkspaceStore(tmp_path)
    store.write_bytes_atomic(store.resolve(WorkspaceStoreKind.ARTIFACTS, "s/a.md"), b"# a")
    assert _gitignore(tmp_path).read_bytes() == JENNY_GITIGNORE_CONTENT.encode("utf-8")


def test_guarded_store_keeps_an_owner_edited_gitignore(tmp_path: Path) -> None:
    (tmp_path / ".jenny").mkdir()
    _gitignore(tmp_path).write_bytes(b"!keep\n")
    store = GuardedWorkspaceStore(tmp_path)
    store.write_bytes_atomic(store.resolve(WorkspaceStoreKind.BACKUPS, "b.txt"), b"b")
    assert _gitignore(tmp_path).read_bytes() == b"!keep\n"


def test_recovery_receipt_leaves_jenny_self_ignoring(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    record = _create_record(workspace, 1, state="committed", operation_status="applied")
    store = WorkspaceMutationJournalStore(tmp_path / "recovery")
    assert store.write_transition(record, workspace_root=workspace).ok is True
    assert (workspace / ".jenny" / "workspace-recovery.json").is_file()
    assert _gitignore(workspace).read_bytes() == JENNY_GITIGNORE_CONTENT.encode("utf-8")
