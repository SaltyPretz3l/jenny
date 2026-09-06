"""Workspace path guardrails for filesystem tools."""

from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING, Any

from sidecar.ai.error_codes import (
    CMP_TOOL_DISABLED,
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_IO_FAILED,
    CMP_TOOL_OUTSIDE_WORKSPACE,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace_path_identity import (
    NodeIdentity,
    canonical_workspace_path_identity,
)

if TYPE_CHECKING:
    from sidecar.ai.tools.workspace_store import GuardedWorkspaceStore

_WINDOWS_REPARSE_POINT_ATTRIBUTE = 0x400


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


class WorkspaceGuard:
    def __init__(
        self,
        workspace_root: str | None,
        *,
        pre_change_snapshot_root: str | None = None,
        mutation_journal: Any | None = None,
    ) -> None:
        self._root, self._root_error = self._resolve_root(workspace_root)
        self.pre_change_snapshot_root = pre_change_snapshot_root
        self.mutation_journal = mutation_journal

    @property
    def root(self) -> Path | None:
        return self._root

    @property
    def root_error(self) -> str | None:
        return self._root_error

    def require_root(self) -> Path:
        if self._root is not None:
            return self._root

        if self._root_error:
            message = f"tools workspace root is invalid: {self._root_error}"
        else:
            message = "tools workspace root is not configured"

        raise ToolExecutionFailure(code=CMP_TOOL_DISABLED, message=message, retryable=False)

    def internal_store(self) -> GuardedWorkspaceStore:
        """Build the operation owner for workspace-local ``.jenny`` state."""

        from sidecar.ai.tools.workspace_store import (  # noqa: PLC0415
            GuardedWorkspaceStore,
        )

        return GuardedWorkspaceStore(self.require_root())

    def is_recovery_object_pinned(self, object_id: str) -> bool:
        checker = getattr(self.mutation_journal, "is_recovery_object_pinned", None)
        return bool(checker(object_id)) if callable(checker) else False

    def observe_mutation_tool_call(self, tool_name: str, arguments: dict[str, object]) -> None:
        observer = getattr(self.mutation_journal, "observe_tool_call", None)
        if callable(observer):
            observer(tool_name, arguments)

    def is_trash_entry_pinned(self, entry_name: str) -> bool:
        checker = getattr(self.mutation_journal, "is_trash_entry_pinned", None)
        return bool(checker(entry_name)) if callable(checker) else False

    def resolve_read_path(self, requested_path: str) -> Path:
        return self._resolve_path(requested_path, strict=True)

    def resolve_list_path(self, requested_path: str | None) -> Path:
        candidate = requested_path if requested_path is not None else "."
        return self._resolve_path(candidate, strict=True)

    def resolve_write_path(self, requested_path: str) -> Path:
        return self._resolve_path(requested_path, strict=False)

    def ensure_within_root(self, resolved_path: Path) -> Path:
        root = self.require_root()
        try:
            candidate = resolved_path.resolve(strict=False)
        except OSError as error:
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message=f"failed to resolve path: {error}",
                retryable=False,
            ) from error

        if not _is_relative_to(candidate, root):
            raise ToolExecutionFailure(
                code=CMP_TOOL_OUTSIDE_WORKSPACE,
                message="resolved path escapes tools workspace root",
                retryable=False,
            )
        return candidate

    def ensure_safe_mutation_path(self, resolved_path: Path) -> Path:
        root = self.require_root()
        candidate = Path(resolved_path)
        try:
            root_resolved = root.resolve(strict=True)
            parent_anchor = self._nearest_existing_parent(candidate.parent)
            self._reject_reparse_path(parent_anchor)
            parent_resolved = parent_anchor.resolve(strict=True)
        except ToolExecutionFailure:
            raise
        except OSError as error:
            raise _mutation_path_failure(f"failed to revalidate mutation path: {error}") from error

        if not _is_relative_to(parent_resolved, root_resolved):
            raise _mutation_path_failure(
                "mutation path parent changed outside tools workspace root"
            )

        self._reject_reparse_ancestors(candidate.parent, root_resolved)
        if candidate.exists() or candidate.is_symlink():
            self._reject_reparse_path(candidate)
            try:
                candidate_resolved = candidate.resolve(strict=True)
            except OSError as error:
                raise _mutation_path_failure(
                    f"failed to revalidate mutation target: {error}"
                ) from error
            if not _is_relative_to(candidate_resolved, root_resolved):
                raise _mutation_path_failure(
                    "mutation target changed outside tools workspace root"
                )
        return candidate

    def check_file_size(self, path: Path, max_bytes: int, *, hint: str | None = None) -> int:
        try:
            size = path.stat().st_size
        except OSError as error:
            raise ToolExecutionFailure(
                code=CMP_TOOL_IO_FAILED,
                message=f"failed to stat file: {error}",
                retryable=True,
            ) from error
        if size > max_bytes:
            message = f"file exceeds {max_bytes} byte limit: {path.name}"
            if hint:
                message = f"{message}. {hint}"
            raise ToolExecutionFailure(
                code=CMP_TOOL_IO_FAILED,
                message=message,
                retryable=False,
            )
        return size

    def _resolve_root(self, workspace_root: str | None) -> tuple[Path | None, str | None]:
        if workspace_root is None or not workspace_root.strip():
            return None, None

        try:
            resolved = Path(workspace_root).expanduser().resolve(strict=True)
        except FileNotFoundError:
            return None, "path does not exist"
        except OSError as error:
            return None, str(error)

        if not resolved.is_dir():
            return None, "path is not a directory"

        return resolved, None

    def _nearest_existing_parent(self, path: Path) -> Path:
        candidate = path
        while not candidate.exists():
            parent = candidate.parent
            if parent == candidate:
                raise _mutation_path_failure("mutation path has no existing parent directory")
            candidate = parent
        if not candidate.is_dir():
            raise _mutation_path_failure("mutation path parent is not a directory")
        return candidate

    def _reject_reparse_ancestors(self, parent: Path, root: Path) -> None:
        try:
            relative = parent.relative_to(root)
        except ValueError:
            return
        current = root
        for part in relative.parts:
            current = current / part
            if current.exists() or current.is_symlink():
                self._reject_reparse_path(current)

    def _reject_reparse_path(self, path: Path) -> None:
        if path.is_symlink() or _has_windows_reparse_point(path):
            raise _mutation_path_failure("mutation path contains a symlink or reparse point")

    def _resolve_path(self, requested_path: str, *, strict: bool) -> Path:
        root = self.require_root()

        candidate = requested_path.strip()
        if not candidate:
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message="path must be a non-empty string",
                retryable=False,
            )
        if "\x00" in candidate:
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message="path contains null bytes",
                retryable=False,
            )

        requested = Path(candidate)
        target = requested if requested.is_absolute() else root / requested

        try:
            resolved = target.resolve(strict=strict)
        except FileNotFoundError as error:
            # Name the path and a recovery route: models that get the bare
            # "path does not exist" treat it as a capability failure instead
            # of correcting the path.
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message=(
                    f"path does not exist: {candidate}. "
                    "Check the exact path with list_dir or glob_files."
                ),
                retryable=False,
            ) from error
        except OSError as error:
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message=f"failed to resolve path: {error}",
                retryable=False,
            ) from error

        if not _is_relative_to(resolved, root):
            raise ToolExecutionFailure(
                code=CMP_TOOL_OUTSIDE_WORKSPACE,
                message="resolved path escapes tools workspace root",
                retryable=False,
            )

        return resolved


def ensure_safe_internal_destination(workspace_root: Path, destination: Path) -> Path:
    """Validate an internally assembled destination (trash/backups/tool-results/
    artifacts under `.jenny`) against symlink/reparse redirection before any
    write, move, or delete touches it.

    Unlike WorkspaceGuard.ensure_safe_mutation_path this is a free function:
    cleanup, backup, and job-status call sites assemble destinations from a
    bare workspace root and have no guard instance. Validation only — this
    never creates directories or files. Fail-closed: an unresolvable root or
    an unprobeable component refuses the destination.
    """
    try:
        root_resolved = Path(workspace_root).resolve(strict=True)
    except OSError as error:
        raise _mutation_path_failure(
            f"failed to resolve workspace root for internal destination: {error}"
        ) from error

    candidate = Path(destination)
    if not candidate.is_absolute():
        candidate = root_resolved / candidate

    normalized = Path(os.path.normpath(str(candidate)))
    if not _is_relative_to(normalized, root_resolved) or normalized == root_resolved:
        raise ToolExecutionFailure(
            code=CMP_TOOL_OUTSIDE_WORKSPACE,
            message="internal destination escapes tools workspace root",
            retryable=False,
        )

    current = root_resolved
    for part in normalized.relative_to(root_resolved).parts:
        current = current / part
        try:
            # A broken symlink reports is_symlink() True while exists() is
            # False, so the symlink check must run before the existence
            # short-circuit.
            is_link = current.is_symlink()
            missing = not is_link and not current.exists()
        except OSError as error:
            raise _mutation_path_failure(
                f"failed to probe internal destination path: {error}"
            ) from error
        if is_link:
            raise _mutation_path_failure(
                "internal destination path contains a symlink or reparse point"
            )
        if missing:
            break
        if _has_windows_reparse_point(current):
            raise _mutation_path_failure(
                "internal destination path contains a symlink or reparse point"
            )
    return normalized


def _mutation_path_failure(message: str) -> ToolExecutionFailure:
    return ToolExecutionFailure(code=CMP_TOOL_IO_FAILED, message=message, retryable=True)


def _has_windows_reparse_point(path: Path) -> bool:
    if os.name != "nt":
        return False
    try:
        attributes = getattr(path.stat(follow_symlinks=False), "st_file_attributes", 0)
    except OSError:
        return True
    return bool(attributes & _WINDOWS_REPARSE_POINT_ATTRIBUTE)


__all__ = [
    "NodeIdentity",
    "WorkspaceGuard",
    "canonical_workspace_path_identity",
    "ensure_safe_internal_destination",
]
