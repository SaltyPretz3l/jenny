"""Bounded, no-follow reads and discovery for model-facing workspace context."""

from __future__ import annotations

import os
import stat
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path

_WINDOWS_REPARSE_POINT_ATTRIBUTE = 0x400


@dataclass(frozen=True)
class BoundedContextText:
    text: str | None
    reason: str | None = None
    truncated: bool = False


@dataclass(frozen=True)
class SkillDiscovery:
    files: tuple[Path, ...]
    truncation_reasons: tuple[str, ...] = ()


@dataclass(frozen=True)
class BoundedContextSources:
    bootstrap_blocks: tuple[str, ...]
    skills_block: str
    instruction_block: str
    truncated_sources: tuple[str, ...] = ()


def _is_link(path: Path) -> bool:
    if path.is_symlink():
        return True
    if os.name != "nt":
        return False
    value = path.stat(follow_symlinks=False)
    return bool(
        int(getattr(value, "st_file_attributes", 0)) & _WINDOWS_REPARSE_POINT_ATTRIBUTE
    )


def _lexical_path_has_link(path: Path, root: Path) -> bool:
    lexical_root = Path(os.path.abspath(root))
    lexical_path = Path(os.path.abspath(path))
    lexical_relative = lexical_path.relative_to(lexical_root)
    current = lexical_root
    for part in lexical_relative.parts:
        current = current / part
        if _is_link(current):
            return True
    return False


def _authorized_paths(path: Path, root: Path) -> tuple[Path, Path] | None:
    try:
        if _is_link(root) or _lexical_path_has_link(path, root):
            return None
        resolved_root = root.resolve(strict=True)
        resolved_path = path.resolve(strict=True)
        if resolved_path != resolved_root and not resolved_path.is_relative_to(resolved_root):
            return None
        relative = resolved_path.relative_to(resolved_root)
        current = resolved_root
        if _is_link(current):
            return None
        for part in relative.parts:
            current = current / part
            if _is_link(current):
                return None
        return resolved_path, resolved_root
    except (OSError, ValueError):
        return None


def read_bounded_context_text(
    path: Path,
    *,
    authorized_root: Path,
    max_bytes: int,
    truncate: bool,
) -> BoundedContextText:
    """Read one regular UTF-8 file without following workspace links."""
    if max_bytes <= 0:
        return BoundedContextText(None, "invalid_budget")
    authorized = _authorized_paths(path, authorized_root)
    if authorized is None:
        return BoundedContextText(None, "unsafe_path")
    resolved_path, _ = authorized
    try:
        expected = resolved_path.stat(follow_symlinks=False)
    except OSError:
        return BoundedContextText(None, "identity_failed")
    return _read_regular_utf8_file(
        resolved_path,
        expected=expected,
        max_bytes=max_bytes,
        truncate=truncate,
    )


def _read_regular_utf8_file(
    path: Path,
    *,
    expected: os.stat_result,
    max_bytes: int,
    truncate: bool,
) -> BoundedContextText:
    read_result = _read_regular_file_bytes(path, expected=expected, max_bytes=max_bytes)
    if isinstance(read_result, BoundedContextText):
        return read_result
    raw, oversized = read_result
    if oversized and not truncate:
        return BoundedContextText(None, "file_budget_exceeded", truncated=True)
    if oversized:
        raw = raw[:max_bytes]
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        if not oversized or error.start < len(raw) - 4:
            return BoundedContextText(None, "invalid_utf8")
        text = raw[: error.start].decode("utf-8", errors="strict")
    return BoundedContextText(
        text.replace("\r\n", "\n").replace("\r", "\n"),
        truncated=oversized,
    )


def _read_regular_file_bytes(
    path: Path,
    *,
    expected: os.stat_result,
    max_bytes: int,
) -> tuple[bytes, bool] | BoundedContextText:
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(str(path), flags)
    except OSError:
        return BoundedContextText(None, "open_failed")
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            return BoundedContextText(None, "not_regular_file")
        if (opened.st_dev, opened.st_ino, stat.S_IFMT(opened.st_mode)) != (
            expected.st_dev,
            expected.st_ino,
            stat.S_IFMT(expected.st_mode),
        ):
            return BoundedContextText(None, "identity_changed")
        chunks: list[bytes] = []
        remaining = max_bytes + 1
        while remaining > 0:
            chunk = os.read(fd, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
    except OSError:
        return BoundedContextText(None, "read_failed")
    finally:
        os.close(fd)
    return raw, len(raw) > max_bytes


def _directory_entries(directory: Path) -> list[os.DirEntry[str]] | None:
    try:
        with os.scandir(directory) as scanner:
            return sorted(scanner, key=lambda entry: entry.name.casefold())
    except OSError:
        return None


def _entry_kind(entry: os.DirEntry[str]) -> str:
    try:
        is_link = entry.is_symlink()
        if not is_link and os.name == "nt":
            attrs = getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0)
            is_link = bool(int(attrs) & _WINDOWS_REPARSE_POINT_ATTRIBUTE)
        if is_link:
            return "link"
        if entry.is_dir(follow_symlinks=False):
            return "directory"
        if entry.is_file(follow_symlinks=False):
            return "file"
        return "other"
    except OSError:
        return "error"


def _enqueue_directory(
    entry: os.DirEntry[str],
    *,
    depth: int,
    max_depth: int,
    queue: deque[tuple[Path, int]],
    reasons: set[str],
) -> None:
    if depth >= max_depth:
        reasons.add("depth_budget")
        return
    queue.append((Path(entry.path), depth + 1))


def discover_skill_files(
    root: Path,
    *,
    max_depth: int,
    max_entries: int,
    max_files: int,
    max_seconds: float,
) -> SkillDiscovery:
    """Breadth-first, no-follow SKILL.md discovery under one authorized root."""
    authorized = _authorized_paths(root, root)
    if authorized is None:
        return SkillDiscovery((), ("unsafe_scope_root",))
    resolved_root, _ = authorized
    deadline = time.monotonic() + max(0.01, max_seconds)
    queue: deque[tuple[Path, int]] = deque([(resolved_root, 0)])
    files: list[Path] = []
    entries = 0
    reasons: set[str] = set()
    while queue:
        if time.monotonic() >= deadline:
            reasons.add("time_budget")
            break
        directory, depth = queue.popleft()
        children = _directory_entries(directory)
        if children is None:
            reasons.add("unreadable_directory")
            continue
        for entry in children:
            entries += 1
            if entries > max_entries:
                reasons.add("entry_budget")
                queue.clear()
                break
            if time.monotonic() >= deadline:
                reasons.add("time_budget")
                queue.clear()
                break
            kind = _entry_kind(entry)
            if kind in {"error", "link"}:
                reasons.add(
                    "entry_inspection_failed" if kind == "error" else "link_skipped"
                )
                continue
            if kind == "directory":
                _enqueue_directory(
                    entry,
                    depth=depth,
                    max_depth=max_depth,
                    queue=queue,
                    reasons=reasons,
                )
                continue
            if kind != "file" or entry.name != "SKILL.md":
                continue
            if len(files) >= max_files:
                reasons.add("file_budget")
                queue.clear()
                break
            files.append(Path(entry.path))
    return SkillDiscovery(tuple(files), tuple(sorted(reasons)))


def truncate_utf8(value: str, max_bytes: int, *, suffix: str = "") -> tuple[str, bool]:
    """Return text whose UTF-8 representation never exceeds ``max_bytes``."""
    encoded = value.encode("utf-8", errors="replace")
    if len(encoded) <= max_bytes:
        return value, False
    suffix_bytes = suffix.encode("utf-8", errors="replace")[:max_bytes]
    available = max(0, max_bytes - len(suffix_bytes))
    prefix = encoded[:available]
    while prefix:
        try:
            return prefix.decode("utf-8") + suffix_bytes.decode("utf-8"), True
        except UnicodeDecodeError as error:
            prefix = prefix[: error.start]
    return suffix_bytes.decode("utf-8", errors="ignore"), True


def bound_workspace_context_sources(
    bootstrap_blocks: list[str],
    skills_block: str,
    instruction_block: str,
    *,
    max_bytes: int,
) -> BoundedContextSources:
    """Apply one aggregate byte budget across every workspace prompt source."""
    remaining = max(0, max_bytes)
    bounded_sources: list[tuple[str, str]] = []
    truncated_sources: list[str] = []
    sources = [
        *(("bootstrap", block) for block in bootstrap_blocks),
        ("skills", skills_block),
        ("workspace_instruction", instruction_block),
    ]
    for source_kind, block in sources:
        if not block:
            continue
        bounded, truncated = truncate_utf8(
            block,
            remaining,
            suffix="\n[workspace context truncated: aggregate budget reached]",
        )
        if bounded:
            bounded_sources.append((source_kind, bounded))
            remaining -= len(bounded.encode("utf-8"))
        if truncated or not bounded:
            truncated_sources.append(source_kind)
    return BoundedContextSources(
        bootstrap_blocks=tuple(
            block for kind, block in bounded_sources if kind == "bootstrap"
        ),
        skills_block=next(
            (block for kind, block in bounded_sources if kind == "skills"),
            "",
        ),
        instruction_block=next(
            (block for kind, block in bounded_sources if kind == "workspace_instruction"),
            "",
        ),
        truncated_sources=tuple(truncated_sources),
    )
