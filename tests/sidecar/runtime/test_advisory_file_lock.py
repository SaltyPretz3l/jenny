"""The shared OS advisory lock behind the operation and owned-process ledgers."""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from sidecar.runtime.advisory_file_lock import advisory_file_lock
from tests.sidecar._platform_skips import requires_file_symlinks


def test_a_held_lock_excludes_a_second_opener_until_released(tmp_path: Path) -> None:
    lock = tmp_path / "nested" / ".lock"
    with advisory_file_lock(lock, time.monotonic() + 1):
        started = time.monotonic()
        with pytest.raises(TimeoutError):
            with advisory_file_lock(lock, time.monotonic() + 0.2):
                pass
        assert time.monotonic() - started >= 0.2
    with advisory_file_lock(lock, time.monotonic() + 0.2):
        pass
    assert lock.is_file(), "the lock file is stable: deleting it would split the inode"


def test_a_lock_file_left_by_a_dead_holder_is_free(tmp_path: Path) -> None:
    lock = tmp_path / ".lock"
    lock.write_bytes(b"token from an older build")
    stale = time.time() - 3600
    os.utime(lock, (stale, stale))
    with advisory_file_lock(lock, time.monotonic() + 0.2):
        pass


@requires_file_symlinks()
def test_a_symlinked_lock_path_is_refused(tmp_path: Path) -> None:
    target = tmp_path / "elsewhere.txt"
    target.write_bytes(b"")
    lock = tmp_path / ".lock"
    lock.symlink_to(target)
    with pytest.raises(OSError):
        with advisory_file_lock(lock, time.monotonic() + 0.2):
            pass
    assert target.read_bytes() == b"", "the link target must not be written"
