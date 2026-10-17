"""Guarded workspace I/O for Undo/Redo restore (journal v1).

Every write, move and removal a restore performs re-checks, immediately before
the operation, that the parent directory is still the one validated inside the
workspace: a pinned ``dir_fd`` on POSIX, an identity and link re-check on
Windows, where a directory is created relative to a held parent handle
(``workspace_restore_win32``). New regular files go through the guarded
compare-and-replace primitive in ``file_atomic_write``; a directory is rebuilt
one level at a time under the same pinned parents. A restore binds its
workspace guard once (``bound_workspace``); I/O without a bound guard fails
closed.
"""

from __future__ import annotations

import os
import shutil
import stat
import sys
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Iterator

from sidecar.ai.tools import workspace_restore_win32 as _win32
from sidecar.ai.tools.builtins.file_atomic_write import write_bytes_atomic_if_matches
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_path_identity import NodeIdentity, is_link_object

# os.replace shares renameat with os.rename; CPython registers only os.rename.
_DIR_FD = all(
    op in os.supports_dir_fd
    for op in (os.open, os.rename, os.unlink, os.rmdir, os.stat, os.mkdir, os.symlink)
)
_ACTIVE_GUARD: ContextVar[WorkspaceGuard | None] = ContextVar("restore_guard", default=None)


class RestorePathUnsafe(RuntimeError):
    """A restore path changed identity or left the workspace before its I/O."""

    reason = "restore_path_unsafe"

    def __init__(self, message: str, *, left_in_place: str | None = None) -> None:
        super().__init__(message)
        self.details: dict[str, object] = {}
        if left_in_place is not None:
            self.details["left_in_place"] = left_in_place


@contextmanager
def bound_workspace(root: Path) -> Iterator[None]:
    token = _ACTIVE_GUARD.set(WorkspaceGuard(str(root)))
    try:
        yield
    finally:
        _ACTIVE_GUARD.reset(token)


def _guard() -> WorkspaceGuard:
    guard = _ACTIVE_GUARD.get()
    if guard is None or guard.root is None:
        raise RestorePathUnsafe("Restore I/O ran without a workspace guard.")
    return guard


def _validate_parent(path: Path) -> None:
    guard = _guard()
    try:
        if path.parent != guard.root:
            guard.ensure_safe_mutation_path(path.parent)
    except ToolExecutionFailure as error:
        raise RestorePathUnsafe("Restore path left the workspace.") from error


def _pin(path: Path) -> tuple[NodeIdentity, int | None]:
    """Validate ``path``'s parent and capture its identity (and fd on POSIX)."""
    _validate_parent(path)
    try:
        identity = NodeIdentity.from_stat(path.parent.lstat())
    except OSError as error:
        raise RestorePathUnsafe("Restore path parent is unavailable.") from error
    if not stat.S_ISDIR(identity.mode) or _is_link(path.parent):
        raise RestorePathUnsafe("Restore path parent is not a directory.")
    descriptor: int | None = None
    if _DIR_FD:
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(str(path.parent), flags | getattr(os, "O_CLOEXEC", 0))
        except OSError as error:
            raise RestorePathUnsafe("Restore path parent changed.") from error
        if not NodeIdentity.from_stat(os.fstat(descriptor)).same_object(identity):
            os.close(descriptor)
            raise RestorePathUnsafe("Restore path parent changed.")
    try:
        _validate_parent(path)
    except RestorePathUnsafe:
        if descriptor is not None:
            os.close(descriptor)
        raise
    return identity, descriptor


def _recheck(path: Path, identity: NodeIdentity) -> None:
    try:
        current = NodeIdentity.from_stat(path.parent.lstat())
    except OSError as error:
        raise RestorePathUnsafe("Restore path parent changed.") from error
    if not current.same_object(identity) or _is_link(path.parent):
        raise RestorePathUnsafe("Restore path parent changed.")
    _validate_parent(path)


def _is_link(path: Path) -> bool:
    try:
        return is_link_object(path)
    except ToolExecutionFailure:
        return True


def _before_restore_io(_path: Path) -> None:
    """Deterministic test seam after validation and before the guarded operation."""


def make_parents(path: Path) -> None:
    _validate_parent(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    _validate_parent(path)


def replace(source: Path, target: Path) -> None:
    """``os.replace`` under pinned source and target parents."""
    source_identity, source_fd = _pin(source)
    try:
        target_identity, target_fd = _pin(target)
        try:
            _before_restore_io(target)
            _recheck(source, source_identity)
            _recheck(target, target_identity)
            if source_fd is None or target_fd is None:
                os.replace(source, target)
            else:
                os.replace(source.name, target.name, src_dir_fd=source_fd, dst_dir_fd=target_fd)
        finally:
            if target_fd is not None:
                os.close(target_fd)
    finally:
        if source_fd is not None:
            os.close(source_fd)
    fsync_directory(target.parent)
    if source.parent != target.parent:
        fsync_directory(source.parent)


def remove(path: Path) -> None:
    """Remove a link, file or tree at ``path``; a missing path is a no-op."""
    if not path.parent.is_symlink() and not path.parent.exists():
        return
    identity, descriptor = _pin(path)
    try:
        _before_restore_io(path)
        _recheck(path, identity)
        name: str | Path = path if descriptor is None else path.name
        try:
            mode = os.stat(name, dir_fd=descriptor, follow_symlinks=False).st_mode
        except FileNotFoundError:
            return
        if stat.S_ISDIR(mode) and _is_link(path):
            os.rmdir(name, dir_fd=descriptor)  # a directory junction: remove the link only
        elif stat.S_ISDIR(mode):
            if descriptor is None:
                shutil.rmtree(path)
            else:
                shutil.rmtree(path.name, dir_fd=descriptor)
        else:
            os.unlink(name, dir_fd=descriptor)
    finally:
        if descriptor is not None:
            os.close(descriptor)
    fsync_directory(path.parent)


def rmdir(path: Path) -> None:
    identity, descriptor = _pin(path)
    try:
        _before_restore_io(path)
        _recheck(path, identity)
        os.rmdir(path if descriptor is None else path.name, dir_fd=descriptor)
    finally:
        if descriptor is not None:
            os.close(descriptor)
    fsync_directory(path.parent)


def copy_new(source: Path, destination: Path) -> None:
    """Materialize ``source`` at the new path ``destination`` inside the workspace."""
    source_stat = source.lstat()
    if stat.S_ISREG(source_stat.st_mode):
        data = _read_regular(source)
        _validate_parent(destination)
        try:
            created = write_bytes_atomic_if_matches(
                destination, data, expected_current_bytes=None, workspace=_guard(),
                mode=stat.S_IMODE(source_stat.st_mode),
            )
        except ToolExecutionFailure as error:
            raise RestorePathUnsafe("Restore path changed before the write.") from error
        if not created:
            raise FileExistsError(str(destination))
        return
    if not stat.S_ISDIR(source_stat.st_mode) or _is_link(source):
        raise ValueError("recovery object type is unsupported")
    make_parents(destination)
    _copy_tree(source, destination)
    fsync_directory(destination.parent)


def _copy_tree(source: Path, destination: Path) -> None:
    """Rebuild a directory; never a pathname copy below an unchecked parent.

    It stays owner-only (0700) while it fills and takes the source's mode last.
    """
    directory_mode = stat.S_IMODE(source.lstat().st_mode)
    _create_pinned(destination)
    with os.scandir(source) as listing:
        entries = sorted(listing, key=lambda entry: entry.name)
    for entry in entries:
        child, target = Path(entry.path), destination / entry.name
        mode = child.lstat().st_mode
        if stat.S_ISLNK(mode):
            _create_pinned(target, link=os.readlink(child))
        elif stat.S_ISDIR(mode) and not _is_link(child):
            _copy_tree(child, target)
        elif stat.S_ISREG(mode):
            copy_new(child, target)
        else:
            raise ValueError("recovery object type is unsupported")
    _set_directory_mode(destination, directory_mode)
    fsync_directory(destination)


def _set_directory_mode(path: Path, mode: int) -> None:
    """chmod the directory just rebuilt, through its own handle on POSIX."""
    if sys.platform == "win32":
        # Windows directories carry no POSIX mode: the read-only attribute
        # os.chmod would set does not restrict writes beneath a directory, and
        # setting it by pathname is the unpinned I/O this module avoids.
        return
    identity, descriptor = _pin(path)
    try:
        _recheck(path, identity)
        if descriptor is None:
            os.chmod(path, mode)
            return
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        handle = os.open(path.name, flags, dir_fd=descriptor)
        try:
            os.fchmod(handle, mode)
        finally:
            os.close(handle)
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _create_pinned(path: Path, *, link: str | None = None) -> None:
    """Create a directory (or the symlink ``link``) under the pinned, re-checked parent.

    A parent that changed during the create is detected before anything is
    written beneath it, and the node is removed through a handle: the pinned
    parent ``dir_fd`` on POSIX, the created directory's own handle on Windows.
    Without either no pathname can prove what was created, so the node is left
    in place and the error says so.
    """
    identity, descriptor = _pin(path)
    if descriptor is None and sys.platform == "win32":
        _create_pinned_win32(path, identity, link)
        return
    name: str | Path = path if descriptor is None else path.name
    try:
        _recheck(path, identity)
        _before_restore_io(path)  # the window between the last check and the create
        if link is None:
            os.mkdir(name, 0o700, dir_fd=descriptor)
        else:
            os.symlink(link, name, dir_fd=descriptor)
        if descriptor is None:
            try:
                _recheck(path, identity)
            except RestorePathUnsafe as error:
                message = f"Restore path parent changed once {path.name} existed; left in place."
                raise RestorePathUnsafe(message, left_in_place=path.name) from error
            return
        created = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
        try:
            _recheck(path, identity)
        except RestorePathUnsafe:
            current = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            if NodeIdentity.from_stat(current).same_object(NodeIdentity.from_stat(created)):
                (os.unlink if stat.S_ISLNK(created.st_mode) else os.rmdir)(name, dir_fd=descriptor)
            raise
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _create_pinned_win32(path: Path, identity: NodeIdentity, link: str | None) -> None:
    """Create relative to a held parent handle; a failed re-check deletes by handle."""
    if link is not None:
        raise RestorePathUnsafe(
            "Restore cannot create a link under a Windows parent without handle-relative proof."
        )
    try:
        parent = _win32.open_directory_handle(path.parent, identity)
    except OSError as error:
        raise RestorePathUnsafe("Restore path parent changed.") from error
    try:
        _recheck(path, identity)
        _before_restore_io(path)  # the window between the last check and the create
        created = _win32.create_directory_relative(parent, path.name)
        try:
            # The parent pathname must still name the directory the handle holds.
            _recheck(path, _win32.handle_identity(parent))
        except (RestorePathUnsafe, OSError) as error:
            try:
                _win32.delete_by_handle(created)
            except OSError as delete_error:
                message = (
                    f"Restore path parent changed once {path.name} existed; "
                    "deleting it failed, so it was left in place."
                )
                raise RestorePathUnsafe(message, left_in_place=path.name) from delete_error
            raise error
        finally:
            _win32.close_handle(created)
    finally:
        _win32.close_handle(parent)


def _read_regular(path: Path) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(str(path), flags)
    with os.fdopen(descriptor, "rb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError("recovery object is not a regular file")
        return handle.read()


def fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    try:
        descriptor = os.open(str(path), flags)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


__all__ = [
    "RestorePathUnsafe", "bound_workspace", "copy_new", "fsync_directory",
    "make_parents", "remove", "replace", "rmdir",
]
