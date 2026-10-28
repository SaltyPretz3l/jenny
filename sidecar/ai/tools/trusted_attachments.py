"""Typed trusted-attachment transport for first-party media tool results.

First-party tools (read_file media reads, python_execute charts)
intentionally produce bounded binary payloads, but the generic tool-output
sanitizer strips every large inline data URI from model-visible text — by
design, and that stays true. This module is the typed side channel those
payloads ride instead: ``ToolHandlerResult.trusted_attachments`` → builtin MCP
wire (`trusted_attachments`, snake_case) → ``MCPToolResult`` →
``ToolExecutionOutcome``/``ToolResultEvent`` → the live ``tool.result``
notification. Model-visible output text never carries base64.

Admission is fail-closed: attachments are admitted only when the originating
call's tool id is exactly ``read_file`` or ``python_execute`` AND the tool
descriptor's ``source_kind`` is ``builtin``. External MCP tools,
electron-executed tools, and synthetic/replayed results have any
attachment-shaped payload stripped (spoof-drop) with a bounded structured log.

Canonical turn events persist only safe refs (id, kind, mime type, byte
length, dimensions) — never raw bytes or base64.
"""

from __future__ import annotations

import base64
import binascii
import logging
import struct
import uuid
from typing import Any, Iterable

from sidecar.ai.engines.vision_input import MAX_VISION_PIXELS
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

# Tool ids whose builtin results may carry trusted attachments. Exact-match
# allowlist — nothing else is ever admitted.
ATTACHMENT_ADMITTED_TOOL_IDS = frozenset({"read_file", "python_execute"})
ATTACHMENT_ADMITTED_SOURCE_KIND = "builtin"

# Aggregate DECODED bytes admitted per tool result. The base64 wire form of a
# full 2 MiB budget (~2.67 MiB) must stay comfortably under the sidecar's
# 4 MiB outbound queue high-water mark (sidecar/runtime/multiplexer.py); a
# regression test asserts that relationship.
TRUSTED_ATTACHMENTS_MAX_TOTAL_BYTES = 2 * 1024 * 1024

ATTACHMENT_KIND_IMAGE = "image"
ATTACHMENT_KIND_PDF_PAGE = "pdf_page"
ATTACHMENT_KIND_CHART = "chart"
ATTACHMENT_KINDS = frozenset(
    {ATTACHMENT_KIND_IMAGE, ATTACHMENT_KIND_PDF_PAGE, ATTACHMENT_KIND_CHART}
)
ATTACHMENT_MIME_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})

# Wire/metadata key. Kept in one place so the admission layer can also strip
# spoofed attachment-shaped payloads that arrive through result metadata.
TRUSTED_ATTACHMENTS_KEY = "trusted_attachments"

_SPOOF_DROP_LOG_EVENT = "ai.tools.trusted_attachments.spoof_dropped"
_INVALID_DROP_LOG_EVENT = "ai.tools.trusted_attachments.invalid_dropped"
_BUDGET_DROP_LOG_EVENT = "ai.tools.trusted_attachments.budget_dropped"

# Safe-ref fields persisted into canonical turn events. Never bytes/base64.
_REF_FIELDS = ("id", "kind", "mime_type", "byte_length", "width", "height", "page_number")

# Signature sniffing (a local parser: preview_image imports this module).
_PNG_IHDR_END = 24
_WEBP_MIN_BYTES = 30
_VP8L_SIGNATURE = 0x2F
_JPEG_MARKER_PREFIX = 0xFF
_JPEG_MIN_SEGMENT_LENGTH = 2  # the length field counts itself
_JPEG_SCAN_OR_END = frozenset({0xD9, 0xDA})
_JPEG_STANDALONE_MARKERS = frozenset({0x01, *range(0xD0, 0xD8)})
_JPEG_SOF_MARKERS = frozenset({*range(0xC0, 0xC4), *range(0xC5, 0xC8), *range(0xC9, 0xCC),
                               *range(0xCD, 0xD0)})


def base64_encoded_length(decoded_byte_length: int) -> int:
    """Exact base64 text length (with padding) for ``decoded_byte_length`` bytes."""
    return 4 * ((max(0, int(decoded_byte_length)) + 2) // 3)


def build_trusted_attachment(  # noqa: PLR0913 - explicit wire-schema seam.
    *,
    kind: str,
    mime_type: str,
    data: bytes,
    source_tool: str,
    width: int = 0,
    height: int = 0,
    page_number: int | None = None,
) -> dict[str, Any]:
    """Build one wire-shaped (snake_case) trusted attachment from raw bytes.

    The base64 encoding is always COMPLETE — producers must size ``data``
    within budget before calling; encodings are never sliced afterwards.
    """
    if kind not in ATTACHMENT_KINDS:
        raise ValueError(f"unsupported trusted attachment kind: {kind}")
    payload: dict[str, Any] = {
        "id": f"att_{uuid.uuid4().hex}",
        "kind": kind,
        "mime_type": str(mime_type),
        "data_base64": base64.b64encode(data).decode("ascii"),
        "byte_length": len(data),
        "width": max(0, int(width)),
        "height": max(0, int(height)),
        "source_tool": str(source_tool),
    }
    if page_number is not None:
        payload["page_number"] = int(page_number)
    return payload


def parse_wire_attachments(value: object) -> tuple[dict[str, Any], ...]:
    """Lightly shape-check a wire ``trusted_attachments`` list.

    Transport-level only: keeps dict entries and drops everything else.
    Full fail-closed validation (provenance, base64 integrity, budgets)
    happens at the single admission point in ``admit_trusted_attachments``.
    """
    if not isinstance(value, list):
        return ()
    return tuple(entry for entry in value if isinstance(entry, dict))


def _bounded_dimension(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return 0
    return value


def _png_size(data: bytes) -> tuple[int, int] | None:
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR" or len(data) < _PNG_IHDR_END:
        return None
    width, height = struct.unpack(">II", data[16:_PNG_IHDR_END])
    return width, height


def _jpeg_size(data: bytes) -> tuple[int, int] | None:
    """Walk the marker segments to the first start-of-frame; bounded by the data."""
    if data[:3] != b"\xff\xd8\xff":
        return None
    offset = 2
    while offset + 9 <= len(data) and data[offset] == _JPEG_MARKER_PREFIX:
        marker = data[offset + 1]
        if marker == _JPEG_MARKER_PREFIX or marker in _JPEG_STANDALONE_MARKERS:
            offset += 1 if marker == _JPEG_MARKER_PREFIX else 2  # fill byte / no payload
            continue
        length = int.from_bytes(data[offset + 2 : offset + 4], "big")
        if marker in _JPEG_SOF_MARKERS:
            height = int.from_bytes(data[offset + 5 : offset + 7], "big")
            width = int.from_bytes(data[offset + 7 : offset + 9], "big")
            return width, height
        if marker in _JPEG_SCAN_OR_END or length < _JPEG_MIN_SEGMENT_LENGTH:
            return None  # no frame header before the scan, or a malformed segment
        offset += 2 + length
    return None


def _webp_size(data: bytes) -> tuple[int, int] | None:
    if data[:4] != b"RIFF" or data[8:12] != b"WEBP" or len(data) < _WEBP_MIN_BYTES:
        return None
    chunk = data[12:16]
    if chunk == b"VP8 " and data[23:26] == b"\x9d\x01\x2a":
        return (int.from_bytes(data[26:28], "little") & 0x3FFF,
                int.from_bytes(data[28:30], "little") & 0x3FFF)
    if chunk == b"VP8L" and data[20] == _VP8L_SIGNATURE:
        bits = int.from_bytes(data[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if chunk == b"VP8X":
        return int.from_bytes(data[24:27], "little") + 1, int.from_bytes(data[27:30], "little") + 1
    return None


_SNIFFERS = {"image/png": _png_size, "image/jpeg": _jpeg_size, "image/webp": _webp_size}


def _pixels_match_declaration(data: bytes, mime_type: str, width: int, height: int) -> bool:
    """The decoded bytes must carry the declared format's signature, real dimensions
    within the vision pixel cap and, unless undeclared (0 x 0), the declared size."""
    sniffer = _SNIFFERS.get(mime_type)
    size = sniffer(data) if sniffer is not None else None
    if size is None or not size[0] or not size[1] or size[0] * size[1] > MAX_VISION_PIXELS:
        return False
    return (width, height) in {(0, 0), size}


def _validated_attachment(  # noqa: PLR0911 - fail-closed validation ladder.
    entry: dict[str, Any],
) -> dict[str, Any] | None:
    """Validate one attachment fail-closed; return a normalized copy or None."""
    attachment_id = entry.get("id")
    kind = entry.get("kind")
    mime_type = entry.get("mime_type")
    data_base64 = entry.get("data_base64")
    byte_length = entry.get("byte_length")
    if not isinstance(attachment_id, str) or not attachment_id.strip():
        return None
    if kind not in ATTACHMENT_KINDS:
        return None
    if not isinstance(mime_type, str) or mime_type.lower() not in ATTACHMENT_MIME_TYPES:
        return None
    if not isinstance(data_base64, str) or not data_base64:
        return None
    if isinstance(byte_length, bool) or not isinstance(byte_length, int) or byte_length <= 0:
        return None
    # A single attachment larger than the whole aggregate budget can never be
    # admitted; refuse it BEFORE paying for the base64 decode.
    if byte_length > TRUSTED_ATTACHMENTS_MAX_TOTAL_BYTES:
        return None
    if len(data_base64) != base64_encoded_length(byte_length):
        return None
    try:
        decoded = base64.b64decode(data_base64, validate=True)
    except (binascii.Error, ValueError):
        return None
    if len(decoded) != byte_length:
        return None
    width = _bounded_dimension(entry.get("width"))
    height = _bounded_dimension(entry.get("height"))
    if not _pixels_match_declaration(decoded, mime_type.lower(), width, height):
        return None
    page_number = entry.get("page_number")
    normalized: dict[str, Any] = {
        "id": attachment_id.strip(),
        "kind": kind,
        "mime_type": mime_type.lower(),
        "data_base64": data_base64,
        "byte_length": byte_length,
        "width": width,
        "height": height,
        "source_tool": str(entry.get("source_tool") or ""),
    }
    if isinstance(page_number, int) and not isinstance(page_number, bool) and page_number > 0:
        normalized["page_number"] = page_number
    return normalized


def _log_drop(event: str, *, tool_id: str, source_kind: str, count: int, reason: str) -> None:
    log_event(
        logger,
        logging.WARNING,
        component="ai.tools.trusted_attachments",
        event=event,
        message=f"Dropped {count} attachment payload(s) from tool result: {reason}",
        status="dropped",
        data={
            "tool_id": str(tool_id or "")[:120],
            "source_kind": str(source_kind or "")[:40],
            "dropped_count": int(count),
            "reason": reason,
        },
    )


def admit_trusted_attachments(
    *,
    attachments: Iterable[dict[str, Any]],
    tool_id: str,
    source_kind: str,
) -> tuple[dict[str, Any], ...]:
    """Fail-closed admission gate for attachment payloads on a tool result.

    Only results whose originating ``tool_id`` is exactly ``read_file`` or
    ``python_execute`` AND whose descriptor ``source_kind`` is ``builtin`` may
    carry attachments. Anything else — external MCP servers, the Electron tool
    bridge, synthetic/replayed results — is spoof-dropped with a bounded
    structured log line. Admitted attachments are individually validated
    (complete base64, kind/mime allowlists) and the aggregate decoded size is
    capped; an attachment that would exceed the budget is dropped WHOLE, never
    truncated, so every admitted encoding stays complete.
    """
    candidates = [entry for entry in attachments if isinstance(entry, dict)]
    if not candidates:
        return ()
    if (
        tool_id not in ATTACHMENT_ADMITTED_TOOL_IDS
        or source_kind != ATTACHMENT_ADMITTED_SOURCE_KIND
    ):
        _log_drop(
            _SPOOF_DROP_LOG_EVENT,
            tool_id=tool_id,
            source_kind=source_kind,
            count=len(candidates),
            reason="attachments are only admitted from builtin read_file/python_execute results",
        )
        return ()
    admitted: list[dict[str, Any]] = []
    total_bytes = 0
    invalid_count = 0
    budget_dropped = 0
    for entry in candidates:
        validated = _validated_attachment(entry)
        if validated is None:
            invalid_count += 1
            continue
        if total_bytes + validated["byte_length"] > TRUSTED_ATTACHMENTS_MAX_TOTAL_BYTES:
            budget_dropped += 1
            continue
        total_bytes += validated["byte_length"]
        admitted.append(validated)
    if invalid_count:
        _log_drop(
            _INVALID_DROP_LOG_EVENT,
            tool_id=tool_id,
            source_kind=source_kind,
            count=invalid_count,
            reason="attachment failed shape/encoding validation",
        )
    if budget_dropped:
        _log_drop(
            _BUDGET_DROP_LOG_EVENT,
            tool_id=tool_id,
            source_kind=source_kind,
            count=budget_dropped,
            reason=(
                "aggregate decoded attachment budget "
                f"({TRUSTED_ATTACHMENTS_MAX_TOTAL_BYTES} bytes) exceeded"
            ),
        )
    return tuple(admitted)


def strip_attachment_shaped_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    """Remove spoofed attachment-shaped payloads from result metadata.

    The typed field is the ONLY attachment channel; a ``trusted_attachments``
    key smuggled through tool metadata (which flows to the renderer verbatim)
    is stripped unconditionally.
    """
    forbidden = {TRUSTED_ATTACHMENTS_KEY, "preview_image", "previewImage", "data_base64"}
    if not forbidden.intersection(metadata):
        return metadata
    cleaned = {key: value for key, value in metadata.items() if key not in forbidden}
    _log_drop(
        _SPOOF_DROP_LOG_EVENT,
        tool_id="",
        source_kind="metadata",
        count=1,
        reason="attachment-shaped payload stripped from tool result metadata",
    )
    return cleaned


def attachment_refs(attachments: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Project attachments to the safe refs persisted in canonical turn events.

    Refs carry identity and bounded scalars only — id, kind, mime type,
    decoded byte length, dimensions, page number — never bytes or base64.
    """
    refs: list[dict[str, Any]] = []
    for entry in attachments:
        if not isinstance(entry, dict):
            continue
        ref = {field: entry[field] for field in _REF_FIELDS if field in entry}
        if ref.get("id"):
            refs.append(ref)
    return refs
