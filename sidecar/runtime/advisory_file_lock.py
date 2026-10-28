"""Cross-process exclusive lock on a stable sibling file, released by the OS.

The kernel drops the lock when its holder's handle closes or the process dies
(even SIGKILL), so there is no staleness rule and no takeover race. The lock
file itself is never deleted: removing it would let a second opener lock a new
inode while the first still holds the old one.
"""

from __future__ import annotations

import errno
import os
import stat as stat_module
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterator

_CONTENTION = {
    errno.EAGAIN,
    errno.EWOULDBLOCK,
    errno.EACCES,
    getattr(errno, "EDEADLOCK", errno.EDEADLK),
}
_POLL_SECONDS = 0.01


@contextmanager
def advisory_file_lock(
    path: Path, deadline: float, *, poll_seconds: float = _POLL_SECONDS
) -> Iterator[None]:
    """Hold an exclusive lock on ``path`` until the block exits.

    ``deadline`` is a ``time.monotonic()`` value; contention past it, or a lock
    the platform cannot take, raises TimeoutError. The file is opened without
    following a final symlink and must be a regular file.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    fd = os.open(str(path), flags, 0o600)
    try:
        _require_regular_file(fd, path)
        lock, unlock = _lock_functions(fd)
        while True:
            try:
                lock()
                break
            except OSError as error:
                # Only contention is worth waiting for; an unsupported lock fails now.
                if error.errno not in _CONTENTION or time.monotonic() >= deadline:
                    raise TimeoutError(f"lock unavailable: {path.name}") from None
                time.sleep(poll_seconds)
        try:
            yield
        finally:
            unlock()
    finally:
        os.close(fd)


def _require_regular_file(fd: int, path: Path) -> None:
    # Windows has no O_NOFOLLOW: refuse a handle that is not the plain file
    # the directory entry names (a link or reparse point swapped in).
    opened = os.fstat(fd)
    named = os.lstat(path)
    if not stat_module.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (
        named.st_dev,
        named.st_ino,
    ):
        raise OSError(errno.ELOOP, "lock path is not a regular file", str(path))


def _lock_functions(fd: int) -> tuple[Callable[[], None], Callable[[], None]]:
    if os.name == "nt":
        import msvcrt

        # msvcrt locks a byte range from the current position; give it one byte.
        if os.fstat(fd).st_size == 0:
            os.write(fd, b"0")

        def lock() -> None:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)

        def unlock() -> None:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)

        return lock, unlock

    import fcntl

    flock = getattr(fcntl, "flock", None)
    if not callable(flock):
        raise OSError(errno.ENOLCK, "POSIX locking unavailable")
    exclusive = getattr(fcntl, "LOCK_EX", 0) | getattr(fcntl, "LOCK_NB", 0)
    release = getattr(fcntl, "LOCK_UN", 0)
    return (lambda: flock(fd, exclusive)), (lambda: flock(fd, release))
