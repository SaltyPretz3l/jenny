# new-test-file: test_hosted_file_io.py is at 531 lines; these cases for the hosted store's stat and exclusive create would pass the 600-line cap.
"""Hosted store stat after its directory closed (C8) and POSIX exclusive create (H5)."""

from __future__ import annotations

import errno
import os
import stat
from pathlib import Path

import pytest

from sidecar.ai.tools.hosted_file_io import (
    configure_hosted_file_io,
    scoped_hosted_file_io,
    write_hosted_bytes_atomic,
)
from tests.sidecar._platform_skips import posix_only

_HOSTED_POSIX = posix_only("hosted descriptor qualification: dir_fd, os.link")


@pytest.fixture(autouse=True)
def reset_host_io():
    configure_hosted_file_io(None, enabled=False)
    yield
    configure_hosted_file_io(None, enabled=False)


class _ClosedWithItsDirectory:
    """A listed entry whose `stat` fails once its directory scope closed (a closed `dir_fd`)."""

    def __init__(self, name: str, directory) -> None:
        self.name, self._directory = name, directory

    def is_dir(self, follow_symlinks: bool = False) -> bool:
        return False

    def stat(self, follow_symlinks: bool = False):
        import types
        if self._directory.closed:
            raise OSError(errno.EBADF, "closed directory descriptor")
        return types.SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_size=5, st_mtime_ns=7)


def _hosted_store_with_fake_directory(tmp_path: Path, monkeypatch, listed: str):
    import contextlib

    from sidecar.ai.tools import hosted_file_io as hosted
    from sidecar.ai.tools.hosted_file_io_store import HostedWorkspaceStore

    class Directory:
        closed = False

        def scan(self, limit: int):
            return [_ClosedWithItsDirectory(listed, self)]

    @contextlib.contextmanager
    def fake_open(path):
        directory = Directory()
        try:
            yield directory
        finally:
            directory.closed = True

    store = HostedWorkspaceStore(tmp_path)
    monkeypatch.setattr(hosted, "open_hosted_directory", fake_open)
    monkeypatch.setattr(hosted, "hosted_file_io_root", lambda: str(store._root))
    return store


def test_hosted_store_stat_describes_the_entry_before_its_directory_closes(tmp_path: Path, monkeypatch) -> None:
    from sidecar.ai.tools.workspace_store import WorkspaceStoreKind

    store = _hosted_store_with_fake_directory(tmp_path, monkeypatch, "note.md")
    ref = store.resolve(WorkspaceStoreKind.ARTIFACTS, ("note.md",))
    found = store.stat(ref)
    assert found is not None, "stat read the entry after its directory descriptor closed"
    assert (found.is_directory, found.size_bytes, found.mtime_ns) == (False, 5, 7)
    assert store.exists(ref) is True


def test_hosted_store_name_match_is_case_insensitive_only_on_windows(tmp_path: Path, monkeypatch) -> None:
    from sidecar.ai.tools.workspace_store import WorkspaceStoreKind

    store = _hosted_store_with_fake_directory(tmp_path, monkeypatch, "README.MD")
    ref = store.resolve(WorkspaceStoreKind.ARTIFACTS, ("readme.md",))
    assert (store.stat(ref) is not None) is (os.name == "nt")


@_HOSTED_POSIX
def test_hosted_store_stat_of_a_regular_file_in_jenny_on_posix(tmp_path: Path) -> None:
    from sidecar.ai.tools.hosted_file_io_store import HostedWorkspaceStore
    from sidecar.ai.tools.workspace_store import WorkspaceStoreKind

    (tmp_path / ".jenny" / "artifacts").mkdir(parents=True)
    (tmp_path / ".jenny" / "artifacts" / "a.md").write_bytes(b"hello")
    with scoped_hosted_file_io(str(tmp_path), enabled=True):
        store = HostedWorkspaceStore(tmp_path)
        found = store.stat(store.resolve(WorkspaceStoreKind.ARTIFACTS, ("a.md",)))
    assert found is not None and found.size_bytes == 5 and found.is_directory is False


@_HOSTED_POSIX
def test_exclusive_create_never_clobbers_a_name_that_appears_before_publish(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "lock.txt"
    configure_hosted_file_io(str(tmp_path), enabled=True)
    real_link, real_replace = os.link, os.replace
    raced: list[bool] = []

    def compete(real):
        def call(source, destination, **kwargs):
            if not raced:
                raced.append(True)
                target.write_bytes(b"competitor")
            return real(source, destination, **kwargs)
        return call

    monkeypatch.setattr(os, "link", compete(real_link))
    monkeypatch.setattr(os, "replace", compete(real_replace))
    sentinel = object()
    assert write_hosted_bytes_atomic(target, b"mine", expected=None, no_expectation=sentinel, mode=None) is False
    assert target.read_bytes() == b"competitor"
    assert [p.name for p in tmp_path.iterdir()] == ["lock.txt"], "temporary file left behind"


@_HOSTED_POSIX
def test_exclusive_create_publishes_one_link_and_replace_still_uses_replace(tmp_path: Path) -> None:
    target = tmp_path / "fresh.txt"
    configure_hosted_file_io(str(tmp_path), enabled=True)
    sentinel = object()
    assert write_hosted_bytes_atomic(target, b"one", expected=None, no_expectation=sentinel, mode=0o640)
    assert target.read_bytes() == b"one" and target.stat().st_nlink == 1
    assert write_hosted_bytes_atomic(target, b"two", expected=b"one", no_expectation=sentinel, mode=None)
    assert target.read_bytes() == b"two"
    assert [p.name for p in tmp_path.iterdir()] == ["fresh.txt"]
