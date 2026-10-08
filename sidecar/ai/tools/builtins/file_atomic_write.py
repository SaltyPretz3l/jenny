"""Identity-checked atomic replacement for workspace text mutators."""

from __future__ import annotations

import codecs
import hashlib
import os
import secrets
import stat as stat_module
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.hosted_file_io import hosted_file_io_enabled, write_hosted_bytes_atomic
from sidecar.ai.tools.workspace_path_identity import NodeIdentity, is_link_object

if TYPE_CHECKING:
    from sidecar.ai.tools.builtins.file_history import CheckpointInfo
    from sidecar.ai.tools.workspace import WorkspaceGuard

_NO_EXPECTATION = object()
_TEMP_CREATE_ATTEMPTS = 8


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


def write_hosted_bytes_after_read(
    path: Path,
    content: bytes,
    *,
    expected: bytes | None,
    workspace: WorkspaceGuard | None = None,
) -> None:
    """Bind a mutation to the bytes validated before checkpoint work."""
    if not write_bytes_atomic_if_matches(
        path,
        content,
        expected_current_bytes=expected,
        workspace=workspace,
    ):
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=("File changed after validation; no replacement was applied. "
                     "Re-read before retrying."),
            retryable=False, error_details={"effects": "none", "content_changed": "true"},
        )


def write_edit_bytes_after_read(
    path: Path, content: bytes, *, expected: bytes, workspace: WorkspaceGuard,
) -> None:
    """Apply an edit through the host-specific mutation contract."""
    write_hosted_bytes_after_read(
        path,
        content,
        expected=expected,
        workspace=workspace,
    )


def _write_bytes_atomic(
    path: Path,
    content: bytes,
    *,
    workspace: WorkspaceGuard | None,
    expected_current_bytes: bytes | None | object,
    mode: int | None,
) -> bool:
    if hosted_file_io_enabled():
        return write_hosted_bytes_atomic(path, content, expected=expected_current_bytes,
                                        no_expectation=_NO_EXPECTATION, mode=mode)
    try:
        parent_identity, leaf_identity, target_mode = _prepare_atomic_target(
            path,
            workspace=workspace,
            expected_current_bytes=expected_current_bytes,
            mode=mode,
        )
    except _ExpectedCurrentMismatch:
        return False

    _before_temp_create(path)
    try:
        parent_fd, fd, temp_path = _create_atomic_temp(path, parent_identity)
    except OSError as error:
        raise _failure(f"failed to create temporary file: {error}") from error
    temp_identity: NodeIdentity | None = None
    try:
        with os.fdopen(fd, "wb") as handle:
            temp_identity = NodeIdentity.from_stat(os.fstat(handle.fileno()))
            _revalidate_parent_and_temp(path.parent, parent_identity, temp_path, temp_identity)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        _revalidate_parent_and_temp(
            path.parent,
            parent_identity,
            temp_path,
            temp_identity,
        )
        if target_mode is not None:
            chmod_parent = parent_fd if os.chmod in os.supports_dir_fd else None
            os.chmod(temp_path if chmod_parent is None else Path(temp_path.name),
                     target_mode, dir_fd=chmod_parent)
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
            return False
        if parent_fd is None:
            os.replace(temp_path, path)
        else:
            os.replace(temp_path.name, path.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
    except OSError as error:
        raise _failure(f"failed to write file: {error}") from error
    finally:
        _unlink_temp_if_identity(temp_path, temp_identity, parent_fd=parent_fd)
        if parent_fd is not None:
            os.close(parent_fd)
    return True


def _create_atomic_temp(path: Path, parent_identity: NodeIdentity) -> tuple[int | None, int, Path]:
    # os.replace shares renameat with os.rename but CPython registers only
    # os.rename in supports_dir_fd, so the capability check reads rename.
    if not all(operation in os.supports_dir_fd for operation in (os.open, os.rename, os.unlink)):
        fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
        return None, fd, Path(name)
    nofollow = getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    parent_fd = os.open(str(path.parent), os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | nofollow)
    try:
        if not NodeIdentity.from_stat(os.fstat(parent_fd)).same_object(parent_identity):
            raise _failure("atomic write path identity changed before replacement")
        for _ in range(_TEMP_CREATE_ATTEMPTS):
            name = f".{path.name}.{secrets.token_hex(6)}.tmp"
            try:
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow,
                             0o600, dir_fd=parent_fd)
            except FileExistsError:
                continue
            return parent_fd, fd, path.parent / name
        raise FileExistsError("temporary file names exhausted")
    except (OSError, ToolExecutionFailure):
        os.close(parent_fd)
        raise


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
        opened_stat = os.fstat(fd)
        opened = NodeIdentity.from_stat(opened_stat)
        data = os.read(fd, len(expected) + 1)
        return (
            current.matches_open_stat(opened_stat)
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
    *, parent_fd: int | None = None,
) -> None:
    if expected is None:
        return
    try:
        current = (_optional_identity(path) if parent_fd is None else NodeIdentity.from_stat(
            os.stat(path.name, dir_fd=parent_fd, follow_symlinks=False)))
        if (
            current is not None
            and current.same_object(expected)
            and not stat_module.S_ISLNK(current.mode)
            and (parent_fd is not None or not is_link_object(path))
        ):
            if parent_fd is None:
                path.unlink()
            else:
                os.unlink(path.name, dir_fd=parent_fd)
    except (OSError, ToolExecutionFailure):
        return


def _before_temp_create(_path: Path) -> None:
    """Deterministic test seam after target validation and before temp creation."""


def _before_atomic_replace(_path: Path) -> None:
    """Deterministic test seam after policy validation and before replacement."""


def _failure(message: str, *, retryable: bool = True) -> ToolExecutionFailure:
    return ToolExecutionFailure(code=CMP_TOOL_IO_FAILED, message=message, retryable=retryable)


__all__ = [
    "build_write_metadata", "mutation_failure_metadata", "write_bytes_atomic",
    "write_bytes_atomic_if_matches", "write_edit_bytes_after_read",
    "write_hosted_bytes_after_read",
]


def mutation_failure_metadata(error: ToolExecutionFailure, relative_path: str,
                              journal: Any, prepared: Any) -> dict[str, object]:
    metadata: dict[str, object] = {"path": relative_path}
    applied = error.effects == "applied_durability_uncertain"
    if applied:
        metadata.update({"changed": True, "effects": error.effects})
    if prepared is not None and journal is not None:
        metadata["workspace_change_set"] = (journal.mark_applied(prepared) if applied
            else journal.mark_failed_sequence(prepared, prepared.sequences[0]))
    return metadata


def build_written_snapshot(
    resolved: Path,
    *,
    relative_path: str,
    written_bytes: bytes,
) -> dict[str, object] | None:
    """Full read-snapshot metadata for the bytes a write or edit just committed.

    Dogfood TR-007: the tool knows exactly what it wrote, so rewriting a file the
    model itself just wrote needs no forced re-read. Same shape as
    ``file_state.ReadSnapshot.to_metadata()`` for a full read: the digest covers
    the written bytes, size/mtime come from a stat after the write. If that stat
    already disagrees with the written length, something else touched the file
    first and no snapshot is vouched for; any later external change fails the
    digest check.
    """
    try:
        stat_result = resolved.stat()
    except (OSError, ValueError):
        return None
    if int(stat_result.st_size) != len(written_bytes):
        return None
    return {
        "path": relative_path,
        "scope": "full",
        "size_bytes": len(written_bytes),
        "mtime_ns": max(int(stat_result.st_mtime_ns), 0),
        "sha256": hashlib.sha256(written_bytes).hexdigest(),
        "encoding": "utf-8-sig" if written_bytes.startswith(codecs.BOM_UTF8) else "utf-8",
    }


def build_write_metadata(
    *,
    path: str,
    bytes_written: int,
    checkpoint: CheckpointInfo | None = None,
    written: tuple[Path, bytes] | None = None,
) -> dict[str, object]:
    metadata: dict[str, object] = {
        "path": path,
        "bytes_written": bytes_written,
        "checkpoint_created": False,
    }
    if written is not None:
        # The router records this as the path's read snapshot (TR-007).
        snapshot = build_written_snapshot(
            written[0], relative_path=path, written_bytes=written[1],
        )
        if snapshot is not None:
            metadata["written_snapshot"] = snapshot
    if checkpoint and checkpoint.created:
        metadata["checkpoint_created"] = True
        metadata["checkpoint_version"] = checkpoint.version
        metadata["checkpoint_display_path"] = checkpoint.display_path
    return metadata
