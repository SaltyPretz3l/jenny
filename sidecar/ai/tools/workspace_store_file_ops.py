"""Low-level regular-file primitives for the guarded workspace store."""

from __future__ import annotations

import os
import stat as stat_module
from pathlib import Path

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace_path_identity import NodeIdentity


def create_empty_regular_leaf(path: Path) -> NodeIdentity:
    """Create one empty leaf without following an existing link object."""

    parent_identity = _identity(path.parent)
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_BINARY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    fd: int | None = None
    created_identity: NodeIdentity | None = None
    try:
        fd = os.open(str(path), flags, 0o600)
        created_identity = NodeIdentity.from_stat(os.fstat(fd))
        if not stat_module.S_ISREG(created_identity.mode):
            raise _failure("workspace store database target is not a file")
        os.fsync(fd)
    except FileExistsError as error:
        raise _failure("workspace store database leaf appeared during creation") from error
    except ToolExecutionFailure:
        if fd is not None:
            os.close(fd)
            fd = None
        _cleanup_created(path, created_identity, parent_identity)
        raise
    except OSError as error:
        if fd is not None:
            os.close(fd)
            fd = None
        _cleanup_created(path, created_identity, parent_identity)
        raise _failure("workspace store database creation failed") from error
    finally:
        if fd is not None:
            os.close(fd)
    fsync_directory(path.parent)
    if created_identity is None:
        raise _failure("workspace store database identity is unavailable")
    return created_identity


def link_exclusive(source: Path, destination: Path) -> None:
    """Publish *source* without overwrite or an ambiguous unsupported error."""

    try:
        os.link(source, destination)
    except FileExistsError:
        raise
    except OSError as error:
        raise _failure(
            "workspace store exclusive write requires hard-link support"
        ) from error


def fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    try:
        fd = os.open(str(path), flags)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _cleanup_created(
    path: Path,
    expected: NodeIdentity | None,
    expected_parent: NodeIdentity,
) -> None:
    if expected is None:
        return
    try:
        parent_now = _identity(path.parent)
        current = NodeIdentity.from_stat(path.lstat())
        if parent_now.same_object(expected_parent) and current.same_object(expected):
            path.unlink()
    except OSError:
        return


def _identity(path: Path) -> NodeIdentity:
    try:
        return NodeIdentity.from_stat(path.stat(follow_symlinks=False))
    except OSError as error:
        raise _failure("workspace store identity probe failed") from error


def _failure(message: str) -> ToolExecutionFailure:
    return ToolExecutionFailure(code=CMP_TOOL_IO_FAILED, message=message, retryable=True)


__all__ = ["create_empty_regular_leaf", "fsync_directory", "link_exclusive"]
