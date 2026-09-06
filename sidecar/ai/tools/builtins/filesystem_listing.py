"""The `list_dir` tool: bounded directory listings with per-file sizes.

Split out of `filesystem.py` (which sits near the 1015-line ceiling) so the whole
listing contract -- scan/entry/output caps, per-entry rendering, and the metadata
that must stay truthful to what was actually returned -- lives in one place.
"""

from __future__ import annotations

import os
from itertools import islice
from typing import NamedTuple

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH, CMP_TOOL_IO_FAILED
from sidecar.ai.tools.builtins.filesystem import _as_path_argument, workspace_relative_path
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard

MAX_LIST_ENTRIES = 500
MAX_LIST_SCAN_ENTRIES = 10_000
MAX_LIST_OUTPUT_CHARS = 14_000


class ListedEntry(NamedTuple):
    """One rendered directory entry.

    `size_bytes` is 0 for directories and for files whose size could not be read,
    so callers can sum it unconditionally; `size_unknown` distinguishes the second
    case, which the text output shows as `?`.
    """

    line: str
    size_bytes: int
    size_unknown: bool


def format_entry_size(size_bytes: int) -> str:
    """Render a byte count compactly (``917B``, ``4.2K``, ``128.5M``).

    Binary (1024) steps, kept short because every character here is spent once
    per listed file against ``MAX_LIST_OUTPUT_CHARS``.
    """
    size_bytes = max(int(size_bytes), 0)
    if size_bytes < 1024:
        return f"{size_bytes}B"
    value = float(size_bytes)
    for suffix in ("K", "M", "G"):
        value /= 1024.0
        # Compare the ROUNDED value: 1024**2-1 is 1023.99K, which would render
        # as "1024.0K" rather than promoting to "1.0M".
        if round(value, 1) < 1024.0:
            return f"{value:.1f}{suffix}"
    return f"{value / 1024.0:.1f}T"


def format_list_entry(entry: os.DirEntry[str]) -> ListedEntry | None:
    """Render one directory entry, or None when it cannot be classified at all."""
    try:
        is_dir = entry.is_dir(follow_symlinks=False)
    except OSError:
        return None
    if is_dir:
        return ListedEntry(f"[D] {entry.name}", 0, size_unknown=False)

    # follow_symlinks=False matches the is_dir() call above: same classification,
    # no stat that escapes the workspace root, and no throw on a dangling link.
    try:
        size = max(int(entry.stat(follow_symlinks=False).st_size), 0)
    except OSError:
        # A failed stat() must NOT drop the entry. The name and its [F]
        # classification are already known, and listing completeness is a
        # stronger guarantee than showing a size -- mark the size unknown instead.
        return ListedEntry(f"[F] {entry.name}  ?", 0, size_unknown=True)
    return ListedEntry(f"[F] {entry.name}  {format_entry_size(size)}", size, size_unknown=False)


def list_dir_tool(
    arguments: dict[str, object], workspace: WorkspaceGuard
) -> ToolHandlerResult:
    path = _as_path_argument(arguments, allow_empty=True)
    resolved = workspace.resolve_list_path(path.strip() or ".")
    if not resolved.is_dir():
        raise ToolExecutionFailure(
            code=CMP_TOOL_INVALID_PATH,
            message="path must point to a directory",
            retryable=False,
        )

    try:
        with os.scandir(resolved) as iterator:
            scanned = list(islice(iterator, MAX_LIST_SCAN_ENTRIES + 1))
    except OSError as error:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"failed to list directory: {error}",
            retryable=True,
        ) from error

    scan_complete = len(scanned) <= MAX_LIST_SCAN_ENTRIES
    retained = sorted(scanned[:MAX_LIST_SCAN_ENTRIES], key=lambda entry: entry.name.lower())[
        :MAX_LIST_ENTRIES
    ]
    formatted: list[str] = []
    failed_entries = 0
    omitted_output_entries = 0
    output_chars = 0
    total_size_bytes = 0
    size_unknown_entries = 0
    for entry in retained:
        # A single entry's is_dir() can fail (permission error, a link that broke
        # between scandir and here, etc.). One bad entry must not fail the whole
        # listing — isolate the failure and keep listing the rest.
        rendered = format_list_entry(entry)
        if rendered is None:
            failed_entries += 1
            continue
        separator_chars = 1 if formatted else 0
        if output_chars + separator_chars + len(rendered.line) > MAX_LIST_OUTPUT_CHARS:
            omitted_output_entries += 1
            continue
        formatted.append(rendered.line)
        output_chars += separator_chars + len(rendered.line)
        total_size_bytes += rendered.size_bytes
        size_unknown_entries += int(rendered.size_unknown)
    truncated = bool(
        not scan_complete
        or len(scanned) > MAX_LIST_ENTRIES
        or failed_entries > 0
        or omitted_output_entries > 0
    )
    output = "\n".join(formatted) if formatted else "(empty directory)"
    if truncated:
        output = f"{output}\n...[directory listing truncated]"
    if failed_entries:
        output = f"{output}\n...[{failed_entries} entries could not be inspected and were skipped]"
    relative_path = workspace_relative_path(resolved, workspace.root)
    output = f"path: {relative_path} (workspace-relative) entries: {len(formatted)}\n\n{output}"
    metadata: dict[str, object] = {
        # Truthful to what was actually returned: entries isolated by a failed
        # is_dir() or omitted by the output budget never reached `formatted`.
        "returned_count": len(formatted),
        "total_size_bytes": total_size_bytes,
        "entries_scanned": min(len(scanned), MAX_LIST_SCAN_ENTRIES),
        "entries_skipped": failed_entries,
        "truncated": truncated,
        "totals_known": scan_complete,
        "total_entries": len(scanned) if scan_complete else None,
        "cursor": None,
    }
    if size_unknown_entries:
        # total_size_bytes would otherwise under-report with no signal at all.
        metadata["size_unknown_entries"] = size_unknown_entries
    if omitted_output_entries:
        metadata["omitted_output_entries"] = omitted_output_entries
        metadata["truncation_reason"] = "output_chars"
    return ToolHandlerResult(
        output=output,
        metadata=metadata,
    )
