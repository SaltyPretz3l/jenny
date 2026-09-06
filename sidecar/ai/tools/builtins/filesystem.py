"""Filesystem tool builtins scoped to tools workspace root."""

from __future__ import annotations

import codecs
import logging
import os
from pathlib import Path
from typing import Any, Callable

from sidecar.ai.error_codes import (
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_IO_FAILED,
)
from sidecar.ai.tools.builtins.file_history import (
    CheckpointInfo,
    checkpoint_lock_for,
    checkpoint_store_lock_for,
    create_checkpoint,
    create_store_checkpoint,
    materialize_checkpoint_plan,
    plan_checkpoint,
)
from sidecar.ai.tools.builtins.file_state import (
    READ_SNAPSHOT_SCOPE_FULL,
    READ_SNAPSHOT_SCOPE_PARTIAL,
    StrictUtf8StreamValidator,
    attach_structured_diff_metadata,
    build_read_snapshot,
    decode_text_state_strict,
    encode_text_for_existing_file,
    extract_markdown_sections,
    is_binary_content,
    is_binary_extension,
    is_binary_file,
    load_existing_text_state_for_mutation,
    parse_requested_headings,
    read_capped_bytes,
    refuse_reserved_internal_path,
    require_full_read_snapshot,
    validate_current_snapshot,
    write_bytes_atomic,
)
from sidecar.ai.tools.builtins.filesystem_content import is_supported_media_path, read_media_file
from sidecar.ai.tools.builtins.filesystem_rich import RICH_FILE_SUFFIXES, read_rich_file
from sidecar.ai.tools.builtins.filesystem_settings import (
    _FILESYSTEM_SETTINGS,
)
from sidecar.ai.tools.builtins.filesystem_settings import (
    DEFAULT_MAX_EDIT_FILE_BYTES as _DEFAULT_MAX_EDIT_FILE_BYTES,
)
from sidecar.ai.tools.builtins.filesystem_settings import (
    configure_filesystem_tools as _configure_filesystem_tools,
)
from sidecar.ai.tools.contracts import (
    ToolExecutionFailure,
    ToolHandlerResult,
    canonicalize_tool_arguments,
)
from sidecar.ai.tools.workspace import WorkspaceGuard

logger = logging.getLogger(__name__)

DEFAULT_MAX_EDIT_FILE_BYTES = _DEFAULT_MAX_EDIT_FILE_BYTES
configure_filesystem_tools = _configure_filesystem_tools

MAX_READ_BYTES = 200_000
MAX_PAGINATED_OUTPUT_BYTES = MAX_READ_BYTES
# The paginated "fast path" reads the whole file into memory to slice a window out
# of it, so it must stay bounded by the same cap the streaming path enforces on its
# *output* (MAX_PAGINATED_OUTPUT_BYTES) rather than a separate, much larger ceiling —
# otherwise a bounded-limit request against a merely-under-10MB file would still pull
# the entire file into memory unbounded before any per-line truncation ever applies.
READ_WINDOW_FAST_PATH_MAX_BYTES = MAX_PAGINATED_OUTPUT_BYTES
READ_WINDOW_CHUNK_BYTES = 512 * 1024
SEARCH_IGNORE_DIRS = frozenset(
    {
        ".bzr",
        ".git",
        ".hg",
        ".jj",
        ".jenny",
        ".sl",
        ".svn",
        "__pycache__",
        "node_modules",
        "venv",
        ".venv",
    }
)


def _as_path_argument(arguments: dict[str, object], *, allow_empty: bool = False) -> str:
    value = arguments.get("path", ".")
    if not isinstance(value, str):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'path' must be a string",
            retryable=False,
        )
    if allow_empty:
        return value
    if value.strip():
        return value
    raise ToolExecutionFailure(
        code=CMP_TOOL_INVALID_PATH,
        message="tool argument 'path' cannot be empty",
        retryable=False,
    )


def current_max_edit_file_bytes() -> int:
    return int(_FILESYSTEM_SETTINGS["max_edit_file_bytes"])


def encode_utf8_text(value: str) -> bytes:
    try:
        return value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="content contains invalid Unicode text that cannot be encoded as UTF-8",
            retryable=False,
        ) from error


def _extract_paginated_int(
    arguments: dict[str, object],
    key: str,
    *,
    minimum: int,
) -> int | None:
    value = arguments.get(key)
    if value is None:
        return None
    if isinstance(value, bool):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"tool argument '{key}' must be an integer",
            retryable=False,
        )
    if isinstance(value, int):
        candidate = value
    elif isinstance(value, str):
        token = value.strip()
        if not token or not token.isdigit():
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message=f"tool argument '{key}' must be an integer",
                retryable=False,
            )
        candidate = int(token)
    else:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"tool argument '{key}' must be an integer",
            retryable=False,
        )
    if candidate < minimum:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=f"tool argument '{key}' must be >= {minimum}",
            retryable=False,
        )
    return candidate


def read_file_tool(arguments: dict[str, object], workspace: WorkspaceGuard) -> ToolHandlerResult:
    path = _as_path_argument(arguments)
    resolved = workspace.resolve_read_path(path)
    relative_path = workspace_relative_path(resolved, workspace.root)
    if not resolved.is_file():
        # Split the failure modes: the generic "must point to a file" left
        # models unable to tell a missing file from a directory and they gave
        # up instead of correcting course.
        if resolved.is_dir():
            message = (
                f"path is a directory, not a file: {path}. "
                "Use list_dir to list its contents."
            )
        else:
            # Missing paths fail earlier in resolve_read_path (strict); this
            # branch is the residue of exotic non-regular-file paths.
            message = f"path is not a regular file: {path}"
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message=message,
            retryable=False,
        )
    headings_requested = "headings" in arguments
    if headings_requested and any(key in arguments for key in ("offset", "limit", "pages")):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'headings' is mutually exclusive with offset, limit, and pages",
            retryable=False,
        )
    if headings_requested and resolved.suffix.lower() not in {".md", ".markdown", ".mdown"}:
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'headings' is only supported for Markdown files",
            retryable=False,
        )
    if _FILESYSTEM_SETTINGS["image_read_enabled"] and is_supported_media_path(resolved):
        return read_media_file(
            resolved,
            relative_path=relative_path,
            pages_argument=arguments.get("pages"),
        )
    rich_file_kind = RICH_FILE_SUFFIXES.get(resolved.suffix.lower())
    if _FILESYSTEM_SETTINGS["rich_files_enabled"] and rich_file_kind is not None:
        if "offset" in arguments or "limit" in arguments:
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message=(
                    "tool arguments 'offset' and 'limit' are unsupported "
                    "for rich-file suffixes"
                ),
                retryable=False,
            )
        return read_rich_file(
            kind=rich_file_kind,
            arguments=arguments,
            workspace=workspace,
        )
    if is_binary_file(resolved):
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"binary files are not supported: {path}",
            retryable=False,
        )
    pagination_requested = "offset" in arguments or "limit" in arguments
    if pagination_requested:
        offset = _extract_paginated_int(arguments, "offset", minimum=0) or 0
        limit = _extract_paginated_int(arguments, "limit", minimum=1)
        return _read_file_window(
            resolved=resolved,
            relative_path=relative_path,
            offset=offset,
            limit=limit,
        )
    workspace.check_file_size(resolved, MAX_READ_BYTES)
    stat_result, raw_bytes, content, encoding = _read_decoded_file(
        resolved,
        relative_path=relative_path,
        max_bytes=MAX_READ_BYTES,
    )
    if headings_requested:
        section_read = extract_markdown_sections(
            content,
            parse_requested_headings(arguments["headings"]),
        )
        snapshot = build_read_snapshot(
            relative_path=relative_path,
            scope=READ_SNAPSHOT_SCOPE_PARTIAL,
            stat_result=stat_result,
            encoding=encoding,
        )
        return ToolHandlerResult(
            output=section_read.text,
            success=True,
            metadata={
                "path": relative_path,
                "encoding": encoding,
                "headings": list(section_read.matched_headings),
                "missing_headings": list(section_read.missing_headings),
                "truncated": section_read.truncated,
                "read_snapshot": snapshot.to_metadata(),
            },
        )
    snapshot = build_read_snapshot(
        relative_path=relative_path,
        scope=READ_SNAPSHOT_SCOPE_FULL,
        stat_result=stat_result,
        raw_bytes=raw_bytes,
        encoding=encoding,
    )
    return ToolHandlerResult(
        output=content,
        success=True,
        metadata={
            "path": relative_path,
            "encoding": encoding,
            "read_snapshot": snapshot.to_metadata(),
        },
    )


def _read_file_window(
    *,
    resolved: Path,
    relative_path: str,
    offset: int,
    limit: int | None,
) -> ToolHandlerResult:
    stat_result = _stat_file(resolved)
    file_size = stat_result.st_size
    if file_size <= READ_WINDOW_FAST_PATH_MAX_BYTES:
        return _read_file_window_fast(
            resolved=resolved,
            relative_path=relative_path,
            offset=offset,
            limit=limit,
        )
    return _read_file_window_streaming(
        resolved=resolved,
        relative_path=relative_path,
        stat_result=stat_result,
        offset=offset,
        limit=limit,
    )


def _stat_file(path: Path) -> os.stat_result:
    try:
        return path.stat()
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"failed to stat file: {error}",
            retryable=True,
        ) from error


def _read_decoded_file(
    resolved: Path,
    *,
    relative_path: str,
    max_bytes: int,
) -> tuple[os.stat_result, bytes, str, str]:
    """Read a file's raw bytes — re-stat'd from the open handle so size/mtime stay
    coherent with the bytes that get hashed — plus its decoded text. Shared by the
    unpaginated full read and the fast windowed read so both build byte-identical
    full read snapshots. The read itself is capped and identity-checked (see
    ``read_capped_bytes``) instead of an unbounded ``fh.read()``."""
    stat_result, raw_bytes = read_capped_bytes(
        resolved,
        max_bytes=max_bytes,
        relative_path=relative_path,
    )
    decoded = decode_text_state_strict(raw_bytes, relative_path=relative_path)
    return stat_result, raw_bytes, decoded.text, decoded.encoding


def _read_file_window_fast(
    *,
    resolved: Path,
    relative_path: str,
    offset: int,
    limit: int | None,
) -> ToolHandlerResult:
    # Read the whole file as bytes (re-stat'd from the open handle via _read_decoded_file)
    # so a window that turns out to cover it can be promoted to a full read_snapshot whose
    # sha256/size/mtime match the unpaginated full-read path exactly. The dispatcher only
    # routes here when the file is <= MAX_PAGINATED_OUTPUT_BYTES (READ_WINDOW_FAST_PATH_MAX_BYTES),
    # so the capped read below is bounded to that same ceiling rather than growing unbounded.
    stat_result, raw_bytes, content, encoding = _read_decoded_file(
        resolved,
        relative_path=relative_path,
        max_bytes=MAX_PAGINATED_OUTPUT_BYTES,
    )
    lines = content.splitlines(keepends=True)
    selected_lines: list[str] = []
    selected_bytes = 0
    end_line = None if limit is None else offset + limit
    truncated_by_bytes = False

    for line_index, line in enumerate(lines):
        if line_index < offset:
            continue
        if end_line is not None and line_index >= end_line:
            break
        line_bytes = len(line.encode("utf-8"))
        if selected_bytes + line_bytes > MAX_PAGINATED_OUTPUT_BYTES:
            truncated_by_bytes = True
            break
        selected_lines.append(line)
        selected_bytes += line_bytes

    return _build_read_window_result(
        relative_path=relative_path,
        stat_result=stat_result,
        offset=offset,
        limit=limit,
        total_lines=len(lines),
        selected_lines=selected_lines,
        truncated_by_bytes=truncated_by_bytes,
        full_file_bytes=raw_bytes,
        encoding=encoding,
    )


def _find_line_break(data: bytes, start: int) -> tuple[int, int] | None:
    newline_index = data.find(b"\n", start)
    carriage_index = data.find(b"\r", start)
    if newline_index == -1 and carriage_index == -1:
        return None
    if carriage_index != -1 and (newline_index == -1 or carriage_index < newline_index):
        if carriage_index == len(data) - 1:
            return None
        if data[carriage_index + 1 : carriage_index + 2] == b"\n":
            return carriage_index, 2
        return carriage_index, 1
    return newline_index, 1


def _read_file_window_streaming(
    *,
    resolved: Path,
    relative_path: str,
    stat_result: os.stat_result,
    offset: int,
    limit: int | None,
) -> ToolHandlerResult:
    selected_line_bytes: list[bytes] = []
    selected_bytes = 0
    total_lines = 0
    truncated_by_bytes = False
    end_line = None if limit is None else offset + limit
    buffer = b""
    has_open_line_fragment = False
    has_unscanned_content = False
    utf8_validator = StrictUtf8StreamValidator(relative_path=relative_path)
    has_utf8_bom = False

    def should_collect_line(line_index: int) -> bool:
        if truncated_by_bytes or line_index < offset:
            return False
        return end_line is None or line_index < end_line

    try:
        with resolved.open("rb") as handle:
            while True:
                chunk = handle.read(READ_WINDOW_CHUNK_BYTES)
                if not chunk:
                    break
                first_chunk = total_lines == 0 and not buffer and not selected_line_bytes
                if first_chunk and chunk.startswith(codecs.BOM_UTF8):
                    has_utf8_bom = True
                    chunk = chunk[len(codecs.BOM_UTF8) :]
                utf8_validator.feed(chunk)
                data = buffer + chunk if buffer else chunk
                cursor = 0
                buffer = b""
                while True:
                    boundary = _find_line_break(data, cursor)
                    if boundary is None:
                        break
                    line_end, separator_length = boundary
                    if should_collect_line(total_lines):
                        line_bytes = data[cursor : line_end + separator_length]
                        if selected_bytes + len(line_bytes) > MAX_PAGINATED_OUTPUT_BYTES:
                            truncated_by_bytes = True
                        else:
                            selected_line_bytes.append(line_bytes)
                            selected_bytes += len(line_bytes)
                    total_lines += 1
                    cursor = line_end + separator_length
                    if end_line is not None and total_lines >= end_line:
                        has_unscanned_content = cursor < len(data) or bool(handle.read(1))
                        buffer = b""
                        has_open_line_fragment = False
                        break

                if has_unscanned_content:
                    break

                remainder = data[cursor:]
                has_open_line_fragment = bool(remainder)
                if should_collect_line(total_lines):
                    if selected_bytes + len(remainder) > MAX_PAGINATED_OUTPUT_BYTES:
                        truncated_by_bytes = True
                    else:
                        buffer = remainder
                elif remainder.endswith(b"\r"):
                    # Keep a trailing CR so a CRLF split across chunk boundaries
                    # still counts as one preserved line ending.
                    buffer = b"\r"
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"failed to read file: {error}",
            retryable=True,
        ) from error

    if has_open_line_fragment and not has_unscanned_content:
        if should_collect_line(total_lines):
            if selected_bytes + len(buffer) > MAX_PAGINATED_OUTPUT_BYTES:
                truncated_by_bytes = True
            else:
                selected_line_bytes.append(buffer)
                selected_bytes += len(buffer)
        total_lines += 1

    if not has_unscanned_content:
        # Only finalize the incremental decoder when every fed byte really is the
        # end of the file. When we stopped early (has_unscanned_content), the last
        # fed chunk's tail can be a valid multibyte sequence split at our arbitrary
        # chunk-read boundary, continued by bytes we deliberately never read; calling
        # finish() there would wrongly report a truncation error for perfectly valid
        # UTF-8 that just hasn't finished arriving yet. A genuine mid-content encoding
        # error is still caught immediately by feed() above, regardless of this.
        utf8_validator.finish()
    selected_lines = [line.decode("utf-8", errors="strict") for line in selected_line_bytes]

    return _build_read_window_result(
        relative_path=relative_path,
        stat_result=stat_result,
        offset=offset,
        limit=limit,
        total_lines=total_lines,
        selected_lines=selected_lines,
        truncated_by_bytes=truncated_by_bytes,
        totals_known=not has_unscanned_content,
        has_more=has_unscanned_content,
        encoding="utf-8-sig" if has_utf8_bom else "utf-8",
    )


def _build_read_window_result(
    *,
    relative_path: str,
    stat_result: os.stat_result,
    offset: int,
    limit: int | None,
    total_lines: int,
    selected_lines: list[str],
    truncated_by_bytes: bool,
    full_file_bytes: bytes | None = None,
    totals_known: bool = True,
    has_more: bool = False,
    encoding: str = "utf-8",
) -> ToolHandlerResult:
    returned_line_count = len(selected_lines)
    returned_line_start = (offset + 1) if selected_lines else None
    returned_line_end = (offset + returned_line_count) if selected_lines else None
    requested_limit = limit if limit is not None else "EOF"
    returned_range = (
        f"{returned_line_start}-{returned_line_end}" if returned_line_start is not None else "empty"
    )
    total_label = str(total_lines) if totals_known else f"at least {total_lines}"
    header_lines = [
        f"path: {relative_path}",
        f"requested: offset={offset}, limit={requested_limit}",
        f"returned: lines {returned_range} of {total_label}",
    ]
    if not totals_known:
        header_lines.append("totals_known: false; stopped after the requested window")
    if truncated_by_bytes:
        header_lines.append(
            f"truncated: selected output exceeded {MAX_PAGINATED_OUTPUT_BYTES} bytes; "
            "returning complete lines that fit"
        )
    header = "\n".join(header_lines)
    window_text = "".join(selected_lines)
    output = header if not window_text else f"{header}\n\n{window_text}"
    # A window that starts at the top, isn't byte-truncated, and returned every line has
    # shown the model the whole file, so it earns a full snapshot (sha256 over the real
    # bytes) and can satisfy the read-before-write gate — exactly like an unpaginated
    # read. Without the full bytes in hand (streaming path) it stays a partial snapshot.
    covers_entire_file = (
        full_file_bytes is not None
        and totals_known
        and offset == 0
        and not truncated_by_bytes
        and returned_line_count == total_lines
    )
    snapshot = build_read_snapshot(
        relative_path=relative_path,
        scope=READ_SNAPSHOT_SCOPE_FULL if covers_entire_file else READ_SNAPSHOT_SCOPE_PARTIAL,
        stat_result=stat_result,
        raw_bytes=full_file_bytes if covers_entire_file else None,
        encoding=encoding,
    )
    metadata: dict[str, object] = {
        "path": relative_path,
        "encoding": encoding,
        "paginated": True,
        "offset": offset,
        "limit": limit,
        "total_lines": total_lines if totals_known else None,
        "lines_scanned": total_lines,
        "totals_known": totals_known,
        "has_more": has_more,
        "returned_line_start": returned_line_start,
        "returned_line_end": returned_line_end,
        "returned_line_count": returned_line_count,
        "truncated_by_bytes": truncated_by_bytes,
        "read_snapshot": snapshot.to_metadata(),
    }
    return ToolHandlerResult(output=output, success=True, metadata=metadata)


def write_file_tool(arguments: dict[str, object], workspace: WorkspaceGuard) -> ToolHandlerResult:
    normalized_arguments, _aliases = canonicalize_tool_arguments(
        tool_name="write_file",
        arguments=dict(arguments or {}),
    )
    path = _as_path_argument(normalized_arguments)
    content = normalized_arguments.get("content")
    expected_read_snapshot = normalized_arguments.get("expected_read_snapshot")
    normalize_bom = normalized_arguments.get("normalize_bom") is True
    if not isinstance(content, str):
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="tool argument 'content' must be a string",
            retryable=False,
        )
    artifact_parts = _artifact_store_parts(path, workspace.require_root())
    if artifact_parts is not None and len(artifact_parts) < 2:
        return failure_result(
            message=(
                "Writes under .jenny/artifacts must be session-scoped "
                "(for example .jenny/artifacts/<session-id>/file.ext). "
                "Use create_artifact to create session artifacts."
            ),
            error_code=CMP_TOOL_INVALID_PATH,
            metadata={"path": path.replace("\\", "/")},
        )
    try:
        encoded = encode_text_for_existing_file(
            content,
            max_bytes=current_max_edit_file_bytes(),
            subject=f"write_file content for {path}",
            preserve_utf8_bom=False,
            normalize_bom=normalize_bom,
        )
    except ToolExecutionFailure as error:
        return failure_result(
            message=f"Could not write {path}: {error.message}",
            error_code=error.code,
            metadata={"path": path},
        )
    if artifact_parts is not None:
        relative_path = f".jenny/artifacts/{'/'.join(artifact_parts)}"
        store = workspace.internal_store()
        try:
            artifact_ref = store.resolve("artifacts", artifact_parts)
            with checkpoint_store_lock_for(
                relative_path,
                store,
                timeout_seconds=15.0,
            ):
                return _write_store_artifact_locked(
                    store=store,
                    artifact_ref=artifact_ref,
                    content=content,
                    encoded=encoded,
                    relative_path=relative_path,
                    expected_read_snapshot=expected_read_snapshot,
                    normalize_bom=normalize_bom,
                    pre_change_snapshot_root=workspace.pre_change_snapshot_root,
                    is_object_pinned=workspace.is_recovery_object_pinned,
                )
        except ToolExecutionFailure as error:
            return failure_result(
                message=f"Could not safely write {relative_path}: {error.message}",
                error_code=error.code,
                metadata={"path": relative_path},
            )
    resolved = workspace.resolve_write_path(path)
    relative_path = workspace_relative_path(resolved, workspace.root)
    try:
        refuse_reserved_internal_path(relative_path, action="write")
        with checkpoint_lock_for(
            resolved,
            workspace.require_root(),
            timeout_seconds=15.0,
        ):
            return _write_file_locked(
                resolved=resolved,
                content=content,
                encoded=encoded,
                relative_path=relative_path,
                workspace=workspace,
                expected_read_snapshot=expected_read_snapshot,
                normalize_bom=normalize_bom,
                journal_arguments=normalized_arguments,
            )
    except ToolExecutionFailure as error:
        if error.code not in {CMP_TOOL_INVALID_PATH, CMP_TOOL_IO_FAILED}:
            raise
        return failure_result(
            message=error.message if error.code == CMP_TOOL_INVALID_PATH else (
                f"Could not safely write {relative_path}: {error.message}"
            ),
            error_code=error.code,
            metadata={"path": relative_path},
        )


def _artifact_store_parts(path: str, workspace_root: Path) -> tuple[str, ...] | None:
    requested = Path(path.strip())
    candidate = requested if requested.is_absolute() else workspace_root / requested
    normalized = Path(os.path.abspath(os.path.normpath(str(candidate))))
    parts = normalized.parts
    for index in range(len(parts) - 1):
        if parts[index].lower() != ".jenny" or parts[index + 1].lower() != "artifacts":
            continue
        try:
            marker_parent = Path(*parts[:index]).resolve(strict=True)
        except OSError:
            return None
        if os.path.normcase(str(marker_parent)) == os.path.normcase(str(workspace_root)):
            return parts[index + 2 :]
        return None
    return None


def _write_store_artifact_locked(
    *,
    store: Any,
    artifact_ref: Any,
    content: str,
    encoded: bytes,
    relative_path: str,
    expected_read_snapshot: object,
    normalize_bom: bool,
    pre_change_snapshot_root: str | None,
    is_object_pinned: Callable[[str], bool],
) -> ToolHandlerResult:
    checkpoint = CheckpointInfo(created=False)
    old_text = ""
    diff_status = "created"
    existing = store.read(
        artifact_ref,
        max_bytes=current_max_edit_file_bytes(),
        missing_ok=True,
    )
    if existing is not None:
        if is_binary_extension(Path(relative_path)) or is_binary_content(existing.data):
            return failure_result(
                message=f"Could not write {relative_path}: binary files are not supported",
                error_code=CMP_TOOL_IO_FAILED,
                metadata={"path": relative_path},
            )
        decoded = decode_text_state_strict(existing.data, relative_path=relative_path)
        old_text = decoded.text
        encoded = encode_text_for_existing_file(
            content,
            max_bytes=current_max_edit_file_bytes(),
            subject=f"write_file content for {relative_path}",
            preserve_utf8_bom=decoded.has_utf8_bom and not normalize_bom,
            normalize_bom=normalize_bom,
        )
        current_snapshot = build_read_snapshot(
            relative_path=relative_path,
            scope=READ_SNAPSHOT_SCOPE_FULL,
            stat_result=existing.stat_result,
            raw_bytes=existing.data,
        )
        expected_snapshot = require_full_read_snapshot(
            expected_read_snapshot,
            relative_path=relative_path,
            action="writing",
        )
        validate_current_snapshot(
            expected_snapshot=expected_snapshot,
            current_snapshot=current_snapshot,
            relative_path=relative_path,
            action="writing",
        )
        if existing.data == encoded:
            return ToolHandlerResult(
                output=f"No changes written to {relative_path}.",
                success=True,
                metadata={
                    **build_write_metadata(path=relative_path, bytes_written=0),
                    "changed": False,
                },
            )
        diff_status = "modified"
        checkpoint = create_store_checkpoint(
            artifact_ref, relative_path, store, is_object_pinned=is_object_pinned
        )

    store.write_bytes_atomic(
        artifact_ref,
        encoded,
        max_bytes=current_max_edit_file_bytes(),
    )
    metadata = build_write_metadata(
        path=relative_path,
        bytes_written=len(encoded),
        checkpoint=checkpoint,
    )
    metadata["changed"] = True
    attach_structured_diff_metadata(
        metadata,
        path=relative_path,
        old_text=old_text,
        new_text=content,
        status=diff_status,
        logger=logger,
        pre_change_snapshot_root=pre_change_snapshot_root,
    )
    return ToolHandlerResult(
        output=f"Wrote {len(encoded)} bytes to {relative_path}",
        success=True,
        metadata=metadata,
    )


def _write_file_locked(
    *,
    resolved: Path,
    content: str,
    encoded: bytes,
    relative_path: str,
    workspace: WorkspaceGuard,
    expected_read_snapshot: object,
    normalize_bom: bool,
    journal_arguments: dict[str, object],
) -> ToolHandlerResult:
    checkpoint = CheckpointInfo(created=False)
    checkpoint_plan = CheckpointInfo(created=False)
    old_text = ""
    diff_status = "created"
    journal = workspace.mutation_journal
    try:
        workspace.ensure_safe_mutation_path(resolved)
    except ToolExecutionFailure as error:
        return failure_result(
            message=f"Could not write {relative_path}: {error.message}",
            error_code=error.code,
            metadata={"path": relative_path},
        )
    if resolved.exists():
        if resolved.is_dir():
            raise ToolExecutionFailure(
                code=CMP_TOOL_INVALID_PATH,
                message="path must point to a file",
                retryable=False,
            )
        try:
            existing_state = load_existing_text_state_for_mutation(
                path=resolved,
                relative_path=relative_path,
                max_bytes=current_max_edit_file_bytes(),
                expected_snapshot_value=expected_read_snapshot,
                action="writing",
            )
        except ToolExecutionFailure as error:
            return failure_result(
                message=f"Could not write {relative_path}: {error.message}",
                error_code=error.code,
                metadata={"path": relative_path},
            )
        encoded = encode_text_for_existing_file(
            content,
            max_bytes=current_max_edit_file_bytes(),
            subject=f"write_file content for {relative_path}",
            preserve_utf8_bom=existing_state.has_utf8_bom and not normalize_bom,
            normalize_bom=normalize_bom,
        )
        if existing_state.raw_bytes == encoded:
            return ToolHandlerResult(
                output=f"No changes written to {relative_path}.",
                success=True,
                metadata={
                    **build_write_metadata(path=relative_path, bytes_written=0),
                    "changed": False,
                },
            )
        old_text = existing_state.text
        diff_status = "modified"
        if journal is not None:
            checkpoint_plan = plan_checkpoint(resolved, workspace.require_root())
        else:
            checkpoint = create_checkpoint(
                resolved,
                workspace.require_root(),
                is_object_pinned=workspace.is_recovery_object_pinned,
            )

    prepared = (
        journal.prepare_file_change(
            journal_arguments,
            tool_name="write_file",
            target=resolved,
            relative_path=relative_path,
            new_bytes=encoded,
            checkpoint=checkpoint_plan,
        )
        if journal is not None
        else None
    )

    checkpoint_result = _materialize_write_checkpoint(
        workspace=workspace,
        target=resolved,
        planned=checkpoint_plan,
        journal=journal,
        prepared=prepared,
        fallback=checkpoint,
        relative_path=relative_path,
    )
    if isinstance(checkpoint_result, ToolHandlerResult):
        return checkpoint_result
    checkpoint = checkpoint_result

    try:
        write_bytes_atomic(resolved, encoded, workspace=workspace)
    except ToolExecutionFailure as error:
        failure_metadata: dict[str, object] = {"path": relative_path}
        if prepared is not None and journal is not None:
            failure_metadata["workspace_change_set"] = journal.mark_failed_sequence(
                prepared, prepared.sequences[0]
            )
        return failure_result(
            message=f"Failed to write file: {error.message}",
            error_code=error.code,
            metadata=failure_metadata,
        )

    metadata = build_write_metadata(
        path=relative_path,
        bytes_written=len(encoded),
        checkpoint=checkpoint,
    )
    metadata["changed"] = True
    if prepared is not None and journal is not None:
        metadata["workspace_change_set"] = journal.mark_applied(prepared)
    attach_structured_diff_metadata(
        metadata,
        path=relative_path,
        old_text=old_text,
        new_text=content,
        status=diff_status,
        logger=logger,
        pre_change_snapshot_root=workspace.pre_change_snapshot_root,
    )
    return ToolHandlerResult(
        output=f"Wrote {len(encoded)} bytes to {relative_path}",
        success=True,
        metadata=metadata,
    )


def _checkpoint_failure_result(
    journal: Any,
    prepared: Any,
    relative_path: str,
    error: ToolExecutionFailure,
) -> ToolHandlerResult:
    summary = journal.mark_failed_sequence(prepared, prepared.sequences[0])
    return failure_result(
        message=f"Failed to create recovery checkpoint: {error.message}",
        error_code=error.code,
        metadata={"path": relative_path, "workspace_change_set": summary},
    )


def _materialize_write_checkpoint(  # noqa: PLR0913 - explicit recovery context.
    *,
    workspace: WorkspaceGuard,
    target: Path,
    planned: CheckpointInfo,
    journal: Any,
    prepared: Any,
    fallback: CheckpointInfo,
    relative_path: str,
) -> CheckpointInfo | ToolHandlerResult:
    if prepared is None or journal is None or not target.exists():
        return fallback
    try:
        return materialize_checkpoint_plan(
            target,
            workspace.require_root(),
            planned,
            is_object_pinned=workspace.is_recovery_object_pinned,
        )
    except ToolExecutionFailure as error:
        return _checkpoint_failure_result(journal, prepared, relative_path, error)


def workspace_relative_path(path: Path, root: Path | None) -> str:
    if root is None:
        return path.as_posix()
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def build_write_metadata(
    *,
    path: str,
    bytes_written: int,
    checkpoint: CheckpointInfo | None = None,
) -> dict[str, object]:
    metadata: dict[str, object] = {
        "path": path,
        "bytes_written": bytes_written,
        "checkpoint_created": False,
    }
    if checkpoint and checkpoint.created:
        metadata["checkpoint_created"] = True
        metadata["checkpoint_version"] = checkpoint.version
        metadata["checkpoint_display_path"] = checkpoint.display_path
    return metadata


def failure_result(
    *,
    message: str,
    error_code: str = CMP_TOOL_EXECUTION_FAILED,
    metadata: dict[str, object] | None = None,
) -> ToolHandlerResult:
    return ToolHandlerResult(
        output=message,
        success=False,
        error_code=error_code,
        metadata=dict(metadata or {}),
    )
