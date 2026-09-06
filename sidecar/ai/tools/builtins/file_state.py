"""Shared file-state helpers for text reads and mutations."""

from __future__ import annotations

import codecs
import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sidecar.ai.error_codes import (
    CMP_TOOL_CAP_EXCEEDED,
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_IO_FAILED,
    CMP_TOOL_READ_SNAPSHOT_REQUIRED,
    CMP_TOOL_STALE_READ_SNAPSHOT,
)
from sidecar.ai.tools.builtins import edit_hints, pre_change_snapshot, structured_diff
from sidecar.ai.tools.builtins.file_atomic_write import (
    write_bytes_atomic,  # noqa: F401 - compatibility re-export.
    write_bytes_atomic_if_matches,  # noqa: F401 - compatibility re-export.
)
from sidecar.ai.tools.builtins.markdown_sections import (
    extract_markdown_sections,  # noqa: F401 - filesystem compatibility re-export.
    parse_requested_headings,  # noqa: F401 - filesystem compatibility re-export.
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace_path_identity import NodeIdentity

MAX_BINARY_SCAN_BYTES = 8_192
UTF8_ENCODE_CHUNK_CHARS = 64 * 1024
_CONTROL_BINARY_RATIO = 0.10
_STREAM_PREFIX_BYTES = 4
READ_SNAPSHOT_SCOPE_FULL = "full"
READ_SNAPSHOT_SCOPE_PARTIAL = "partial"
_BINARY_CONTROL_BYTES = frozenset((*range(0, 9), 11, 12, *range(14, 32), 127))
UTF8_BOM = codecs.BOM_UTF8
_UNSUPPORTED_BOMS = (
    codecs.BOM_UTF16_LE,
    codecs.BOM_UTF16_BE,
    codecs.BOM_UTF32_LE,
    codecs.BOM_UTF32_BE,
)


def _bounded_utf8_chunk_chars(remaining_budget: int) -> int:
    """Bound the next encode chunk so it can't wildly overshoot ``remaining_budget``.

    A UTF-8 code unit is at most 4 bytes, so ``remaining_budget // 4 + 1`` chars is
    the largest chunk that could still land at or just past the remaining budget.
    Capping at ``UTF8_ENCODE_CHUNK_CHARS`` keeps the chunk from growing unbounded
    for callers with a large/no-op-sized remaining budget; capping at the budget-derived
    size keeps callers with a *small* ``max_bytes`` from paying for a full 64 KiB
    encode buffer on every chunk when the cap will reject long before that fills.
    """

    return max(1, min(UTF8_ENCODE_CHUNK_CHARS, remaining_budget // 4 + 1))


def encode_utf8_text_bounded(
    value: str,
    *,
    max_bytes: int,
    subject: str,
) -> bytes:
    """Encode UTF-8 incrementally without retaining an over-limit byte payload."""

    encoded = bytearray()
    offset = 0
    length = len(value)
    try:
        while offset < length:
            chunk_chars = _bounded_utf8_chunk_chars(max_bytes - len(encoded))
            chunk = value[offset : offset + chunk_chars].encode("utf-8")
            if len(encoded) + len(chunk) > max_bytes:
                raise ToolExecutionFailure(
                    code=CMP_TOOL_CAP_EXCEEDED,
                    message=f"{subject} exceeds {max_bytes} byte limit",
                    retryable=False,
                )
            encoded.extend(chunk)
            offset += chunk_chars
    except UnicodeEncodeError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="content contains invalid Unicode text that cannot be encoded as UTF-8",
            retryable=False,
        ) from error
    return bytes(encoded)
_BINARY_EXTENSIONS = frozenset(
    {
        ".7z",
        ".a",
        ".avi",
        ".bin",
        ".bmp",
        ".class",
        ".dat",
        ".db",
        ".dll",
        ".doc",
        ".docx",
        ".dylib",
        ".eot",
        ".exe",
        ".gif",
        ".gz",
        ".ico",
        ".jar",
        ".jpeg",
        ".jpg",
        ".lib",
        ".mov",
        ".mp3",
        ".mp4",
        ".o",
        ".obj",
        ".otf",
        ".pdf",
        ".png",
        ".pyc",
        ".pyd",
        ".pyo",
        ".so",
        ".sqlite",
        ".tar",
        ".ttf",
        ".wav",
        ".webm",
        ".webp",
        ".woff",
        ".woff2",
        ".xls",
        ".xlsx",
        ".zip",
    }
)

@dataclass(frozen=True)
class ReadSnapshot:
    path: str
    scope: str
    size_bytes: int
    mtime_ns: int
    sha256: str | None = None
    encoding: str | None = None

    def to_metadata(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "path": self.path,
            "scope": self.scope,
            "size_bytes": self.size_bytes,
            "mtime_ns": self.mtime_ns,
        }
        if self.sha256 is not None:
            payload["sha256"] = self.sha256
        if self.encoding is not None:
            payload["encoding"] = self.encoding
        return payload


@dataclass(frozen=True)
class ExistingTextState:
    raw_bytes: bytes
    text: str
    snapshot: ReadSnapshot
    # True when a valid read snapshot was present and matched (the strong
    # stale-write guarantee ran). False only on the edit_file content-anchored
    # fallback path, where no usable snapshot was available and the caller's
    # unique-target match is what protects the write. Always True for callers
    # that require a snapshot (write_file, apply_patch).
    snapshot_validated: bool = True
    encoding: str = "utf-8"

    @property
    def has_utf8_bom(self) -> bool:
        return self.encoding == "utf-8-sig"


@dataclass(frozen=True)
class DecodedTextState:
    text: str
    encoding: str

    @property
    def has_utf8_bom(self) -> bool:
        return self.encoding == "utf-8-sig"


def is_binary_extension(path: Path) -> bool:
    return path.suffix.lower() in _BINARY_EXTENSIONS


def is_binary_content(buffer: bytes) -> bool:
    if not buffer:
        return False
    sample = buffer[:MAX_BINARY_SCAN_BYTES]
    if b"\x00" in sample:
        return True
    control_bytes = sum(byte in _BINARY_CONTROL_BYTES for byte in sample)
    return (control_bytes / len(sample)) > _CONTROL_BINARY_RATIO


def is_binary_file(path: Path) -> bool:
    if is_binary_extension(path):
        return True
    try:
        with path.open("rb") as handle:
            return is_binary_content(handle.read(MAX_BINARY_SCAN_BYTES))
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"failed to inspect file: {error}",
            retryable=True,
        ) from error


def decode_text_bytes(raw_bytes: bytes) -> str:
    return raw_bytes.decode("utf-8", errors="replace")


def decode_text_bytes_strict(raw_bytes: bytes, *, relative_path: str) -> str:
    """Decode ``raw_bytes`` as UTF-8, refusing to swallow decode errors.

    Lossy replacement is never safe for an editable/read-authorizing view:
    silently replacing invalid bytes with U+FFFD would permanently bake
    corruption into the file on the next write. A leading UTF-8 BOM is handled
    explicitly as metadata; UTF-16/32 markers remain outside the text contract.
    """
    return decode_text_state_strict(raw_bytes, relative_path=relative_path).text


def decode_text_state_strict(raw_bytes: bytes, *, relative_path: str) -> DecodedTextState:
    """Decode valid UTF-8 while treating a leading UTF-8 BOM as encoding metadata."""
    _reject_unsupported_bom(raw_bytes, relative_path=relative_path)
    has_utf8_bom = raw_bytes.startswith(UTF8_BOM)
    payload = raw_bytes[len(UTF8_BOM) :] if has_utf8_bom else raw_bytes
    try:
        return DecodedTextState(
            text=payload.decode("utf-8", errors="strict"),
            encoding="utf-8-sig" if has_utf8_bom else "utf-8",
        )
    except UnicodeDecodeError as error:
        raise _encoding_failure(relative_path) from error


def encode_text_for_existing_file(
    value: str,
    *,
    max_bytes: int,
    subject: str,
    preserve_utf8_bom: bool,
    normalize_bom: bool = False,
) -> bytes:
    """Encode marker-free text and optionally restore one leading UTF-8 BOM."""
    payload_budget = max_bytes - (len(UTF8_BOM) if preserve_utf8_bom else 0)
    if payload_budget < 0:
        raise ToolExecutionFailure(
            code=CMP_TOOL_CAP_EXCEEDED,
            message=f"{subject} exceeds {max_bytes} byte limit",
            retryable=False,
        )
    normalized_value = value.lstrip("\ufeff") if (preserve_utf8_bom or normalize_bom) else value
    encoded = encode_utf8_text_bounded(
        normalized_value, max_bytes=payload_budget, subject=subject
    )
    return (UTF8_BOM + encoded) if preserve_utf8_bom else encoded


class StrictUtf8StreamValidator:
    """Incrementally validate one file without splitting UTF-8 codepoints."""

    def __init__(self, *, relative_path: str) -> None:
        self._relative_path = relative_path
        self._decoder = codecs.getincrementaldecoder("utf-8-sig")("strict")
        self._prefix = bytearray()
        self._started = False

    def feed(self, chunk: bytes) -> None:
        if not chunk:
            return
        if not self._started:
            self._prefix.extend(chunk)
            if len(self._prefix) < _STREAM_PREFIX_BYTES:
                return
            chunk = bytes(self._prefix)
            self._prefix.clear()
            _reject_unsupported_bom(chunk, relative_path=self._relative_path)
            self._started = True
        self._decode(chunk, final=False)

    def finish(self) -> None:
        if not self._started:
            chunk = bytes(self._prefix)
            self._prefix.clear()
            _reject_unsupported_bom(chunk, relative_path=self._relative_path)
            self._started = True
            self._decode(chunk, final=True)
            return
        self._decode(b"", final=True)

    def _decode(self, chunk: bytes, *, final: bool) -> None:
        try:
            self._decoder.decode(chunk, final=final)
        except UnicodeDecodeError as error:
            raise _encoding_failure(self._relative_path) from error


def _reject_unsupported_bom(raw_bytes: bytes, *, relative_path: str) -> None:
    if any(raw_bytes.startswith(marker) for marker in _UNSUPPORTED_BOMS):
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=(
                "UTF-16/32 BOM text is not editable as UTF-8; text operation refused: "
                f"{relative_path}"
            ),
            retryable=False,
        )


def _encoding_failure(relative_path: str) -> ToolExecutionFailure:
    return ToolExecutionFailure(
        code=CMP_TOOL_IO_FAILED,
        message=(
            "file is not valid UTF-8; text operation refused to avoid "
            f"corrupting it: {relative_path}"
        ),
        retryable=False,
    )


def refuse_reserved_internal_path(path: str, *, action: str) -> None:
    normalized = path.strip().replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    # Case-insensitive: Windows/macOS filesystems fold case, so ".JENNY/x" would
    # otherwise land inside the reserved store.
    normalized = normalized.lower()
    if normalized == ".jenny" or normalized.startswith(".jenny/"):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"Ordinary file tools cannot {action} reserved .jenny internal state.",
            retryable=False,
        )


def build_no_match_message(content: str, old_string: str, relative_path: str) -> str:
    """Build an actionable no-match error: base hint, an optional whitespace-only
    diagnosis, and the closest matching region so a small model can self-correct.

    ``content`` and ``old_string`` are newline-normalized (LF)."""
    parts = [
        f"Target string not found in file: {relative_path}. "
        "Check whitespace, line endings, or whether the file was already edited."
    ]
    if edit_hints.collapse_horizontal_whitespace(content).count(
        edit_hints.collapse_horizontal_whitespace(old_string)
    ):
        parts.append(
            "A region differing only in whitespace/indentation was found — copy the "
            "exact spacing from the file into old_string."
        )
    excerpt = edit_hints.closest_region_excerpt(content.split("\n"), old_string)
    if excerpt:
        parts.append(excerpt)
    mismatch = edit_hints.first_difference_diagnostic(content, old_string)
    if mismatch:
        parts.append(mismatch)
    return "\n".join(parts)


def build_read_snapshot(
    *,
    relative_path: str,
    scope: str,
    stat_result: os.stat_result,
    raw_bytes: bytes | None = None,
    encoding: str | None = None,
) -> ReadSnapshot:
    if scope not in {READ_SNAPSHOT_SCOPE_FULL, READ_SNAPSHOT_SCOPE_PARTIAL}:
        raise ValueError(f"unsupported read snapshot scope: {scope}")
    sha256 = None
    if scope == READ_SNAPSHOT_SCOPE_FULL:
        if raw_bytes is None:
            raise ValueError("full read snapshots require raw_bytes")
        sha256 = hashlib.sha256(raw_bytes).hexdigest()
    return ReadSnapshot(
        path=relative_path,
        scope=scope,
        size_bytes=max(int(stat_result.st_size), 0),
        mtime_ns=max(int(stat_result.st_mtime_ns), 0),
        sha256=sha256,
        encoding=encoding,
    )


def read_capped_bytes(
    resolved: Path,
    *,
    max_bytes: int,
    relative_path: str,
) -> tuple[os.stat_result, bytes]:
    """Read at most ``max_bytes`` (+1, to positively detect an over-cap file) from
    ``resolved`` via a single opened handle, refusing if the file's identity changes
    or its size grows across the read.

    A separate pre-open stat (e.g. ``workspace.check_file_size``) only bounds the
    size *before* the handle is opened; without this identity/size revalidation, a
    file that is swapped for a different inode or that grows in place between that
    check and the read completing could still hand back more than the caller ever
    agreed to cap the read at.
    """
    try:
        pre_stat = resolved.stat()
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"failed to stat file: {error}",
            retryable=True,
        ) from error
    pre_identity = NodeIdentity.from_stat(pre_stat)
    try:
        with open(resolved, "rb") as fh:
            open_stat = os.fstat(fh.fileno())
            if not NodeIdentity.from_stat(open_stat).same_object(pre_identity):
                raise ToolExecutionFailure(
                    code=CMP_TOOL_IO_FAILED,
                    message=f"file changed identity while opening: {relative_path}",
                    retryable=True,
                )
            raw_bytes = fh.read(max_bytes + 1)
            post_stat = os.fstat(fh.fileno())
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"failed to read file: {error}",
            retryable=True,
        ) from error
    if not NodeIdentity.from_stat(post_stat).same_object(pre_identity):
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"file changed identity while reading: {relative_path}",
            retryable=True,
        )
    if post_stat.st_size > open_stat.st_size:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=(
                f"file grew while being read; refusing a possibly-incomplete "
                f"view: {relative_path}"
            ),
            retryable=True,
        )
    if len(raw_bytes) > max_bytes:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"file exceeds {max_bytes} byte limit: {relative_path}",
            retryable=False,
        )
    return open_stat, raw_bytes


def read_snapshot_from_metadata(value: object) -> ReadSnapshot | None:
    if not isinstance(value, dict):
        return None
    path = value.get("path")
    scope = value.get("scope")
    size_bytes = value.get("size_bytes")
    mtime_ns = value.get("mtime_ns")
    sha256 = value.get("sha256")
    encoding = value.get("encoding")
    if not isinstance(path, str) or not path.strip():
        return None
    if scope not in {READ_SNAPSHOT_SCOPE_FULL, READ_SNAPSHOT_SCOPE_PARTIAL}:
        return None
    if isinstance(size_bytes, bool) or not isinstance(size_bytes, int) or size_bytes < 0:
        return None
    if isinstance(mtime_ns, bool) or not isinstance(mtime_ns, int) or mtime_ns < 0:
        return None
    if sha256 is not None and (not isinstance(sha256, str) or not sha256.strip()):
        return None
    if encoding is not None and encoding not in {"utf-8", "utf-8-sig"}:
        return None
    normalized_sha = sha256.strip() if isinstance(sha256, str) else None
    if scope == READ_SNAPSHOT_SCOPE_FULL and normalized_sha is None:
        return None
    if scope == READ_SNAPSHOT_SCOPE_PARTIAL:
        normalized_sha = None
    return ReadSnapshot(
        path=path.strip(),
        scope=scope,
        size_bytes=size_bytes,
        mtime_ns=mtime_ns,
        sha256=normalized_sha,
        encoding=encoding,
    )


def require_full_read_snapshot(
    value: object,
    *,
    relative_path: str,
    action: str,
) -> ReadSnapshot:
    snapshot = read_snapshot_from_metadata(value)
    if snapshot is None or snapshot.scope != READ_SNAPSHOT_SCOPE_FULL:
        raise ToolExecutionFailure(
            code=CMP_TOOL_READ_SNAPSHOT_REQUIRED,
            message=(
                f"Existing file '{relative_path}' must be read in this conversation before {action}. "  # noqa: E501
                f"Call read_file on '{relative_path}' with no offset/limit (a full read), then retry. "  # noqa: E501
                "The read snapshot is applied automatically — do not set expected_read_snapshot yourself."  # noqa: E501
            ),
            retryable=False,
        )
    if snapshot.path.replace("\\", "/") != relative_path.replace("\\", "/"):
        raise ToolExecutionFailure(
            code=CMP_TOOL_STALE_READ_SNAPSHOT,
            message=(
                f"expected_read_snapshot path mismatch for '{relative_path}'. "
                "Read the current file again and retry with the new metadata.read_snapshot."
            ),
            retryable=False,
        )
    return snapshot


def resolve_optional_read_snapshot(
    value: object,
    *,
    relative_path: str,
) -> ReadSnapshot | None:
    """Return a usable full read snapshot for ``relative_path`` or ``None``.

    The optional counterpart to :func:`require_full_read_snapshot`: it never
    raises. A missing, malformed, partial-scope, or path-mismatched value
    resolves to ``None`` so the caller can fall back to content-anchored
    stale-write protection instead of hard-failing. Only a well-formed, full,
    path-matching snapshot (the shape auto-injected from a prior full
    ``read_file``) is returned for strict equality validation.
    """
    snapshot = read_snapshot_from_metadata(value)
    if snapshot is None or snapshot.scope != READ_SNAPSHOT_SCOPE_FULL:
        return None
    if snapshot.path.replace("\\", "/") != relative_path.replace("\\", "/"):
        return None
    return snapshot


def validate_current_snapshot(
    *,
    expected_snapshot: ReadSnapshot,
    current_snapshot: ReadSnapshot,
    relative_path: str,
    action: str,
) -> None:
    if current_snapshot.scope != READ_SNAPSHOT_SCOPE_FULL or current_snapshot.sha256 is None:
        raise ValueError("current_snapshot must be a full snapshot with sha256")
    # The full snapshot's raw-byte digest is authoritative. Editors, indexers,
    # and backup software may update mtime without changing content; treating
    # metadata alone as stale creates false conflicts despite byte identity.
    if expected_snapshot.sha256 != current_snapshot.sha256:
        expected_hash = str(expected_snapshot.sha256 or "")[:12]
        current_hash = str(current_snapshot.sha256 or "")[:12]
        raise ToolExecutionFailure(
            code=CMP_TOOL_STALE_READ_SNAPSHOT,
            message=(
                f"File '{relative_path}' changed since it was read. "
                f"Read the file again before attempting to {action}. "
                f"Expected size={expected_snapshot.size_bytes}, "
                f"mtime_ns={expected_snapshot.mtime_ns}, "
                f"sha256={expected_hash}; current size={current_snapshot.size_bytes}, "
                f"mtime_ns={current_snapshot.mtime_ns}, sha256={current_hash}; "
                "content_changed=true."
            ),
            retryable=False,
            error_details={
                "classification": "stale_snapshot",
                "expected_size": expected_snapshot.size_bytes,
                "current_size": current_snapshot.size_bytes,
                "expected_mtime_ns": expected_snapshot.mtime_ns,
                "current_mtime_ns": current_snapshot.mtime_ns,
                "expected_sha256": expected_hash,
                "current_sha256": current_hash,
                "content_changed": True,
            },
        )


def load_existing_text_state_for_mutation(  # noqa: PLR0913 - shared mutation seam.
    *,
    path: Path,
    relative_path: str,
    max_bytes: int,
    expected_snapshot_value: object,
    action: str,
    require_read_snapshot: bool = True,
    strict_decode: bool = True,
) -> ExistingTextState:
    """Load the on-disk bytes/text of an existing file ahead of a mutation.

    ``strict_decode`` (default ``True``) governs how the bytes are decoded:
    callers that re-encode the resulting ``.text`` and write it back to disk
    (edit_file, apply_patch update) must keep the default so invalid UTF-8
    refuses the mutation instead of silently baking U+FFFD into the file.
    A caller that never writes decoded text back (currently apply_patch delete
    metadata only) may pass ``strict_decode=False`` explicitly. Read views that
    authorize later writes and every existing-file text mutator remain strict.
    """
    try:
        with open(path, "rb") as handle:
            stat_result = os.fstat(handle.fileno())
            if stat_result.st_size > max_bytes:
                raise ToolExecutionFailure(
                    code=CMP_TOOL_IO_FAILED,
                    message=f"file exceeds {max_bytes} byte limit: {path.name}",
                    retryable=False,
                )
            raw_bytes = handle.read()
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"failed to read file: {error}",
            retryable=True,
        ) from error

    if is_binary_extension(path) or is_binary_content(raw_bytes):
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"binary files are not supported for {action}: {relative_path}",
            retryable=False,
        )

    current_snapshot = build_read_snapshot(
        relative_path=relative_path,
        scope=READ_SNAPSHOT_SCOPE_FULL,
        stat_result=stat_result,
        raw_bytes=raw_bytes,
    )

    if require_read_snapshot:
        expected_snapshot: ReadSnapshot | None = require_full_read_snapshot(
            expected_snapshot_value,
            relative_path=relative_path,
            action=action,
        )
    else:
        # Optional path (edit_file): a usable snapshot still gets the strong
        # equality check; a missing/malformed one falls back to the caller's
        # content-anchored (unique-target) protection rather than hard-failing.
        expected_snapshot = resolve_optional_read_snapshot(
            expected_snapshot_value,
            relative_path=relative_path,
        )

    if expected_snapshot is not None:
        validate_current_snapshot(
            expected_snapshot=expected_snapshot,
            current_snapshot=current_snapshot,
            relative_path=relative_path,
            action=action,
        )
    if strict_decode:
        decoded = decode_text_state_strict(raw_bytes, relative_path=relative_path)
    else:
        try:
            decoded = decode_text_state_strict(raw_bytes, relative_path=relative_path)
        except ToolExecutionFailure:
            decoded = DecodedTextState(text=decode_text_bytes(raw_bytes), encoding="utf-8")
    return ExistingTextState(
        raw_bytes=raw_bytes,
        text=decoded.text,
        snapshot=current_snapshot,
        snapshot_validated=expected_snapshot is not None,
        encoding=decoded.encoding,
    )


def attach_structured_diff_metadata(  # noqa: PLR0913 - metadata context seam.
    metadata: dict[str, object],
    *,
    path: str,
    old_text: object,
    new_text: object,
    status: str,
    logger: Any,
    pre_change_snapshot_root: str | None = None,
) -> None:
    if status != "created":
        try:
            pre_change_snapshot.capture(pre_change_snapshot_root, path, old_text)
        except Exception:  # noqa: BLE001 - capture is strictly fail-open.
            pass
    diff: dict[str, Any] | None
    try:
        diff = structured_diff.compute_structured_diff(
            path,
            old_text,
            new_text,
            status=status,
            logger=logger,
        )
    except Exception as error:  # noqa: BLE001
        structured_diff.log_diff_failure(logger, path, error)
        diff = None
    if diff is None:
        metadata["diff"] = structured_diff.build_failed_diff_metadata(
            path,
            old_text,
            new_text,
            status=status,
        )
        warnings = metadata.get("warnings")
        metadata["warnings"] = [
            *(warnings if isinstance(warnings, list) else []),
            structured_diff.diff_generation_warning(),
        ]
        return
    metadata["diff"] = diff
