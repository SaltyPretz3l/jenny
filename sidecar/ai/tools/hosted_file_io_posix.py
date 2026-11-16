"""POSIX backend for hosted file IO: no-follow, descriptor-relative IO.

The facade (`hosted_file_io.py`) owns process state and the public functions;
this module owns the descriptor walk. Its pin is an open directory
descriptor, closed by `PosixPin.close`. It is imported only after the facade's
`select_backend` picks it, and it must not import Electron or renderer code.
"""

from __future__ import annotations

import errno
import logging
import os
import secrets
import stat
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
from itertools import islice
from pathlib import Path
from typing import Any, Iterator

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.hosted_file_io import HostedEntry, HostedPin, path_failure

_O_DIRECTORY = int(getattr(os, "O_DIRECTORY", 0))
_O_NOFOLLOW = int(getattr(os, "O_NOFOLLOW", 0))
_O_NONBLOCK = int(getattr(os, "O_NONBLOCK", 0))


@dataclass(frozen=True)
class PosixPin:
    """The pinned root: one open directory descriptor owned by the holder."""

    fd: int

    def close(self) -> None:
        os.close(self.fd)


@dataclass
class PosixDirectory:
    """A directory descriptor reached by no-follow traversal.

    Entries from `scan` stay valid only while `open_directory` is open: their
    `stat()` is descriptor-relative, so callers render before the scope exits.
    """

    fd: int
    _scans: ExitStack = field(init=False, default_factory=ExitStack, repr=False)
    _scanned: bool = field(init=False, default=False, repr=False)

    def scan(self, limit: int) -> list[HostedEntry]:
        """One call per directory scope: duplicated descriptors share one offset."""
        if self._scanned:
            raise path_failure()
        self._scanned = True
        # The iterator stays open until `close`, as it did when the caller owned it.
        iterator = self._scans.enter_context(os.scandir(self.fd))
        return list(islice(iterator, limit))

    def close(self) -> None:
        self._scans.close()


def _pinned_fd(pin: HostedPin) -> int:
    if not isinstance(pin, PosixPin):
        raise path_failure()
    return pin.fd


def unavailable_reason(root: Path | None = None, expected_device_id: str | None = None,
                       expected_inode: str | None = None) -> str | None:
    """W11: the POSIX backend is always available; a bad root fails at the pin."""
    return None


def open_root(
    root: Path, expected_device_id: str | None, expected_inode: str | None
) -> PosixPin:
    """Pin `root`, which must be absolute and equal to its own resolved path."""
    if not root.is_absolute() or root != root.resolve(strict=True):
        raise path_failure()
    fd = os.open(root.anchor, os.O_RDONLY | _O_DIRECTORY)
    try:
        for segment in root.parts[1:]:
            child = os.open(segment, os.O_RDONLY | _O_DIRECTORY | _O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        if expected_device_id is not None:
            status = os.fstat(fd)
            if str(status.st_dev) != expected_device_id or str(status.st_ino) != expected_inode:
                raise path_failure()
        return PosixPin(fd)
    except BaseException:
        os.close(fd)
        raise


@contextmanager
def _parent(
    pin: HostedPin, root: Path, path: Path, *, create: bool = False
) -> Iterator[tuple[int, str]]:
    root_fd = _pinned_fd(pin)
    try:
        parts = path.relative_to(root).parts
    except ValueError as error:
        raise path_failure() from error
    if not parts or any(part in {".", "..", ""} for part in parts):
        raise path_failure()
    fd = os.dup(root_fd)
    try:
        try:
            for segment in parts[:-1]:
                if create:
                    try:
                        os.mkdir(segment, 0o700, dir_fd=fd)
                    except FileExistsError:
                        pass
                child = os.open(segment, os.O_RDONLY | _O_DIRECTORY | _O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
        except (OSError, ValueError) as error:
            raise path_failure() from error
        yield fd, parts[-1]
    finally:
        os.close(fd)


@contextmanager
def open_directory(pin: HostedPin, root: Path, path: Path) -> Iterator[PosixDirectory]:
    """Yield a directory reached by no-follow descriptor-relative traversal."""
    root_fd = _pinned_fd(pin)
    try:
        parts = path.relative_to(root).parts
    except ValueError as error:
        raise path_failure() from error
    if any(part in {".", "..", ""} for part in parts):
        raise path_failure()
    fd = os.dup(root_fd)
    try:
        try:
            for segment in parts:
                child = os.open(segment, os.O_RDONLY | _O_DIRECTORY | _O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
        except (OSError, ValueError) as error:
            raise path_failure() from error
        directory = PosixDirectory(fd)
        try:
            yield directory
        finally:
            directory.close()
    finally:
        os.close(fd)


def _regular(status: os.stat_result) -> None:
    if not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
        raise path_failure()


def _identity(row: os.stat_result | None) -> tuple[int, ...] | None:
    return (row.st_dev, row.st_ino, row.st_mode, row.st_size,
            row.st_mtime_ns, row.st_ctime_ns, row.st_nlink) if row else None


def _open_leaf(parent_fd: int, name: str) -> int:
    try:
        fd = os.open(name, os.O_RDONLY | _O_NOFOLLOW | _O_NONBLOCK, dir_fd=parent_fd)
    except ValueError as error:
        raise path_failure() from error
    except OSError as error:
        # A nofollow refusal is a path rejection; device/read errors retain IO semantics.
        if error.errno in {errno.ELOOP, errno.ENXIO, errno.ENODEV}:
            raise path_failure() from error
        raise
    try:
        _regular(os.fstat(fd))
        return fd
    except BaseException:
        os.close(fd)
        raise


@contextmanager
def open_file(
    pin: HostedPin, root: Path, path: Path, mode: str, **kwargs: Any
) -> Iterator[Any]:
    with _parent(pin, root, path) as (parent_fd, name):
        fd = _open_leaf(parent_fd, name)
        with os.fdopen(fd, mode, **kwargs) as handle:
            yield handle
            _regular(os.fstat(handle.fileno()))


def _matches_expected(parent_fd: int, name: str, previous: os.stat_result | None,
                      expected: bytes | None | object, no_expectation: object) -> bool:
    if expected is None:
        return previous is None
    if expected is no_expectation:
        return True
    if not isinstance(expected, bytes):
        raise path_failure()
    if previous is None:
        return False
    with os.fdopen(_open_leaf(parent_fd, name), "rb") as handle:
        return (_identity(os.fstat(handle.fileno())) == _identity(previous)
                and handle.read(len(expected) + 1) == expected
                and _identity(os.fstat(handle.fileno())) == _identity(previous))


def write_atomic(  # noqa: PLR0913
    pin: HostedPin, root: Path, path: Path, content: bytes, expected: bytes | None | object,
    no_expectation: object, mode: int | None,
) -> bool:
    """Replace a leaf relative to pinned directory descriptors, never a path reopen."""
    with _parent(pin, root, path, create=True) as (parent_fd, name):
        try:
            previous = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            _regular(previous)
        except FileNotFoundError:
            previous = None
        if not _matches_expected(parent_fd, name, previous, expected, no_expectation):
            return False
        temporary = f".host-{secrets.token_hex(16)}.tmp"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _O_NOFOLLOW,
                     0o600, dir_fd=parent_fd)
        created = os.fstat(fd)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(content)
                handle.flush()
                target_mode = (mode if mode is not None else
                               stat.S_IMODE(previous.st_mode) if previous else 0o600)
                fchmod = getattr(os, "fchmod", None)
                if not callable(fchmod):
                    raise path_failure()
                fchmod(handle.fileno(), target_mode & 0o777)
                os.fsync(handle.fileno())
                temporary_identity = _identity(os.fstat(handle.fileno()))
            try:
                current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                _regular(current)
            except FileNotFoundError:
                current = None
            if _identity(current) != _identity(previous):
                if expected is no_expectation:
                    raise path_failure()
                return False
            temporary_status = os.stat(temporary, dir_fd=parent_fd, follow_symlinks=False)
            _regular(temporary_status)
            if _identity(temporary_status) != temporary_identity:
                raise path_failure()
            os.replace(temporary, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            try:
                os.fsync(parent_fd)
            except OSError as error:
                raise ToolExecutionFailure(
                    code=CMP_TOOL_IO_FAILED,
                    message=("File replacement applied; durability could not be confirmed. "
                             "Re-read before retrying."),
                    retryable=False, error_details={"effects": "applied_durability_uncertain"},
                ) from error
            return True
        finally:
            _cleanup_temporary(parent_fd, temporary, created)


def remove(pin: HostedPin, root: Path, path: Path) -> bool:
    """Unlink one non-directory leaf relative to the pinned parent descriptor; a
    symlink is removed as itself, never followed. False when it is absent."""
    with _parent(pin, root, path) as (parent_fd, name):
        try:
            status = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            return False
        if stat.S_ISDIR(status.st_mode):
            raise path_failure()
        os.unlink(name, dir_fd=parent_fd)
        return True


def _cleanup_temporary(parent_fd: int, name: str, created: os.stat_result) -> None:
    try:
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (current.st_dev, current.st_ino) == (created.st_dev, created.st_ino):
            os.unlink(name, dir_fd=parent_fd)
    except FileNotFoundError:
        pass
    except OSError:
        # Cleanup must not turn an applied replacement into a false failure.
        logging.getLogger(__name__).warning("hosted_file.temporary_cleanup_failed")
