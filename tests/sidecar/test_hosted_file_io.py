"""Hosted descriptor boundaries; POSIX probes run in the Linux host CI lane."""

from __future__ import annotations

import builtins
import errno
import json
import os
import socket
import stat
import tempfile
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH
from sidecar.ai.tools.builtins import (
    edit_file,
    file_atomic_write,
    file_state,
    filesystem,
    filesystem_listing,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.hosted_file_io import (
    configure_hosted_file_io,
    open_regular_file,
    scoped_hosted_file_io,
    write_hosted_bytes_atomic,
)
from sidecar.ai.tools.workspace import WorkspaceGuard
from tests.sidecar._platform_skips import posix_only

_HOSTED_POSIX = posix_only("hosted descriptor qualification: dir_fd, mkfifo, AF_UNIX")


@pytest.fixture(autouse=True)
def reset_host_io():
    configure_hosted_file_io(None, enabled=False)
    yield
    configure_hosted_file_io(None, enabled=False)


def test_desktop_read_semantics_are_preserved(tmp_path: Path):
    file = tmp_path / "normal.txt"
    file.write_text("normal", encoding="utf-8")
    with open_regular_file(file, "r", encoding="utf-8") as handle:
        assert handle.read() == "normal"


def test_unconfigured_host_root_fails_closed(tmp_path: Path):
    file = tmp_path / "normal.txt"
    file.write_text("normal", encoding="utf-8")
    configure_hosted_file_io(None, enabled=True)
    with pytest.raises(ToolExecutionFailure), open_regular_file(file):
        pass


def test_a_hosted_store_write_without_a_confined_backend_fails_closed(tmp_path: Path) -> None:
    """R12-F01: the `.jenny` artifact copy, the overwrite backup and their lock and
    temp files go through the pinned primitive; with no backend nothing is written."""
    (tmp_path / "notes.txt").write_bytes(b"old")
    workspace = WorkspaceGuard(str(tmp_path))
    configure_hosted_file_io(None, enabled=True)  # hosted, with no root and no backend
    artifact = filesystem.write_file_tool(
        {"path": ".jenny/artifacts/s1/note.md", "content": "x"}, workspace)
    overwrite = filesystem.write_file_tool({"path": "notes.txt", "content": "new"}, workspace)
    assert artifact.success is False and artifact.error_code == CMP_TOOL_INVALID_PATH, artifact
    assert overwrite.success is False, overwrite
    assert not (tmp_path / ".jenny").exists()
    assert (tmp_path / "notes.txt").read_bytes() == b"old"


_RECEIPT_NAME = "workspace-recovery.json"


def _receipt_journal(tmp_path: Path):
    from sidecar.ai.tools.workspace_mutation_journal_store import WorkspaceMutationJournalStore
    from tests.sidecar.ai.tools.test_workspace_mutation_journal import _create_record

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    record = _create_record(workspace, 1, state="committed", operation_status="applied")
    return workspace, record, WorkspaceMutationJournalStore(tmp_path / "recovery")


def test_a_desktop_journal_still_writes_its_recovery_receipt(tmp_path: Path) -> None:
    """E78: with hosted file IO off the receipt is written exactly as before."""
    workspace, record, store = _receipt_journal(tmp_path)
    assert store.write_transition(record, workspace_root=workspace).ok is True
    receipt = json.loads((workspace / ".jenny" / _RECEIPT_NAME).read_text(encoding="utf-8"))
    assert receipt["latest_change_set_id"] == record["change_set_id"]


def test_a_hosted_journal_never_touches_the_recovery_receipt_path(
    tmp_path: Path, monkeypatch,
) -> None:
    """E78: while hosted file IO is on, no by-path open, write, rename or unlink of
    `.jenny/workspace-recovery.json` (or a temp file of it) happens. The journal
    itself, under the recovery root outside the project, is still written."""
    workspace, record, store = _receipt_journal(tmp_path)
    touched: list[str] = []

    def refuse_receipt(name: str, real):
        def call(*args, **kwargs):
            text = " ".join(str(value) for value in (*args, *kwargs.values()))
            if _RECEIPT_NAME in text:
                touched.append(name)
                raise AssertionError(f"{name} touched the recovery receipt by path")
            return real(*args, **kwargs)
        return call

    for module, name in ((builtins, "open"), (os, "open"), (os, "replace"), (os, "rename"),
                         (os, "unlink"), (os, "remove"), (tempfile, "mkstemp")):
        monkeypatch.setattr(module, name, refuse_receipt(name, getattr(module, name)))
    for name in ("open", "replace", "rename", "unlink", "touch", "write_bytes", "write_text",
                 "read_bytes", "read_text"):
        monkeypatch.setattr(Path, name, refuse_receipt(f"Path.{name}", getattr(Path, name)))
    configure_hosted_file_io(None, enabled=True)
    try:
        result = store.write_transition(record, workspace_root=workspace)
    finally:
        monkeypatch.undo()
    assert touched == []
    assert result.ok is True, result.failure
    workspace_id = record["workspace"]["workspace_id"]
    assert store.load(workspace_id, record["change_set_id"]).ok is True
    assert not (workspace / ".jenny").exists()


@_HOSTED_POSIX
def test_a_hosted_artifact_write_stays_in_the_root_when_its_folder_becomes_a_symlink(
    tmp_path: Path, monkeypatch,
) -> None:
    from sidecar.ai.tools import hosted_file_io_posix, workspace_store

    root, outside = tmp_path / "workspace", tmp_path / "outside"
    (root / ".jenny" / "artifacts" / "s1").mkdir(parents=True)
    outside.mkdir()
    folder = root / ".jenny" / "artifacts" / "s1"
    swapped: list[bool] = []

    def swap(parent: Path) -> None:
        if not swapped and parent == folder:
            folder.rename(folder.with_name("s1.moved"))
            folder.symlink_to(outside, target_is_directory=True)
            swapped.append(True)

    real_mkstemp, real_write = workspace_store.tempfile.mkstemp, hosted_file_io_posix.write_atomic
    monkeypatch.setattr(workspace_store.tempfile, "mkstemp",
                        lambda *a, **k: (swap(Path(k["dir"])), real_mkstemp(*a, **k))[1])
    monkeypatch.setattr(hosted_file_io_posix, "write_atomic",
                        lambda pin, base, path, *a: (swap(Path(path).parent),
                                                     real_write(pin, base, path, *a))[1])
    with scoped_hosted_file_io(str(root), enabled=True):
        result = filesystem.write_file_tool(
            {"path": ".jenny/artifacts/s1/note.md", "content": "MODEL"}, WorkspaceGuard(str(root)))
    assert swapped and result.success is False
    assert os.listdir(outside) == []


@_HOSTED_POSIX
def test_hosted_backup_retention_removes_old_snapshots_through_the_pin(
    tmp_path: Path, monkeypatch,
) -> None:
    from sidecar.ai.tools.builtins import file_history

    monkeypatch.setattr(file_history, "MAX_BACKUP_SNAPSHOTS", 1)
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "notes.txt").write_bytes(b"v0")
    workspace = WorkspaceGuard(str(root))
    with scoped_hosted_file_io(str(root), enabled=True):
        for version in range(1, 4):
            snapshot = filesystem.read_file_tool(
                {"path": "notes.txt"}, workspace).metadata["read_snapshot"]
            result = filesystem.write_file_tool({"path": "notes.txt", "content": f"v{version}",
                                                 "expected_read_snapshot": snapshot}, workspace)
            assert result.success, result
    snapshots = [name for name in os.listdir(root / ".jenny" / "backups") if name.endswith(".bak")]
    assert len(snapshots) == 1, snapshots


def test_tool_failure_preserves_hosted_effect_classification() -> None:
    failure = ToolExecutionFailure(
        code="CMP-TOOL-0006",
        message="durability uncertain",
        error_details={"effects": "applied_durability_uncertain"},
    )

    assert failure.effects == "applied_durability_uncertain"
    assert failure.to_error_data()["effects"] == "applied_durability_uncertain"


def test_capped_read_normalizes_embedded_null_path() -> None:
    with pytest.raises(ToolExecutionFailure) as caught:
        file_state.read_capped_bytes(Path("bad\x00path"), max_bytes=8, relative_path="bad")

    assert caught.value.code == "CMP-TOOL-0006"


def test_existing_mutation_read_stays_bounded_if_file_grows_after_open(
    tmp_path: Path,
    monkeypatch,
) -> None:
    target = tmp_path / "growing.txt"
    target.write_bytes(b"x")
    original_fstat = file_state.os.fstat
    first = True

    def grow_after_initial_fstat(fd):
        nonlocal first
        status = original_fstat(fd)
        if first:
            first = False
            with target.open("ab") as writer:
                writer.write(b"y" * 32)
        return status

    monkeypatch.setattr(file_state.os, "fstat", grow_after_initial_fstat)
    with pytest.raises(ToolExecutionFailure) as caught:
        file_state.load_existing_text_state_for_mutation(
            path=target,
            relative_path="growing.txt",
            max_bytes=8,
            expected_snapshot_value=None,
            action="edit",
            require_read_snapshot=False,
        )

    assert caught.value.code == "CMP-TOOL-0006"


@_HOSTED_POSIX
def test_host_rejects_hardlink_fifo_socket_and_symlink(tmp_path: Path):
    root = tmp_path / "workspace"
    root.mkdir()
    outside = tmp_path / "private.txt"
    outside.write_text("private", encoding="utf-8")
    os.link(outside, root / "hard.txt")
    (root / "link.txt").symlink_to(outside)
    os.mkfifo(root / "pipe")
    endpoint = socket.socket(socket.AF_UNIX)
    endpoint.bind(str(root / "socket"))
    try:
        configure_hosted_file_io(str(root), enabled=True)
        for name in ["hard.txt", "link.txt", "pipe", "socket"]:
            with pytest.raises(ToolExecutionFailure), open_regular_file(root / name):
                pytest.fail("unsafe target was opened")
        assert outside.read_text(encoding="utf-8") == "private"
    finally:
        endpoint.close()


@_HOSTED_POSIX
def test_scoped_host_root_fd_must_match_captured_identity(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()

    with pytest.raises(ToolExecutionFailure), scoped_hosted_file_io(
        str(root.resolve()),
        enabled=True,
        expected_device_id=str(root.stat().st_dev),
        expected_inode=str(root.stat().st_ino + 1),
    ):
        pytest.fail("mismatched hosted root descriptor was admitted")


@_HOSTED_POSIX
def test_atomic_write_stays_at_pinned_parent_during_symlink_swap(tmp_path: Path, monkeypatch):
    root = tmp_path / "workspace"
    directory = root / "dir"
    directory.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "file.txt").write_bytes(b"private")
    target = directory / "file.txt"
    target.write_bytes(b"old")
    configure_hosted_file_io(str(root), enabled=True)
    original = os.replace

    def swap_then_replace(source, destination, **kwargs):
        directory.rename(root / "moved")
        directory.symlink_to(outside, target_is_directory=True)
        original(source, destination, **kwargs)

    monkeypatch.setattr(os, "replace", swap_then_replace)
    sentinel = object()
    assert write_hosted_bytes_atomic(target, b"new", expected=sentinel,
                                    no_expectation=sentinel, mode=None)
    assert (outside / "file.txt").read_bytes() == b"private"
    assert (root / "moved" / "file.txt").read_bytes() == b"new"


@_HOSTED_POSIX
def test_conditional_replacement_preserves_changed_content(tmp_path: Path):
    root = tmp_path / "workspace"
    root.mkdir()
    target = root / "file.txt"
    target.write_bytes(b"changed")
    configure_hosted_file_io(str(root), enabled=True)
    sentinel = object()
    assert not write_hosted_bytes_atomic(target, b"replacement", expected=b"old",
                                        no_expectation=sentinel, mode=None)
    assert target.read_bytes() == b"changed"


@pytest.mark.parametrize("tool", ["write", "edit"])
def test_real_mutation_preserves_change_during_checkpoint(tmp_path: Path, monkeypatch, tool):

    target = tmp_path / "file.txt"
    target.write_bytes(b"old content")
    workspace = WorkspaceGuard(str(tmp_path))
    snapshot = filesystem.read_file_tool({"path": "file.txt"}, workspace).metadata["read_snapshot"]
    module = filesystem if tool == "write" else edit_file
    if tool == "write":
        monkeypatch.setattr(filesystem, "hosted_file_io_enabled", lambda: True)
    else:
        # Exercise the hosted conditional-commit adapter with portable file IO;
        # descriptor confinement itself is qualified by the POSIX tests below.
        def hosted_edit(path, content, *, expected, workspace):
            file_atomic_write.write_hosted_bytes_after_read(path, content, expected=expected)
        monkeypatch.setattr(edit_file, "write_edit_bytes_after_read", hosted_edit)

    def checkpoint(*_args, **_kwargs):
        target.write_bytes(b"external change")
        return filesystem.CheckpointInfo(created=False)

    monkeypatch.setattr(module, "create_checkpoint", checkpoint)
    if tool == "write":
        result = filesystem.write_file_tool({"path": "file.txt", "content": "new content",
                                            "expected_read_snapshot": snapshot}, workspace)
    else:
        result = edit_file.edit_file_tool({"file_path": "file.txt", "old_string": "old",
                                          "new_string": "new"}, workspace)
    assert result.success is False
    assert "changed after validation" in result.output
    assert target.read_bytes() == b"external change"


@_HOSTED_POSIX
def test_expected_read_does_not_reopen_replaced_parent(tmp_path: Path, monkeypatch):
    root = tmp_path / "workspace"
    directory = root / "dir"
    directory.mkdir(parents=True)
    target = directory / "file.txt"
    target.write_bytes(b"does not match")
    configure_hosted_file_io(str(root), enabled=True)
    original = os.open
    swapped = False

    def swap_on_leaf(name, flags, *args, **kwargs):
        nonlocal swapped
        if name == "file.txt" and not swapped:
            swapped = True
            directory.rename(root / "moved")
            directory.mkdir()
            target.write_bytes(b"expected")
        return original(name, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", swap_on_leaf)
    assert not write_hosted_bytes_atomic(target, b"replacement", expected=b"expected",
                                        no_expectation=object(), mode=None)
    assert (root / "moved" / "file.txt").read_bytes() == b"does not match"
    assert target.read_bytes() == b"expected"


@_HOSTED_POSIX
@pytest.mark.parametrize("race", ["temporary", "chmod", "rewrite"])
def test_replacement_refuses_observed_identity_changes(tmp_path: Path, monkeypatch, race):

    root = tmp_path / "workspace"
    root.mkdir()
    target = root / "file.txt"
    target.write_bytes(b"old")
    configure_hosted_file_io(str(root), enabled=True)
    original = os.fsync
    changed = False

    def race_after_sync(fd):
        nonlocal changed
        original(fd)
        if changed or not stat.S_ISREG(os.fstat(fd).st_mode):
            return
        changed = True
        if race == "temporary":
            temporary = next(root.glob(".host-*.tmp"))
            temporary.unlink()
            temporary.symlink_to(target)
        elif race == "chmod":
            target.chmod(0o400)
        else:
            before = target.stat()
            target.write_bytes(b"bad")
            os.utime(target, ns=(before.st_atime_ns, before.st_mtime_ns))

    monkeypatch.setattr(os, "fsync", race_after_sync)
    if race == "temporary":
        with pytest.raises(ToolExecutionFailure):
            write_hosted_bytes_atomic(target, b"new", expected=b"old",
                                      no_expectation=object(), mode=None)
    else:
        assert not write_hosted_bytes_atomic(target, b"new", expected=b"old",
                                            no_expectation=object(), mode=None)
    assert target.read_bytes() == (b"bad" if race == "rewrite" else b"old")


@_HOSTED_POSIX
def test_post_replace_fsync_error_reports_applied_effect(tmp_path: Path, monkeypatch):

    root = tmp_path / "workspace"
    root.mkdir()
    target = root / "file.txt"
    target.write_bytes(b"old")
    configure_hosted_file_io(str(root), enabled=True)
    original = os.fsync

    def fail_directory(fd):
        if stat.S_ISDIR(os.fstat(fd).st_mode):
            raise OSError(errno.EIO, "injected")
        original(fd)

    monkeypatch.setattr(os, "fsync", fail_directory)
    with pytest.raises(ToolExecutionFailure) as caught:
        write_hosted_bytes_atomic(target, b"new", expected=b"old",
                                  no_expectation=object(), mode=None)
    assert caught.value.effects == "applied_durability_uncertain"
    assert caught.value.retryable is False
    assert target.read_bytes() == b"new"


def _list_text(result) -> str:
    return result.output if hasattr(result, "output") else str(result)


def test_list_dir_desktop_output_unchanged_when_hosted_disabled(tmp_path: Path) -> None:
    (tmp_path / "sub").mkdir()
    (tmp_path / "a.txt").write_bytes(b"abc")
    text = _list_text(filesystem_listing.list_dir_tool({"path": "."}, WorkspaceGuard(str(tmp_path))))
    assert "[D] sub" in text
    assert "[F] a.txt  3B" in text


def test_list_dir_selects_descriptor_path_when_hosted(tmp_path: Path, monkeypatch) -> None:
    sentinel = ToolExecutionFailure(code="CMP-TOOL-0001", message="hosted-path", retryable=False)

    def fake_open(path):
        raise sentinel

    monkeypatch.setattr(filesystem_listing, "hosted_file_io_enabled", lambda: True)
    monkeypatch.setattr(filesystem_listing, "open_hosted_directory", fake_open)
    with pytest.raises(ToolExecutionFailure) as caught:
        filesystem_listing.list_dir_tool({"path": "."}, WorkspaceGuard(str(tmp_path)))
    assert caught.value is sentinel


@_HOSTED_POSIX
def test_hosted_list_dir_matches_desktop_output(tmp_path: Path) -> None:
    root = tmp_path.resolve() / "workspace"
    (root / "sub").mkdir(parents=True)
    (root / "sub" / "inner.txt").write_bytes(b"12345")
    (root / "a.txt").write_bytes(b"abc")
    guard = WorkspaceGuard(str(root))
    expected = [_list_text(filesystem_listing.list_dir_tool({"path": p}, guard)) for p in (".", "sub")]
    with scoped_hosted_file_io(str(root), enabled=True):
        actual = [_list_text(filesystem_listing.list_dir_tool({"path": p}, guard)) for p in (".", "sub")]
    assert actual == expected


@_HOSTED_POSIX
def test_hosted_list_dir_rejects_directory_swapped_for_symlink(tmp_path: Path) -> None:
    root = tmp_path.resolve() / "workspace"
    (root / "dir").mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret-name.txt").write_bytes(b"private")
    guard = WorkspaceGuard(str(root))
    original = guard.resolve_list_path

    def resolve_then_swap(requested):
        resolved = original(requested)
        (root / "dir").rename(root / "moved")
        (root / "dir").symlink_to(outside, target_is_directory=True)
        return resolved

    guard.resolve_list_path = resolve_then_swap  # type: ignore[method-assign]
    with scoped_hosted_file_io(str(root), enabled=True), pytest.raises(ToolExecutionFailure) as caught:
        filesystem_listing.list_dir_tool({"path": "dir"}, guard)
    assert "secret-name" not in caught.value.message


@_HOSTED_POSIX
def test_hosted_list_dir_stops_at_scan_budget_and_marks_unknown_total(
    tmp_path: Path, monkeypatch
) -> None:
    root = tmp_path.resolve() / "workspace"
    root.mkdir()
    for index in range(8):
        (root / f"file-{index}.txt").write_text("x", encoding="utf-8")
    monkeypatch.setattr(filesystem_listing, "MAX_LIST_SCAN_ENTRIES", 3)

    with scoped_hosted_file_io(str(root), enabled=True):
        result = filesystem_listing.list_dir_tool({"path": "."}, WorkspaceGuard(str(root)))

    assert result.metadata == {
        "returned_count": 3,
        "total_size_bytes": 3,
        "entries_scanned": 3,
        "entries_skipped": 0,
        "truncated": True,
        "totals_known": False,
        "total_entries": None,
        "cursor": None,
    }


@_HOSTED_POSIX
def test_posix_directory_scans_once_per_scope(tmp_path: Path) -> None:
    from sidecar.ai.tools.hosted_file_io_posix import PosixDirectory

    for index in range(4):
        (tmp_path / f"file-{index}.txt").write_text("x", encoding="utf-8")
    fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    directory = PosixDirectory(fd)
    try:
        assert len(directory.scan(2)) == 2
        with pytest.raises(ToolExecutionFailure):
            directory.scan(2)
    finally:
        directory.close()
        os.close(fd)
