"""Identity-checked atomic replacement for workspace text mutators."""

from __future__ import annotations

import os
import stat as stat_module
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace_path_identity import NodeIdentity, is_link_object

if TYPE_CHECKING:
    from sidecar.ai.tools.workspace import WorkspaceGuard

_NO_EXPECTATION = object()


class _ExpectedCurrentMismatch(Exception):
    """Internal control flow for a non-destructive compare mismatch."""


def write_bytes_atomic(
    path: Path,
    content: bytes,
    *,
    workspace: WorkspaceGuard | None = None,
) -> None:
    """Atomically replace ``path`` while refusing parent/leaf identity drift."""

    _write_bytes_atomic(
        path,
        content,
        workspace=workspace,
        expected_current_bytes=_NO_EXPECTATION,
        mode=None,
    )


def write_bytes_atomic_if_matches(
    path: Path,
    content: bytes,
    *,
    expected_current_bytes: bytes | None,
    workspace: WorkspaceGuard | None = None,
    mode: int | None = None,
) -> bool:
    """Replace only the captured postimage; ``None`` requires a missing target.

    This is the rollback compare-and-replace seam. A mismatched or replaced
    postimage is preserved and reported to the caller as ``False``.
    """

    return _write_bytes_atomic(
        path,
        content,
        workspace=workspace,
        expected_current_bytes=expected_current_bytes,
        mode=mode,
    )


def _write_bytes_atomic(
    path: Path,
    content: bytes,
    *,
    workspace: WorkspaceGuard | None,
    expected_current_bytes: bytes | None | object,
    mode: int | None,
) -> bool:
    try:
        parent_identity, leaf_identity, target_mode = _prepare_atomic_target(
            path,
            workspace=workspace,
            expected_current_bytes=expected_current_bytes,
            mode=mode,
        )
    except _ExpectedCurrentMismatch:
        return False

    try:
        fd, temp_name = tempfile.mkstemp(
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=str(path.parent),
        )
    except OSError as error:
        raise _failure(f"failed to create temporary file: {error}") from error
    temp_path = Path(temp_name)
    temp_identity: NodeIdentity | None = None
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
            temp_identity = NodeIdentity.from_stat(os.fstat(handle.fileno()))
        _revalidate_parent_and_temp(
            path.parent,
            parent_identity,
            temp_path,
            temp_identity,
        )
        if target_mode is not None:
            os.chmod(temp_path, target_mode)
        if workspace is not None:
            workspace.ensure_safe_mutation_path(path)

        _before_atomic_replace(path)
        _revalidate_parent_and_temp(
            path.parent,
            parent_identity,
            temp_path,
            temp_identity,
        )
        if not _replacement_allowed(
            path,
            expected_current_bytes=expected_current_bytes,
            captured_identity=leaf_identity,
        ):
            _unlink_temp_if_identity(temp_path, temp_identity, parent_identity)
            return False
        os.replace(temp_path, path)
    except ToolExecutionFailure:
        _unlink_temp_if_identity(temp_path, temp_identity, parent_identity)
        raise
    except OSError as error:
        _unlink_temp_if_identity(temp_path, temp_identity, parent_identity)
        raise _failure(f"failed to write file: {error}") from error
    return True


def _prepare_atomic_target(
    path: Path,
    *,
    workspace: WorkspaceGuard | None,
    expected_current_bytes: bytes | None | object,
    mode: int | None,
) -> tuple[NodeIdentity, NodeIdentity | None, int | None]:
    if workspace is not None:
        workspace.ensure_safe_mutation_path(path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise _failure(f"failed to create parent directory: {error}") from error
    if workspace is not None:
        workspace.ensure_safe_mutation_path(path)

    parent_identity = _required_identity(path.parent, "atomic write parent")
    leaf_identity = _optional_identity(path)
    if leaf_identity is not None and not stat_module.S_ISREG(leaf_identity.mode):
        raise _failure("atomic write target is not a regular file", retryable=False)
    if expected_current_bytes is not _NO_EXPECTATION and not _matches_expected_current(
        path,
        expected_current_bytes,
        leaf_identity,
    ):
        raise _ExpectedCurrentMismatch
    existing_mode = (
        stat_module.S_IMODE(leaf_identity.mode) if leaf_identity is not None else None
    )
    return parent_identity, leaf_identity, mode if mode is not None else existing_mode


def _replacement_allowed(
    path: Path,
    *,
    expected_current_bytes: bytes | None | object,
    captured_identity: NodeIdentity | None,
) -> bool:
    if expected_current_bytes is _NO_EXPECTATION:
        _require_unchanged_leaf(path, captured_identity)
        return True
    return _matches_expected_current(path, expected_current_bytes, captured_identity)


def _matches_expected_current(
    path: Path,
    expected: bytes | None | object,
    captured_identity: NodeIdentity | None,
) -> bool:
    current = _optional_identity(path)
    if expected is None:
        return captured_identity is None and current is None
    if (
        not isinstance(expected, bytes)
        or current is None
        or current != captured_identity
        or is_link_object(path)
        or not stat_module.S_ISREG(current.mode)
        or current.size != len(expected)
    ):
        return False
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(str(path), flags)
    except OSError:
        return False
    try:
        opened = NodeIdentity.from_stat(os.fstat(fd))
        data = os.read(fd, len(expected) + 1)
        return (
            opened == current
            and data == expected
            and NodeIdentity.from_stat(os.fstat(fd)) == opened
        )
    except OSError:
        return False
    finally:
        os.close(fd)


def _require_unchanged_leaf(path: Path, expected: NodeIdentity | None) -> None:
    current = _optional_identity(path)
    if current != expected or (current is not None and is_link_object(path)):
        raise _failure("atomic write target changed before replacement")


def _revalidate_parent_and_temp(
    parent: Path,
    expected_parent: NodeIdentity,
    temp_path: Path,
    expected_temp: NodeIdentity,
) -> None:
    current_parent = _required_identity(parent, "atomic write parent")
    current_temp = _optional_identity(temp_path)
    if (
        not current_parent.same_object(expected_parent)
        or is_link_object(parent)
        or current_temp is None
        or not current_temp.same_object(expected_temp)
        or is_link_object(temp_path)
    ):
        raise _failure("atomic write path identity changed before replacement")


def _required_identity(path: Path, label: str) -> NodeIdentity:
    try:
        return NodeIdentity.from_stat(path.stat(follow_symlinks=False))
    except OSError as error:
        raise _failure(f"failed to inspect {label}") from error


def _optional_identity(path: Path) -> NodeIdentity | None:
    try:
        return NodeIdentity.from_stat(path.lstat())
    except FileNotFoundError:
        return None
    except OSError as error:
        raise _failure("failed to inspect atomic write target") from error


def _unlink_temp_if_identity(
    path: Path,
    expected: NodeIdentity | None,
    expected_parent: NodeIdentity,
) -> None:
    if expected is None:
        return
    try:
        parent = _required_identity(path.parent, "atomic write temp parent")
        current = _optional_identity(path)
        if (
            parent.same_object(expected_parent)
            and current is not None
            and current.same_object(expected)
        ):
            path.unlink()
    except (OSError, ToolExecutionFailure):
        return


def _before_atomic_replace(_path: Path) -> None:
    """Deterministic test seam after policy validation and before replacement."""


def _failure(message: str, *, retryable: bool = True) -> ToolExecutionFailure:
    return ToolExecutionFailure(code=CMP_TOOL_IO_FAILED, message=message, retryable=retryable)


__all__ = ["write_bytes_atomic", "write_bytes_atomic_if_matches"]
