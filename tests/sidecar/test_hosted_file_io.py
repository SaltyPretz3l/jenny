"""Hosted descriptor boundaries; POSIX probes run in the Linux host CI lane."""

from __future__ import annotations

import errno
import os
import socket
import stat
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins import edit_file, file_atomic_write, file_state, filesystem
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.hosted_file_io import (
    configure_hosted_file_io,
    open_regular_file,
    write_hosted_bytes_atomic,
)
from sidecar.ai.tools.workspace import WorkspaceGuard


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


@pytest.mark.skipif(os.name != "posix", reason="Linux hosted descriptor qualification")
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


@pytest.mark.skipif(os.name != "posix", reason="Linux hosted descriptor qualification")
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


@pytest.mark.skipif(os.name != "posix", reason="Linux hosted descriptor qualification")
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


@pytest.mark.skipif(os.name != "posix", reason="Linux hosted descriptor qualification")
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


@pytest.mark.skipif(os.name != "posix", reason="Linux hosted descriptor qualification")
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


@pytest.mark.skipif(os.name != "posix", reason="Linux hosted descriptor qualification")
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
