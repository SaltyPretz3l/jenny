"""Process-owned, descriptor-relative IO for the hosted builtin tool worker.

The builtin worker configures one approved root at startup. Its descriptor is
bounded process state, replaced/closed on reconfiguration and closed by the OS
on worker exit. It is not a permission grant supplied by model arguments.
"""

from __future__ import annotations

import errno
import logging
import os
import secrets
import stat
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH, CMP_TOOL_IO_FAILED
from sidecar.ai.tools.contracts import ToolExecutionFailure

_enabled = False
_root: Path | None = None
_root_fd: int | None = None
_operation_io: ContextVar["HostedFileIOOperation | None"] = ContextVar(
    "hosted_file_io_operation", default=None
)
_O_DIRECTORY = int(getattr(os, "O_DIRECTORY", 0))
_O_NOFOLLOW = int(getattr(os, "O_NOFOLLOW", 0))
_O_NONBLOCK = int(getattr(os, "O_NONBLOCK", 0))


def _failure() -> ToolExecutionFailure:
    return ToolExecutionFailure(
        code=CMP_TOOL_INVALID_PATH,
        message="Hosted file access requires a regular single-link file in the approved workspace.",
        retryable=False,
    )


@dataclass(frozen=True)
class HostedFileIOOperation:
    enabled: bool
    root: Path | None
    root_fd: int | None


def _open_operation(
    workspace_root: str | None,
    *,
    enabled: bool,
    expected_device_id: str | None = None,
    expected_inode: str | None = None,
) -> HostedFileIOOperation:
    if not enabled or workspace_root is None:
        return HostedFileIOOperation(enabled=enabled, root=None, root_fd=None)
    if os.name != "posix":
        raise _failure()
    root = Path(workspace_root)
    if not root.is_absolute() or root != root.resolve(strict=True):
        raise _failure()
    fd = os.open(root.anchor, os.O_RDONLY | _O_DIRECTORY)
    try:
        for segment in root.parts[1:]:
            child = os.open(segment, os.O_RDONLY | _O_DIRECTORY | _O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        status = os.fstat(fd)
        if expected_device_id is not None and (
            str(status.st_dev) != expected_device_id or str(status.st_ino) != expected_inode
        ):
            raise _failure()
        return HostedFileIOOperation(enabled=True, root=root, root_fd=fd)
    except BaseException:
        os.close(fd)
        raise


@contextmanager
def scoped_hosted_file_io(
    workspace_root: str | None,
    *,
    enabled: bool,
    expected_device_id: str | None = None,
    expected_inode: str | None = None,
) -> Iterator[None]:
    """Own a pinned root descriptor for exactly one trusted tool operation."""

    operation = _open_operation(
        workspace_root,
        enabled=enabled,
        expected_device_id=expected_device_id,
        expected_inode=expected_inode,
    )
    token = _operation_io.set(operation)
    try:
        yield
    finally:
        _operation_io.reset(token)
        if operation.root_fd is not None:
            os.close(operation.root_fd)


def _active() -> HostedFileIOOperation:
    operation = _operation_io.get()
    if operation is not None:
        return operation
    return HostedFileIOOperation(enabled=_enabled, root=_root, root_fd=_root_fd)


def configure_hosted_file_io(workspace_root: str | None, *, enabled: bool) -> None:
    global _enabled, _root, _root_fd  # noqa: PLW0603 - documented process-owned root.
    if _root_fd is not None:
        os.close(_root_fd)
    _root_fd = None
    _root = None
    _enabled = enabled
    if not enabled or workspace_root is None:
        return
    if os.name != "posix":
        raise _failure()
    root = Path(workspace_root)
    if not root.is_absolute() or root != root.resolve(strict=True):
        raise _failure()
    fd = os.open(root.anchor, os.O_RDONLY | _O_DIRECTORY)
    try:
        for segment in root.parts[1:]:
            child = os.open(segment, os.O_RDONLY | _O_DIRECTORY | _O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        _root, _root_fd = root, fd
    except BaseException:
        os.close(fd)
        raise


def hosted_file_io_root() -> str | None:
    operation = _active()
    return str(operation.root) if operation.enabled and operation.root is not None else None


def hosted_file_io_enabled() -> bool:
    return _active().enabled


@contextmanager
def _parent(path: Path, *, create: bool = False) -> Iterator[tuple[int, str]]:
    operation = _active()
    root, root_fd = operation.root, operation.root_fd
    if root is None or root_fd is None:
        raise _failure()
    try:
        parts = path.relative_to(root).parts
    except ValueError as error:
        raise _failure() from error
    if not parts or any(part in {".", "..", ""} for part in parts):
        raise _failure()
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
            raise _failure() from error
        yield fd, parts[-1]
    finally:
        os.close(fd)


def _regular(status: os.stat_result) -> None:
    if not stat.S_ISREG(status.st_mode) or status.st_nlink != 1:
        raise _failure()


def _identity(row: os.stat_result | None) -> tuple[int, ...] | None:
    return (row.st_dev, row.st_ino, row.st_mode, row.st_size,
            row.st_mtime_ns, row.st_ctime_ns, row.st_nlink) if row else None


def _open_leaf(parent_fd: int, name: str) -> int:
    try:
        fd = os.open(name, os.O_RDONLY | _O_NOFOLLOW | _O_NONBLOCK, dir_fd=parent_fd)
    except ValueError as error:
        raise _failure() from error
    except OSError as error:
        # A nofollow refusal is a path rejection; device/read errors retain IO semantics.
        if error.errno in {errno.ELOOP, errno.ENXIO, errno.ENODEV}:
            raise _failure() from error
        raise
    try:
        _regular(os.fstat(fd))
        return fd
    except BaseException:
        os.close(fd)
        raise


@contextmanager
def open_regular_file(path: Path, mode: str = "rb", **kwargs: Any) -> Iterator[Any]:
    if not hosted_file_io_enabled():
        with open(path, mode, **kwargs) as handle:
            yield handle
        return
    if mode not in {"r", "rb"}:
        raise _failure()
    with _parent(path) as (parent_fd, name):
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
        raise _failure()
    if previous is None:
        return False
    with os.fdopen(_open_leaf(parent_fd, name), "rb") as handle:
        return (_identity(os.fstat(handle.fileno())) == _identity(previous)
                and handle.read(len(expected) + 1) == expected
                and _identity(os.fstat(handle.fileno())) == _identity(previous))


def write_hosted_bytes_atomic(
    path: Path, content: bytes, *, expected: bytes | None | object,
    no_expectation: object, mode: int | None,
) -> bool:
    try:
        return _replace_hosted_bytes(path, content, expected=expected,
                                     no_expectation=no_expectation, mode=mode)
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED, message="Hosted file IO failed before replacement.",
            retryable=True, error_details={"effects": "none"},
        ) from error


def _replace_hosted_bytes(
    path: Path, content: bytes, *, expected: bytes | None | object,
    no_expectation: object, mode: int | None,
) -> bool:
    """Replace a leaf relative to pinned directory descriptors, never a path reopen."""
    with _parent(path, create=True) as (parent_fd, name):
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
                    raise _failure()
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
                    raise _failure()
                return False
            temporary_status = os.stat(temporary, dir_fd=parent_fd, follow_symlinks=False)
            _regular(temporary_status)
            if _identity(temporary_status) != temporary_identity:
                raise _failure()
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
