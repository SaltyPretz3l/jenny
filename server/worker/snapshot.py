"""Secure bounded snapshot of the read-only canonical workspace."""

from __future__ import annotations

import os
import stat
from dataclasses import dataclass
from pathlib import Path

MAX_BYTES = 64 * 1024 * 1024
MAX_FILES = 2048
MAX_DEPTH = 32
MAX_PATH_BYTES = 4096


class SnapshotError(ValueError):
    """Inputs cannot be copied under the worker's snapshot contract."""


class SnapshotLimit(SnapshotError):
    """The bounded snapshot budget was exceeded."""


@dataclass(frozen=True)
class SnapshotStats:
    files: int
    bytes: int


def _open_directory(path: str | os.PathLike[str], parent_fd: int | None = None) -> int:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags, dir_fd=parent_fd)
        if not stat.S_ISDIR(os.fstat(fd).st_mode):
            os.close(fd)
            raise SnapshotError("snapshot path is not a directory")
        return fd
    except OSError as exc:
        raise SnapshotError("cannot open snapshot directory") from exc


def _copy_fd(source_fd: int, target_fd: int, size: int, remaining: int) -> int:
    if size > remaining:
        raise SnapshotLimit("input snapshot exceeds 64 MiB")
    copied = 0
    while copied < size:
        try:
            chunk = os.read(source_fd, min(1024 * 1024, size - copied))
        except OSError as exc:
            raise SnapshotError("cannot read input") from exc
        if not chunk:
            raise SnapshotError("input changed while copying")
        view = memoryview(chunk)
        while view:
            try:
                written = os.write(target_fd, view)
            except OSError as exc:
                raise SnapshotError("cannot write snapshot") from exc
            view = view[written:]
        copied += len(chunk)
    if os.fstat(source_fd).st_size != size:
        raise SnapshotError("input changed while copying")
    os.fsync(target_fd)
    return copied


def _snapshot_descriptors(  # noqa: PLR0913, PLR0915 - explicit bounded descriptor traversal
    source: Path, destination: Path, max_bytes: int, max_files: int, max_depth: int
) -> SnapshotStats:
    files = total = visited = 0

    def visit(source_fd: int, destination_fd: int, depth: int, prefix: str) -> None:  # noqa: C901, PLR0912, PLR0915 - descriptor containment checks
        nonlocal files, total, visited
        # Do not materialize/sort an unbounded directory before counting it.
        with os.scandir(source_fd) as entries:
            for entry in entries:
                visited += 1
                if visited > max_files:
                    raise SnapshotLimit("input snapshot entry limit")
                name = entry.name
                relative = prefix + "/" + name if prefix else name
                if len(relative.encode("utf-8")) > MAX_PATH_BYTES:
                    raise SnapshotLimit("input snapshot path limit")
                info = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    if depth >= max_depth:
                        raise SnapshotLimit("input snapshot depth limit")
                    child_in = _open_directory(name, source_fd)
                    try:
                        opened = os.fstat(child_in)
                        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                            raise SnapshotError("input changed during open")
                        os.mkdir(name, 0o700, dir_fd=destination_fd)
                        child_out = _open_directory(name, destination_fd)
                        try:
                            visit(child_in, child_out, depth + 1, relative)
                        finally:
                            os.close(child_out)
                    finally:
                        os.close(child_in)
                elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                    input_fd = os.open(
                        name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_fd
                    )
                    try:
                        before = os.fstat(input_fd)
                        if (
                            not stat.S_ISREG(before.st_mode)
                            or before.st_nlink != 1
                            or (before.st_dev, before.st_ino) != (info.st_dev, info.st_ino)
                        ):
                            raise SnapshotError("input changed during open")
                        output_fd = os.open(
                            name,
                            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                            0o600 | (before.st_mode & 0o111),
                            dir_fd=destination_fd,
                        )
                        try:
                            total += _copy_fd(
                                input_fd, output_fd, before.st_size, max_bytes - total
                            )
                        finally:
                            os.close(output_fd)
                        after = os.fstat(input_fd)
                        if (
                            after.st_size,
                            after.st_mtime_ns,
                            after.st_ctime_ns,
                            after.st_nlink,
                        ) != (before.st_size, before.st_mtime_ns, before.st_ctime_ns, 1):
                            raise SnapshotError("input changed during copy")
                        files += 1
                    finally:
                        os.close(input_fd)
                else:
                    raise SnapshotError("symlink, hardlink or special input")

    source_fd = _open_directory(source)
    try:
        destination_fd = _open_directory(destination)
        try:
            visit(source_fd, destination_fd, 0, "")
        finally:
            os.close(destination_fd)
    finally:
        os.close(source_fd)
    return SnapshotStats(files, total)


def _lstat(path: Path) -> os.stat_result:
    try:
        info = os.lstat(path)
    except OSError as exc:
        raise SnapshotError(f"cannot inspect input: {path}") from exc
    if stat.S_ISLNK(info.st_mode):
        raise SnapshotError(f"symlink is not allowed: {path}")
    return info


def _mkdir(path: Path) -> None:
    try:
        path.mkdir()
    except FileExistsError:
        info = _lstat(path)
        if not stat.S_ISDIR(info.st_mode):
            raise SnapshotError(f"snapshot destination is not a directory: {path}") from None


def _copy_regular(source: Path, target: Path, size: int, remaining: int) -> int:
    if size > remaining:
        raise SnapshotLimit("input snapshot exceeds 64 MiB")
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(source, flags)
    except OSError as exc:
        raise SnapshotError(f"cannot open input: {source}") from exc
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise SnapshotError(f"input is not a single-link regular file: {source}")
        if before.st_size > remaining:
            raise SnapshotLimit("input snapshot exceeds 64 MiB")
        target_fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            copied = 0
            while copied < before.st_size:
                chunk = os.read(fd, min(1024 * 1024, before.st_size - copied))
                if not chunk:
                    raise SnapshotError(f"input changed while copying: {source}")
                view = memoryview(chunk)
                while view:
                    written = os.write(target_fd, view)
                    view = view[written:]
                copied += len(chunk)
            after = os.fstat(fd)
            if (
                after.st_size != before.st_size
                or after.st_ino != before.st_ino
                or after.st_dev != before.st_dev
            ):
                raise SnapshotError(f"input changed while copying: {source}")
            os.fsync(target_fd)
            return copied
        finally:
            os.close(target_fd)
    except OSError as exc:
        raise SnapshotError(f"cannot copy input: {source}") from exc
    finally:
        os.close(fd)


def snapshot_inputs(  # noqa: C901, PLR0912 - traversal enforces independent file safety gates
    source: os.PathLike[str] | str,
    destination: os.PathLike[str] | str,
    *,
    max_bytes: int = MAX_BYTES,
    max_files: int = MAX_FILES,
    max_depth: int = MAX_DEPTH,
) -> SnapshotStats:
    """Copy regular, single-link files below *source* into a fresh tree.

    Traversal uses lstat and O_NOFOLLOW.  Any symlink, device, FIFO, socket,
    hardlink, race, or budget violation fails the entire operation.
    """
    if max_bytes < 0 or max_files < 0 or max_depth < 0:
        raise ValueError("snapshot limits must be non-negative")
    src = Path(source)
    dst = Path(destination)
    source_info = _lstat(src)
    if not stat.S_ISDIR(source_info.st_mode):
        raise SnapshotError("input root must be a directory")
    if src.resolve() == dst.resolve():
        raise SnapshotError("snapshot destination cannot be the input root")
    _mkdir(dst)
    if os.name == "posix":
        return _snapshot_descriptors(src, dst, max_bytes, max_files, max_depth)
    count = 0
    total = 0
    visited = 0
    stack: list[tuple[Path, Path, int]] = [(src, dst, 0)]
    while stack:
        current, output, depth = stack.pop()
        info = _lstat(current)
        if not stat.S_ISDIR(info.st_mode):
            raise SnapshotError(f"input directory changed: {current}")
        if depth > max_depth:
            raise SnapshotLimit("input snapshot exceeds depth 32")
        try:
            entries = sorted(os.scandir(current), key=lambda entry: entry.name)
        except OSError as exc:
            raise SnapshotError(f"cannot list input: {current}") from exc
        for entry in reversed(entries):
            if entry.name in (".", "..") or os.sep in entry.name:
                raise SnapshotError("invalid input name")
            visited += 1
            if visited > max_files:
                raise SnapshotLimit("input snapshot exceeds 2048 entries")
            child = current / entry.name
            child_out = output / entry.name
            if len(str(child.relative_to(src)).encode("utf-8")) > MAX_PATH_BYTES:
                raise SnapshotLimit("input path exceeds 4096 bytes")
            child_info = _lstat(child)
            mode = child_info.st_mode
            if stat.S_ISDIR(mode):
                if depth + 1 > max_depth:
                    raise SnapshotLimit("input snapshot exceeds depth 32")
                _mkdir(child_out)
                stack.append((child, child_out, depth + 1))
            elif stat.S_ISREG(mode):
                if child_info.st_nlink != 1:
                    raise SnapshotError(f"hardlink is not allowed: {child}")
                total += _copy_regular(child, child_out, child_info.st_size, max_bytes - total)
                count += 1
            else:
                raise SnapshotError(f"special input is not allowed: {child}")
    return SnapshotStats(files=count, bytes=total)


copy_inputs = snapshot_inputs
