"""Canonical and leaf-preserving workspace path identities.

The ordinary filesystem tools usually want a resolved target.  Destructive
leaf operations are different: resolving the final component dereferences a
symlink or junction and silently changes what the user asked to mutate.  This
module keeps those two identity models explicit and provides deterministic
revalidation immediately before a mutation.
"""

from __future__ import annotations

import os
import stat as stat_module
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Sequence

from sidecar.ai.error_codes import (
    CMP_TOOL_CAP_EXCEEDED,
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_IO_FAILED,
    CMP_TOOL_OUTSIDE_WORKSPACE,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure

_WINDOWS_REPARSE_POINT_ATTRIBUTE = 0x400
_MAX_STORE_PATH_DEPTH = 64
_MAX_STORE_PATH_CHARS = 4_096
_MAX_STORE_COMPONENT_CHARS = 180


@dataclass(frozen=True)
class NodeIdentity:
    """An ``lstat`` identity suitable for late-swap detection."""

    device: int
    inode: int
    mode: int
    size: int
    mtime_ns: int

    @classmethod
    def from_stat(cls, value: os.stat_result) -> NodeIdentity:
        return cls(
            device=int(value.st_dev),
            inode=int(value.st_ino),
            mode=int(value.st_mode),
            size=int(value.st_size),
            mtime_ns=int(value.st_mtime_ns),
        )

    def same_object(self, other: NodeIdentity | None) -> bool:
        """Compare stable filesystem identity without mutable size/timestamps."""

        return other is not None and (
            self.device,
            self.inode,
            stat_module.S_IFMT(self.mode),
        ) == (
            other.device,
            other.inode,
            stat_module.S_IFMT(other.mode),
        )


@dataclass(frozen=True)
class CanonicalPathIdentity:
    """Case-normalized canonical identity used for de-duplication/locking."""

    key: str
    canonical_path: Path


@dataclass(frozen=True)
class WorkspaceLeafIdentity:
    """A lexical leaf plus captured parent/object identities.

    ``leaf_path`` deliberately has a canonical real parent and an unresolved
    final component.  Moving it therefore moves the link/junction object, not
    the object it points at.
    """

    root: Path
    leaf_path: Path
    relative_path: str
    parent_identity: NodeIdentity
    leaf_identity: NodeIdentity
    is_link_object: bool
    is_directory: bool


def is_link_object(path: Path) -> bool:
    """Return whether ``path`` is a symlink or Windows reparse object."""

    try:
        if path.is_symlink():
            return True
        if os.name != "nt":
            return False
        attributes = getattr(path.stat(follow_symlinks=False), "st_file_attributes", 0)
        return bool(int(attributes) & _WINDOWS_REPARSE_POINT_ATTRIBUTE)
    except OSError as error:
        raise _identity_failure("failed to inspect workspace path identity") from error


def canonical_workspace_path_identity(
    path: Path,
    workspace_root: Path,
) -> CanonicalPathIdentity:
    """Resolve ``path`` and return one case-normalized workspace identity."""

    try:
        root = workspace_root.resolve(strict=True)
        canonical = path.resolve(strict=False)
    except OSError as error:
        raise _identity_failure("failed to resolve canonical workspace path") from error
    if not _is_within(canonical, root):
        raise ToolExecutionFailure(
            code=CMP_TOOL_OUTSIDE_WORKSPACE,
            message="canonical path identity escapes tools workspace root",
            retryable=False,
        )
    return CanonicalPathIdentity(
        key=os.path.normcase(os.path.normpath(str(canonical))),
        canonical_path=canonical,
    )


def resolve_workspace_leaf(
    workspace_root: Path,
    requested_path: str,
) -> WorkspaceLeafIdentity:
    """Resolve parents while preserving and ``lstat``-ing the lexical leaf."""

    candidate_text = str(requested_path or "").strip()
    if not candidate_text or "\x00" in candidate_text:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="path must be a non-empty string without null bytes",
            retryable=False,
        )
    try:
        root = workspace_root.resolve(strict=True)
    except OSError as error:
        raise _identity_failure("failed to resolve tools workspace root") from error

    requested = Path(candidate_text)
    candidate = requested if requested.is_absolute() else root / requested
    normalized = Path(os.path.abspath(os.path.normpath(str(candidate))))
    if normalized == root or not _is_within(normalized, root):
        raise ToolExecutionFailure(
            code=CMP_TOOL_OUTSIDE_WORKSPACE,
            message="resolved path escapes tools workspace root",
            retryable=False,
        )

    lexical_parent = normalized.parent
    _reject_link_ancestors(lexical_parent, root)
    try:
        real_parent = lexical_parent.resolve(strict=True)
    except FileNotFoundError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=(
                f"path does not exist: {candidate_text}. "
                "Check the exact path with list_dir or glob_files."
            ),
            retryable=False,
        ) from error
    except OSError as error:
        raise _identity_failure("failed to resolve workspace path parent") from error
    if not _is_within(real_parent, root):
        raise ToolExecutionFailure(
            code=CMP_TOOL_OUTSIDE_WORKSPACE,
            message="workspace path parent escapes tools workspace root",
            retryable=False,
        )

    leaf_path = real_parent / normalized.name
    try:
        parent_stat = real_parent.stat(follow_symlinks=False)
        leaf_stat = leaf_path.lstat()
    except FileNotFoundError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=(
                f"path does not exist: {candidate_text}. "
                "Check the exact path with list_dir or glob_files."
            ),
            retryable=False,
        ) from error
    except OSError as error:
        raise _identity_failure("failed to inspect workspace mutation leaf") from error

    link_object = is_link_object(leaf_path)
    return WorkspaceLeafIdentity(
        root=root,
        leaf_path=leaf_path,
        relative_path=normalized.relative_to(root).as_posix(),
        parent_identity=NodeIdentity.from_stat(parent_stat),
        leaf_identity=NodeIdentity.from_stat(leaf_stat),
        is_link_object=link_object,
        is_directory=not link_object and stat_module.S_ISDIR(leaf_stat.st_mode),
    )


def revalidate_workspace_leaf(identity: WorkspaceLeafIdentity) -> None:
    """Fail closed if the captured parent or leaf object changed."""

    _reject_link_ancestors(identity.leaf_path.parent, identity.root)
    try:
        parent_now = NodeIdentity.from_stat(
            identity.leaf_path.parent.stat(follow_symlinks=False)
        )
        leaf_now = NodeIdentity.from_stat(identity.leaf_path.lstat())
    except OSError as error:
        raise _identity_failure("workspace mutation leaf changed before use") from error
    leaf_matches = (
        leaf_now.same_object(identity.leaf_identity)
        if identity.is_directory
        else leaf_now == identity.leaf_identity
    )
    if not parent_now.same_object(identity.parent_identity) or not leaf_matches:
        raise _identity_failure("workspace mutation leaf changed before use")
    if is_link_object(identity.leaf_path) != identity.is_link_object:
        raise _identity_failure("workspace mutation leaf type changed before use")


def normalize_workspace_store_parts(
    value: str | Path | Sequence[str] | None,
) -> tuple[str, ...]:
    """Normalize an opaque store reference without touching the filesystem."""

    if value is None:
        return ()
    raw_values = (str(value),) if isinstance(value, (str, Path)) else tuple(map(str, value))
    parts: list[str] = []
    for raw in raw_values:
        normalized = raw.replace("\\", "/")
        pure = PurePosixPath(normalized)
        if pure.is_absolute() or normalized.startswith("//"):
            raise _store_name_failure("workspace store name must be relative")
        for part in pure.parts:
            if part in {"", "."}:
                continue
            if part == ".." or "\x00" in part:
                raise _store_name_failure("workspace store name contains traversal")
            if _unsafe_store_component(part):
                raise _store_name_failure("workspace store name contains an unsafe component")
            parts.append(part)
    if len(parts) > _MAX_STORE_PATH_DEPTH or sum(
        len(part.encode("utf-8")) for part in parts
    ) > _MAX_STORE_PATH_CHARS:
        raise _store_cap_failure("workspace store reference exceeds path bounds")
    return tuple(parts)


def bounded_workspace_store_limit(value: int, ceiling: int) -> int:
    """Validate a store operation cap without accepting coercive values."""

    if not isinstance(value, int) or isinstance(value, bool):
        raise _store_cap_failure("workspace store limit is invalid")
    if value < 0 or value > ceiling:
        raise _store_cap_failure("workspace store limit exceeds configured bound")
    return value


def _reject_link_ancestors(parent: Path, root: Path) -> None:
    try:
        relative = parent.relative_to(root)
    except ValueError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_OUTSIDE_WORKSPACE,
            message="workspace path parent escapes tools workspace root",
            retryable=False,
        ) from error
    current = root
    for part in relative.parts:
        current = current / part
        try:
            if is_link_object(current):
                raise _identity_failure(
                    "workspace mutation path contains a symlink or reparse point"
                )
        except FileNotFoundError as error:
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message="workspace mutation path parent does not exist",
                retryable=False,
            ) from error


def _unsafe_store_component(part: str) -> bool:
    try:
        encoded = part.encode("utf-8")
    except UnicodeEncodeError:
        return True
    if len(encoded) > _MAX_STORE_COMPONENT_CHARS or part.rstrip(" .") != part:
        return True
    if any(not character.isprintable() or character in '<>:"|?*' for character in part):
        return True
    stem = part.split(".", 1)[0].casefold()
    return stem in {"con", "prn", "aux", "nul"} or (
        stem[:-1] in {"com", "lpt"} and stem[-1:] in "123456789"
    )


def _is_within(path: Path, root: Path) -> bool:
    try:
        return os.path.commonpath(
            (os.path.normcase(str(path)), os.path.normcase(str(root)))
        ) == os.path.normcase(str(root))
    except ValueError:
        return False


def _identity_failure(message: str) -> ToolExecutionFailure:
    return ToolExecutionFailure(code=CMP_TOOL_IO_FAILED, message=message, retryable=True)


def _store_name_failure(message: str) -> ToolExecutionFailure:
    return ToolExecutionFailure(code=CMP_TOOL_IO_FAILED, message=message, retryable=False)


def _store_cap_failure(message: str) -> ToolExecutionFailure:
    return ToolExecutionFailure(code=CMP_TOOL_CAP_EXCEEDED, message=message, retryable=False)


__all__ = [
    "CanonicalPathIdentity",
    "NodeIdentity",
    "WorkspaceLeafIdentity",
    "bounded_workspace_store_limit",
    "canonical_workspace_path_identity",
    "is_link_object",
    "normalize_workspace_store_parts",
    "resolve_workspace_leaf",
    "revalidate_workspace_leaf",
]
