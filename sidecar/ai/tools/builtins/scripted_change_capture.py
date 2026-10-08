"""Bounded review evidence for workspace files changed by scripts and commands.

``run_command``, ``run_temp_script`` and ``python_execute`` can rewrite files
without edit_file's stale-file check or encoding preservation (row 34); the
Changes view restores them from the turn's checkpoint (row 34 S5).
This module turns a before/after git status pair into user-only metadata: V1
structured diffs (the shape ``edit_file``/``move_file`` emit) plus a
``scripted_change_review`` v1 record. Only :func:`scripted_edit_note` produces
model-facing text, and it names paths, never content.

Preimages of paths that were dirty or untracked before the call are read in
memory before it runs; clean tracked files are recovered afterwards from
``HEAD``. Every read is an lstat-checked regular file whose real path stays in
the workspace; sensitive names are never read. A changed file that cannot be
diffed gets a summary-only entry instead of being dropped.

The review may name the turn's restore point (row 34 S5, ``scripted_restore_point``).
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import re
import stat
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from sidecar.ai.tools.builtins.scripted_restore_point import (  # noqa: F401 - re-exported
    bounded_restore_point,
    restore_point_argument,
)
from sidecar.ai.tools.builtins.structured_diff import (
    TRUNCATION_REASONS,
    compute_structured_diff,
    normalize_diff_input_text,
)

SCHEMA_VERSION = 1
MAX_FILE_BYTES = 512 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024
MAX_FILES = 500
WALL_BUDGET_SECONDS = 1.0
MAX_DIFFS = 20
MAX_DIFF_METADATA_BYTES = 256 * 1024
MAX_REVIEW_PATHS = 50
MAX_NOTE_CHARS = 400
MAX_NOTE_PATHS = 5
# ``git show`` output is drained into a bounded buffer (2 MiB per stream).
MAX_HEAD_BATCH_BYTES = 3 * MAX_FILE_BYTES
MAX_HEAD_BATCH_CALLS = 3
MAX_DIFF_ID_SEGMENT_CHARS = 80

STATE_OBSERVED = "observed"
STATE_PARTIAL = "partial"
STATE_UNAVAILABLE = "unavailable"
STATE_UNSUPPORTED = "unsupported"
COVERAGE = "git_status_paths"
CERTAINTY = "observed_during_call"
# A background job's window: other calls may have overlapped it (row 34 S2).
CERTAINTY_BACKGROUND = "background_window"

SOURCE_SUFFIXES = frozenset({
    ".py", ".pyi", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json",
    ".toml", ".cfg", ".ini", ".yaml", ".yml", ".md", ".rst", ".txt",
})
SENSITIVE_BASENAME_GLOBS = (
    ".env*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*",
    ".npmrc", ".pypirc", ".netrc", "*credentials*", "*secret*", "*.kdbx",
)
_NOTE_PREFIX = "This command changed workspace files outside edit_file/write_file: "
_NOTE_SUFFIX = (
    ". These edits skip the stale-file check and encoding preservation (the "
    "person can still undo them from Changes); use edit_file/write_file for source edits."
)
_UNSAFE_ID_CHARS = re.compile(r"[^A-Za-z0-9._-]+")
_OID_HASHES = {40: "sha1", 64: "sha256"}
_TREE_SPLIT_FIELDS = 3

RunGit = Callable[[list[str]], str]


@dataclass(frozen=True)
class FileContent:
    """One side of a diff: decoded text, or the reason it is unavailable."""

    exists: bool
    text: str | None = None
    reason: str | None = None
    digest: str | None = None


@dataclass(frozen=True)
class ScriptedDiffs:
    diffs: list[dict[str, Any]]
    summary_only_count: int
    omitted_count: int


_ABSENT = FileContent(exists=False, text="")


class _Budget:
    """Per-phase wall, byte and file budget for content reads."""

    def __init__(self, clock: Callable[[], float]) -> None:
        self._clock = clock
        self._deadline = clock() + WALL_BUDGET_SECONDS
        self.bytes_left = MAX_TOTAL_BYTES
        self.files_left = MAX_FILES

    def expired(self) -> bool:
        return self._clock() >= self._deadline

    def admit(self, size: int) -> str | None:
        if size > MAX_FILE_BYTES or size > self.bytes_left:
            return "byte_limit"
        if self.files_left <= 0:
            return "preimage_unavailable"
        self.bytes_left -= size
        self.files_left -= 1
        return None


def is_source_like(path: str) -> bool:
    return PurePosixPath(path).suffix.lower() in SOURCE_SUFFIXES


def is_sensitive_path(path: str) -> bool:
    name = PurePosixPath(path).name.lower()
    return any(fnmatch.fnmatchcase(name, pattern) for pattern in SENSITIVE_BASENAME_GLOBS)


def order_paths(paths: Iterable[str]) -> list[str]:
    """Source-like paths first, then by path."""
    return sorted(set(paths), key=lambda path: (not is_source_like(path), path))


def printable(text: str) -> str:
    return "".join(char if char.isprintable() else "?" for char in text)


def diff_id_prefix(operation_id: object) -> str:
    segment = _UNSAFE_ID_CHARS.sub("_", str(operation_id or "").strip())
    return f"scripted:{segment[:MAX_DIFF_ID_SEGMENT_CHARS] or 'call'}"


def capture_preimages(
    repo_root: Path,
    workspace_root: Path,
    paths: Iterable[str],
    *,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, FileContent]:
    """Read paths that are dirty or untracked before the call, within budget."""
    budget = _Budget(clock)
    captured: dict[str, FileContent] = {}
    for path in order_paths(paths):
        if is_sensitive_path(path):
            captured[path] = _sensitive_content(repo_root, path)
        elif budget.expired():
            captured[path] = FileContent(exists=_exists(repo_root, path), reason="time_limit")
        else:
            captured[path] = read_workspace_file(
                repo_root, workspace_root, path, budget=budget,
                unreadable_reason="preimage_unavailable",
            )
    return captured


def read_workspace_file(
    repo_root: Path,
    workspace_root: Path,
    path: str,
    *,
    budget: _Budget,
    unreadable_reason: str,
) -> FileContent:
    """Read one regular file inside the workspace without following links."""
    full_path = repo_root / path
    link_stat = _regular_file_stat(full_path, workspace_root)
    if not isinstance(link_stat, os.stat_result):
        return link_stat or FileContent(exists=True, reason=unreadable_reason)
    refused = budget.admit(int(link_stat.st_size))
    if refused is not None:
        return FileContent(exists=True, reason=refused)
    data = _read_same_file(full_path, link_stat)
    if data is None:
        return FileContent(exists=True, reason=unreadable_reason)
    if len(data) > MAX_FILE_BYTES:
        return FileContent(exists=True, reason="byte_limit")
    return _decoded(data)


def _regular_file_stat(
    full_path: Path, workspace_root: Path
) -> os.stat_result | FileContent | None:
    """lstat of a contained regular file; ``_ABSENT`` when missing; ``None`` otherwise.

    A symlink, junction target, directory or any path whose real path leaves the
    workspace is never opened.
    """
    try:
        link_stat = os.lstat(full_path)
    except FileNotFoundError:
        return _ABSENT
    except OSError:
        return None
    if not stat.S_ISREG(link_stat.st_mode) or not _contained(full_path, workspace_root):
        return None
    return link_stat


def build_scripted_diffs(  # noqa: PLR0913 - one explicit capture context.
    *,
    repo_root: Path,
    workspace_root: Path,
    changed: Sequence[str],
    before_status: Mapping[str, str],
    after_status: Mapping[str, str],
    preimages: Mapping[str, FileContent],
    run_git: RunGit,
    diff_id_prefix: str,
    clock: Callable[[], float] = time.monotonic,
) -> ScriptedDiffs:
    """Diffs for changed paths: at most ``MAX_DIFFS`` entries, none dropped silently."""
    budget = _Budget(clock)
    ordered = order_paths(changed)
    # A sensitive path's HEAD blob is never fetched: its contents stay unread.
    head_paths = [
        path for path in ordered
        if path not in before_status and after_status.get(path) != "??"
        and not is_sensitive_path(path)
    ][:MAX_DIFFS]
    head = _head_contents(head_paths, run_git, budget)
    builder = _DiffBuilder(diff_id_prefix)
    for index, path in enumerate(ordered):
        if len(builder.diffs) >= MAX_DIFFS:
            return builder.finish(omitted=len(ordered) - index)
        before = (
            preimages.get(path) or head.get(path)
            or _missing_preimage(path, before_status, after_status)
        )
        unread = "sensitive_path" if is_sensitive_path(path) else (
            "time_limit" if budget.expired() else None
        )
        if unread is None:
            after = read_workspace_file(
                repo_root, workspace_root, path, budget=budget, unreadable_reason="unknown"
            )
        else:
            after = FileContent(exists=_exists(repo_root, path), reason=unread)
        builder.add_pair(path, before, after)
    return builder.finish(omitted=0)


def build_review(  # noqa: PLR0913 - one explicit review record.
    *,
    state: str,
    call_outcome: str,
    reason: str | None = None,
    changed_paths: Iterable[str] = (),
    diffs: ScriptedDiffs | None = None,
    certainty: str = CERTAINTY,
    restore_point: object = None,
) -> dict[str, Any]:
    """The user-only ``scripted_change_review`` v1 record."""
    ordered = order_paths(changed_paths)
    review: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "state": state,
        "certainty": certainty,
        "call_outcome": call_outcome,
        "changed_paths": [printable(path) for path in ordered[:MAX_REVIEW_PATHS]],
        "changed_path_count": len(ordered),
        "diff_count": len(diffs.diffs) if diffs else 0,
        "summary_only_count": diffs.summary_only_count if diffs else 0,
        "omitted_count": diffs.omitted_count if diffs else 0,
        "coverage": COVERAGE,
    }
    if reason:
        review["reason"] = reason
    point = bounded_restore_point(restore_point)
    if point is not None:
        review["restore_point"] = point
    return review


def observed_state(diffs: ScriptedDiffs) -> str:
    """``partial`` when any changed path lacks a full diff body."""
    return STATE_PARTIAL if diffs.summary_only_count or diffs.omitted_count else STATE_OBSERVED


def summary_only_diffs(
    paths: Sequence[str],
    prefix: str,
    reason: str,
    *,
    statuses: Mapping[str, str] | None = None,
) -> ScriptedDiffs:
    """Path-only entries when content capture failed or was never attempted."""
    builder = _DiffBuilder(prefix)
    ordered = order_paths(paths)
    for path in ordered[:MAX_DIFFS]:
        builder.add_summary(path, (statuses or {}).get(path, "unknown"), reason)
    return builder.finish(omitted=max(0, len(ordered) - MAX_DIFFS))


def scripted_edit_note(paths: Sequence[str]) -> str:
    """One bounded model-facing line naming changed source paths (never content)."""
    if not paths:
        return ""
    names = [printable(path) for path in paths]
    shown = names[:MAX_NOTE_PATHS]
    hidden = len(names) - len(shown)
    more = f" (+{hidden} more)" if hidden else ""
    body = ", ".join(shown)
    budget = MAX_NOTE_CHARS - len(_NOTE_PREFIX) - len(_NOTE_SUFFIX) - len(more)
    if len(body) > budget:
        body = body[: max(0, budget - 3)] + "..."
    return f"{_NOTE_PREFIX}{body}{more}{_NOTE_SUFFIX}"


class _DiffBuilder:
    def __init__(self, prefix: str) -> None:
        self._prefix = prefix
        self.diffs: list[dict[str, Any]] = []
        self._full_bytes = 0
        self._summary_count = 0

    def add_pair(self, path: str, before: FileContent, after: FileContent) -> None:
        status = _status(before.exists, after.exists)
        if status is None or _unchanged(before, after):
            return
        if before.text is None or after.text is None:
            reason = _pair_reason(before, after)
            self.add_summary(path, status, reason)
            return
        diff = compute_structured_diff(
            path, before.text, after.text,
            diff_id=self._next_id(), operation_index=len(self.diffs), status=status,
        )
        if diff is None:
            self.add_summary(path, status, "diff_generation_failed")
            return
        size = len(json.dumps(diff, ensure_ascii=False).encode("utf-8"))
        if self._full_bytes + size > MAX_DIFF_METADATA_BYTES:
            self.add_summary(path, status, "byte_limit")
            return
        self._full_bytes += size
        if diff.get("truncated"):
            self._summary_count += 1
        self.diffs.append({**diff, "path": path})

    def add_summary(self, path: str, status: str | None, reason: str) -> None:
        self._summary_count += 1
        self.diffs.append({
            "diff_id": self._next_id(),
            "operation_index": len(self.diffs),
            "path": path,
            "status": status or "unknown",
            "review_state": "summary_only",
            "body_kind": "summary_only",
            "additions": 0,
            "deletions": 0,
            "truncated": True,
            "truncation_reason": reason if reason in TRUNCATION_REASONS else "unknown",
            "before_hash": None,
            "after_hash": None,
            "hash_kind": "diff_input_text",
            "hunks": [],
        })

    def finish(self, *, omitted: int) -> ScriptedDiffs:
        return ScriptedDiffs(
            diffs=self.diffs, summary_only_count=self._summary_count, omitted_count=omitted
        )

    def _next_id(self) -> str:
        return f"{self._prefix}:{len(self.diffs)}"


def change_status(existed: bool, exists: bool) -> str | None:
    """``created``, ``modified`` or ``deleted`` from existence before and after."""
    return _status(existed, exists)


def _status(existed: bool, exists: bool) -> str | None:
    if existed and exists:
        return "modified"
    if exists:
        return "created"
    return "deleted" if existed else None


def _unchanged(before: FileContent, after: FileContent) -> bool:
    if not (before.exists and after.exists):
        return False
    if before.digest is not None and before.digest == after.digest:
        return True
    return (
        before.text is not None and after.text is not None
        and normalize_diff_input_text(before.text) == normalize_diff_input_text(after.text)
    )


def _pair_reason(before: FileContent, after: FileContent) -> str:
    reasons = [side.reason for side in (before, after) if side.text is None and side.reason]
    for preferred in ("sensitive_path", "binary"):
        if preferred in reasons:
            return preferred
    return reasons[0] if reasons else "unknown"


def _missing_preimage(
    path: str, before_status: Mapping[str, str], after_status: Mapping[str, str]
) -> FileContent:
    """No captured preimage: a new untracked path was absent; others are unknown."""
    if path not in before_status and after_status.get(path) == "??":
        return _ABSENT
    return FileContent(exists=True, reason="preimage_unavailable")


def _sensitive_content(repo_root: Path, path: str) -> FileContent:
    return FileContent(exists=_exists(repo_root, path), reason="sensitive_path")


def _exists(repo_root: Path, path: str) -> bool:
    try:
        os.lstat(repo_root / path)
    except OSError:
        return False
    return True


def _contained(full_path: Path, workspace_root: Path) -> bool:
    try:
        real = Path(os.path.realpath(full_path))
        root = Path(os.path.realpath(workspace_root))
    except (OSError, ValueError):
        return False
    return real == root or real.is_relative_to(root)


def _read_same_file(full_path: Path, link_stat: os.stat_result) -> bytes | None:
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(full_path, flags)
    except OSError:
        return None
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (link_stat.st_dev, link_stat.st_ino):
            return None
        with os.fdopen(descriptor, "rb", closefd=False) as handle:
            return handle.read(MAX_FILE_BYTES + 1)
    except OSError:
        return None
    finally:
        os.close(descriptor)


def _decoded(data: bytes) -> FileContent:
    digest = hashlib.sha256(data).hexdigest()
    if b"\x00" in data:
        return FileContent(exists=True, reason="binary", digest=digest)
    try:
        return FileContent(exists=True, text=data.decode("utf-8"), digest=digest)
    except UnicodeDecodeError:
        return FileContent(exists=True, reason="decode_error", digest=digest)


def _head_contents(paths: list[str], run_git: RunGit, budget: _Budget) -> dict[str, FileContent]:
    """Preimages of clean tracked paths from ``HEAD``; absent there means created."""
    if not paths:
        return {}
    try:
        listing = run_git([
            "ls-tree", "-r", "-l", "-z", "HEAD", "--", *(f":(literal){path}" for path in paths)
        ])
    except Exception:  # noqa: BLE001 - an unborn HEAD or git failure leaves preimages unknown.
        return {path: FileContent(exists=True, reason="preimage_unavailable") for path in paths}
    entries = _parse_tree_listing(listing)
    contents: dict[str, FileContent] = {}
    wanted: list[_Blob] = []
    for path in paths:
        resolved = _head_entry(path, entries.get(path), budget)
        if isinstance(resolved, FileContent):
            contents[path] = resolved
        else:
            wanted.append(resolved)
    contents.update(_fetch_blobs(wanted, run_git, budget))
    return contents


@dataclass(frozen=True)
class _Blob:
    path: str
    oid: str
    size: int


def _head_entry(
    path: str, entry: tuple[str, str, str, str] | None, budget: _Budget
) -> FileContent | _Blob:
    if entry is None:
        return _ABSENT
    mode, kind, oid, size_text = entry
    if is_sensitive_path(path):
        return FileContent(exists=True, reason="sensitive_path")
    if kind != "blob" or mode not in {"100644", "100755"} or not size_text.isdigit():
        return FileContent(exists=True, reason="preimage_unavailable")
    refused = budget.admit(int(size_text))
    if refused is not None:
        return FileContent(exists=True, reason=refused)
    return _Blob(path=path, oid=oid, size=int(size_text))


def _parse_tree_listing(listing: str) -> dict[str, tuple[str, str, str, str]]:
    entries: dict[str, tuple[str, str, str, str]] = {}
    for record in listing.split("\0"):
        meta, tab, path = record.partition("\t")
        fields = meta.split()
        if tab and len(fields) > _TREE_SPLIT_FIELDS:
            entries[path] = (fields[0], fields[1], fields[2], fields[3])
    return entries


def _fetch_blobs(wanted: list[_Blob], run_git: RunGit, budget: _Budget) -> dict[str, FileContent]:
    """Blob text in few ``git show`` calls, each chunk verified against its oid.

    The process layer decodes stdout as UTF-8 with replacement, so an
    undecodable blob breaks the byte split. Chunks before it are exact (their
    oids verify); that blob is reported and the rest are fetched again.
    """
    contents: dict[str, FileContent] = {}
    pending = list(wanted)
    for _attempt in range(MAX_HEAD_BATCH_CALLS):
        if not pending or budget.expired():
            break
        batch = _bounded_batch(pending)
        try:
            output = run_git(["show", "--no-textconv", *(blob.oid for blob in batch)])
        except Exception:  # noqa: BLE001 - the rest stay unavailable.
            break
        by_oid = _split_blobs(output.encode("utf-8"), batch)
        contents.update({blob.path: by_oid[blob.oid] for blob in pending if blob.oid in by_oid})
        pending = [blob for blob in pending if blob.path not in contents]
    for blob in pending:
        contents[blob.path] = FileContent(exists=True, reason="preimage_unavailable")
    return contents


def _bounded_batch(pending: list[_Blob]) -> list[_Blob]:
    """Distinct blobs, at least one, within the stdout capture bound."""
    batch: list[_Blob] = []
    oids: set[str] = set()
    total = 0
    for blob in pending:
        if blob.oid in oids:
            continue
        if batch and total + blob.size > MAX_HEAD_BATCH_BYTES:
            break
        batch.append(blob)
        oids.add(blob.oid)
        total += blob.size
    return batch


def _split_blobs(data: bytes, batch: list[_Blob]) -> dict[str, FileContent]:
    """Contents by oid, up to and including the first chunk that fails to verify."""
    contents: dict[str, FileContent] = {}
    offset = 0
    for blob in batch:
        chunk = data[offset:offset + blob.size]
        if not _blob_matches(chunk, blob):
            contents[blob.oid] = FileContent(exists=True, reason="decode_error")
            return contents
        contents[blob.oid] = _decoded(chunk)
        offset += blob.size
    return contents


def _blob_matches(chunk: bytes, blob: _Blob) -> bool:
    algorithm = _OID_HASHES.get(len(blob.oid))
    if algorithm is None or len(chunk) != blob.size:
        return False
    header = b"blob %d\0" % blob.size
    return hashlib.new(algorithm, header + chunk).hexdigest() == blob.oid
