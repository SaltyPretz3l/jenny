"""Canonical runtime identifiers and guarded runtime-directory primitives."""

from __future__ import annotations

import os
import re
import stat as stat_module
import uuid
from dataclasses import dataclass
from pathlib import Path

_WINDOWS_REPARSE_POINT_ATTRIBUTE = 0x400
_SESSION_ID_PATTERN = re.compile(r"[A-Za-z0-9._-]{1,128}")
_MONITOR_ID_PATTERN = re.compile(r"mon_[0-9a-f]{12}")
_SAFE_COMPONENT_PATTERN = re.compile(r"[A-Za-z0-9._-]{1,180}")
_CURRENT_DIRECTORY_TOKENS = frozenset({".", ".."})


class RuntimeIdError(ValueError):
    """A caller-provided runtime identifier is not canonical."""


class RuntimePathError(OSError):
    """An app-owned runtime path is unsafe or changed during use."""


@dataclass(frozen=True)
class _NodeIdentity:
    device: int
    inode: int
    file_type: int

    @classmethod
    def from_stat(cls, value: os.stat_result) -> _NodeIdentity:
        return cls(
            device=int(value.st_dev),
            inode=int(value.st_ino),
            file_type=stat_module.S_IFMT(int(value.st_mode)),
        )


@dataclass(frozen=True)
class RuntimeFileRead:
    data: bytes
    mtime_ns: int


@dataclass(frozen=True)
class GuardedRuntimeDirectory:
    """A captured plain directory revalidated around file operations."""

    path: Path
    _identity: _NodeIdentity

    @classmethod
    def create_trusted_root(cls, path: Path | str) -> GuardedRuntimeDirectory:
        """Create and canonicalize an app-configured runtime root.

        The configured root is trusted configuration. Child directories and
        files created beneath the returned canonical directory are not trusted
        and are checked with no-follow identities on every operation.
        """

        candidate = Path(path).expanduser()
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            canonical = candidate.resolve(strict=True)
        except OSError as error:
            raise RuntimePathError("runtime root is unavailable") from error
        return cls.from_existing(canonical)

    @classmethod
    def from_existing(cls, path: Path | str) -> GuardedRuntimeDirectory:
        candidate = Path(path)
        try:
            value = candidate.lstat()
        except OSError as error:
            raise RuntimePathError("runtime directory is unavailable") from error
        if is_runtime_link_object(candidate, value) or not stat_module.S_ISDIR(value.st_mode):
            raise RuntimePathError("runtime directory must be a plain directory")
        try:
            canonical = candidate.resolve(strict=True)
        except OSError as error:
            raise RuntimePathError("runtime directory cannot be resolved") from error
        if canonical != candidate.absolute():
            raise RuntimePathError("runtime directory identity is not canonical")
        return cls(path=canonical, _identity=_NodeIdentity.from_stat(value))

    def child_directory(
        self,
        name: str,
        *,
        create: bool,
    ) -> GuardedRuntimeDirectory | None:
        component = _canonical_component(name)
        self.validate()
        candidate = self.path / component
        try:
            value = candidate.lstat()
        except FileNotFoundError:
            if not create:
                return None
            try:
                candidate.mkdir()
                value = candidate.lstat()
            except OSError as error:
                raise RuntimePathError("runtime child directory could not be created") from error
        except OSError as error:
            raise RuntimePathError("runtime child directory could not be inspected") from error
        if is_runtime_link_object(candidate, value) or not stat_module.S_ISDIR(value.st_mode):
            raise RuntimePathError("runtime child directory must be a plain directory")
        self.validate()
        try:
            canonical = candidate.resolve(strict=True)
        except OSError as error:
            raise RuntimePathError("runtime child directory cannot be resolved") from error
        if canonical.parent != self.path:
            raise RuntimePathError("runtime child directory escapes its parent")
        return GuardedRuntimeDirectory(
            path=canonical,
            _identity=_NodeIdentity.from_stat(value),
        )

    def validate(self) -> None:
        try:
            value = self.path.lstat()
        except OSError as error:
            raise RuntimePathError("runtime directory changed during use") from error
        if is_runtime_link_object(self.path, value) or not stat_module.S_ISDIR(value.st_mode):
            raise RuntimePathError("runtime directory changed to an unsafe object")
        if _NodeIdentity.from_stat(value) != self._identity:
            raise RuntimePathError("runtime directory identity changed during use")

    def validate_file_target(self, name: str) -> Path:
        component = _canonical_component(name)
        self.validate()
        target = self.path / component
        try:
            value = target.lstat()
        except FileNotFoundError:
            return target
        except OSError as error:
            raise RuntimePathError("runtime file could not be inspected") from error
        if is_runtime_link_object(target, value) or not stat_module.S_ISREG(value.st_mode):
            raise RuntimePathError("runtime file must be a plain regular file")
        return target

    def read_bytes(
        self,
        name: str,
        *,
        max_bytes: int,
        missing_ok: bool,
    ) -> RuntimeFileRead | None:
        if max_bytes <= 0:
            raise ValueError("max_bytes must be positive")
        target = self.validate_file_target(name)
        try:
            captured = target.lstat()
        except FileNotFoundError:
            if missing_ok:
                return None
            raise RuntimePathError("runtime file does not exist") from None
        except OSError as error:
            raise RuntimePathError("runtime file could not be inspected") from error
        if int(captured.st_size) > max_bytes:
            raise RuntimePathError("runtime file exceeds its byte limit")

        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        fd: int | None = None
        try:
            fd = os.open(str(target), flags)
            opened = os.fstat(fd)
            if _NodeIdentity.from_stat(opened) != _NodeIdentity.from_stat(captured):
                raise RuntimePathError("runtime file changed before read")
            data = _read_fd_bounded(fd, max_bytes)
            final = os.fstat(fd)
            if _NodeIdentity.from_stat(final) != _NodeIdentity.from_stat(captured):
                raise RuntimePathError("runtime file changed during read")
            return RuntimeFileRead(data=data, mtime_ns=max(int(final.st_mtime_ns), 0))
        except RuntimePathError:
            raise
        except OSError as error:
            raise RuntimePathError("runtime file read failed") from error
        finally:
            if fd is not None:
                os.close(fd)

    def write_bytes_atomic(self, name: str, data: bytes, *, max_bytes: int) -> Path:
        if len(data) > max_bytes:
            raise RuntimePathError("runtime file exceeds its byte limit")
        target = self.validate_file_target(name)
        temp_path = self.path / f".{target.name}.{uuid.uuid4().hex}.tmp"
        flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_BINARY", 0)
        )
        fd: int | None = None
        try:
            fd = os.open(str(temp_path), flags, 0o600)
            view = memoryview(data)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise RuntimePathError("runtime file write made no progress")
                view = view[written:]
            os.fsync(fd)
            os.close(fd)
            fd = None
            self.validate()
            self.validate_file_target(name)
            os.replace(temp_path, target)
            self.validate()
            return target
        except RuntimePathError:
            raise
        except OSError as error:
            raise RuntimePathError("runtime file write failed") from error
        finally:
            if fd is not None:
                os.close(fd)
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass


def parse_session_id(value: object) -> str:
    if not isinstance(value, str):
        raise RuntimeIdError("session_id must be a string")
    candidate = value.strip()
    if (
        not candidate
        or candidate in _CURRENT_DIRECTORY_TOKENS
        or _SESSION_ID_PATTERN.fullmatch(candidate) is None
    ):
        raise RuntimeIdError("session_id is not a canonical runtime identifier")
    return candidate


def try_parse_session_id(value: object) -> str | None:
    try:
        return parse_session_id(value)
    except RuntimeIdError:
        return None


def parse_monitor_id(value: object) -> str:
    if not isinstance(value, str):
        raise RuntimeIdError("monitor_id must be a string")
    candidate = value.strip()
    if _MONITOR_ID_PATTERN.fullmatch(candidate) is None:
        raise RuntimeIdError("monitor_id must match mon_[0-9a-f]{12}")
    return candidate


def new_monitor_id() -> str:
    return f"mon_{uuid.uuid4().hex[:12]}"


def _canonical_component(value: object) -> str:
    if not isinstance(value, str):
        raise RuntimePathError("runtime path component must be a string")
    if (
        value in _CURRENT_DIRECTORY_TOKENS
        or _SAFE_COMPONENT_PATTERN.fullmatch(value) is None
    ):
        raise RuntimePathError("runtime path component is invalid")
    return value


def is_runtime_link_object(path: Path, value: os.stat_result | None = None) -> bool:
    """Return whether a runtime path is a symlink or Windows reparse object."""

    try:
        if path.is_symlink():
            return True
        current = value if value is not None else path.stat(follow_symlinks=False)
    except OSError as error:
        raise RuntimePathError("runtime path identity could not be inspected") from error
    if os.name != "nt":
        return False
    attributes = getattr(current, "st_file_attributes", 0)
    return bool(int(attributes) & _WINDOWS_REPARSE_POINT_ATTRIBUTE)


def _read_fd_bounded(fd: int, limit: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = os.read(fd, min(64 * 1024, limit - total + 1))
        if not chunk:
            return b"".join(chunks)
        total += len(chunk)
        if total > limit:
            raise RuntimePathError("runtime file exceeds its byte limit")
        chunks.append(chunk)


__all__ = [
    "GuardedRuntimeDirectory",
    "RuntimeFileRead",
    "RuntimeIdError",
    "RuntimePathError",
    "is_runtime_link_object",
    "new_monitor_id",
    "parse_monitor_id",
    "parse_session_id",
    "try_parse_session_id",
]
