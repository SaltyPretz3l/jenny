"""Bounded PDF completeness receipts, current-source identity and citation locator checks."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from sidecar.ai.semantic.citations import (
    OK,
    Locator,
    locator_kind_for_path,
    parse_locator,
    validate_locator,
)
from sidecar.ai.tools.builtins.rich_files.base import read_bounded_file_bytes
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard

PDF_PARSER_VERSION = 2
MAX_SOURCE_BYTES = 64 * 1024 * 1024


def root_key_for(path: str) -> str:
    """Canonical root identity shared by catalog and evidence admission."""
    return os.path.normcase(os.path.realpath(path))


def pdf_evidence(  # noqa: PLR0913 -- explicit extraction accounting.
    *, source_hash: str | None, total_pages: int | None = None, examined_pages: int = 0,
    pages_without_text: list[int] | None = None, budget_truncation: str | None = None,
    unavailable: str | None = None,
) -> dict[str, Any]:
    missing = pages_without_text or []
    partial = bool(missing or budget_truncation or total_pages != examined_pages)
    return {
        "parser_id": "pymupdf_text", "parser_version": PDF_PARSER_VERSION,
        "content_kind": "pdf_text", "source_hash": source_hash,
        "status": "unavailable" if unavailable else "partial" if partial else "complete",
        "reason": unavailable or ("budget_truncated" if budget_truncation else
                                  "missing_text_layer" if missing else None),
        "total_pages": total_pages, "examined_pages": examined_pages,
        "pages_without_text": missing, "budget_truncation": budget_truncation,
    }


def with_index_truncation(
    extraction: dict[str, Any] | None, *, max_chunks: int, indexed_through: str,
) -> dict[str, Any] | None:
    """The receipt plus searchable-coverage truncation; extraction fields stay truthful."""
    if extraction is None:
        return None
    return {**extraction, "index_truncation": {
        "max_chunks": max_chunks, "indexed_through": indexed_through}}


def decode_evidence(value: str | None) -> dict[str, Any] | None:
    if not value:
        return None
    try:
        result = json.loads(value)
    except (TypeError, ValueError):
        return None
    if not isinstance(result, dict) or result.get("parser_version") != PDF_PARSER_VERSION:
        return None
    return result


def source_hash(path: Path, guard: WorkspaceGuard) -> str:
    raw = read_bounded_file_bytes(path, max_bytes=MAX_SOURCE_BYTES,
                                 authorized_root=guard.require_root(),
                                 message="Source exceeds the bounded identity check")
    return hashlib.sha256(raw).hexdigest()


def current_source(path: Path, guard: WorkspaceGuard, expected: str | None) -> bool:
    """True only when ``path`` is a regular contained file whose bytes hash to ``expected``.

    A missing hash is not proof of currency: every schema-2 catalog hit and PDF
    status row records one, so an unhashed source is treated as unverifiable.
    """
    if expected is None:
        return False
    try:
        resolved = guard.ensure_within_root(path)
        if path.is_symlink() or not resolved.is_file():
            return False
        return source_hash(resolved, guard) == expected
    except (OSError, ToolExecutionFailure):
        return False


def current_evidence(
    path: Path, guard: WorkspaceGuard, expected: str | None,
    extraction: dict[str, Any] | None = None,
) -> bool:
    """``current_source``, except a hashless ``too_large`` receipt is revalidated by size.

    Such a receipt (no bytes were read) stays current only while the contained
    file still exceeds the container cap; once it shrinks, the failure is obsolete.
    """
    if expected is not None or (extraction or {}).get("reason") != "too_large":
        return current_source(path, guard, expected)
    try:
        resolved = guard.ensure_within_root(path)
        if path.is_symlink() or not resolved.is_file():
            return False
        return resolved.stat().st_size > MAX_SOURCE_BYTES
    except (OSError, ToolExecutionFailure):
        return False


def source_identity(path: Path, guard: WorkspaceGuard) -> dict[str, str] | None:
    """The current hash and citation locator kind of a contained file; None if unreadable."""
    try:
        resolved = guard.ensure_within_root(path)
        if path.is_symlink() or not resolved.is_file():
            return None
        return {"source_hash": source_hash(resolved, guard),
                "locator_kind": locator_kind_for_path(resolved)}
    except (OSError, ToolExecutionFailure):
        return None


def locator_check(
    text: object, path: Path, *, extent: int | None = None,
) -> tuple[Locator | None, str, str]:
    """``(parsed locator, verdict, locator kind path needs)``; only an absent locator is none.

    A supplied blank or whitespace locator is malformed and fails before any read.
    """
    kind = locator_kind_for_path(path)
    if text is None:
        return None, OK, kind
    verdict = validate_locator(text, path, extent=extent)
    return (parse_locator(text) if verdict == OK else None), verdict, kind
