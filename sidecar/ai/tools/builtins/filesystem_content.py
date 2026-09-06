"""Binary content helpers for image/PDF reads."""

from __future__ import annotations

import importlib
import io
import json
import warnings
from pathlib import Path
from typing import Any

from sidecar.ai.error_codes import (
    CMP_TOOL_CAP_EXCEEDED,
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_IO_FAILED,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.sanitization import sanitize_tool_output
from sidecar.ai.tools.trusted_attachments import (
    ATTACHMENT_KIND_IMAGE,
    ATTACHMENT_KIND_PDF_PAGE,
    TRUSTED_ATTACHMENTS_MAX_TOTAL_BYTES,
    build_trusted_attachment,
)

MAX_MEDIA_FILE_BYTES = 25 * 1024 * 1024
MAX_MEDIA_OUTPUT_CHARS = 12_000
MAX_PDF_PAGES = 3
MAX_PDF_PAGE_TEXT_CHARS = 800
# WIDE-021: refuse rasterization/decoding BEFORE allocation when the declared
# pixel count exceeds this budget (Pillow's lazy open / PyMuPDF page metadata
# expose dimensions without loading pixel data).
MAX_MEDIA_PIXELS = 50_000_000
# Per-encoded-image byte budget for the typed attachment channel (WIDE-019);
# also bounded by the per-result aggregate TRUSTED_ATTACHMENTS_MAX_TOTAL_BYTES.
MAX_ATTACHMENT_IMAGE_BYTES = 1 * 1024 * 1024
_IMAGE_EXTENSIONS = frozenset(
    {
        ".bmp",
        ".gif",
        ".jpeg",
        ".jpg",
        ".png",
        ".tif",
        ".tiff",
        ".webp",
    }
)


def is_supported_media_path(path: Path) -> bool:
    suffix = path.suffix.lower()
    return suffix in _IMAGE_EXTENSIONS or suffix == ".pdf"


def read_media_file(
    path: Path,
    *,
    relative_path: str,
    pages_argument: object | None = None,
) -> ToolHandlerResult:
    if path.stat().st_size > MAX_MEDIA_FILE_BYTES:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"media file exceeds {MAX_MEDIA_FILE_BYTES} byte limit: {relative_path}",
            retryable=False,
        )
    if path.suffix.lower() == ".pdf":
        return _read_pdf_file(path, relative_path=relative_path, pages_argument=pages_argument)
    if pages_argument is not None:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="tool argument 'pages' is only supported for PDF files",
            retryable=False,
        )
    return _read_image_file(path, relative_path=relative_path)


def _load_pillow():
    try:
        image_module = importlib.import_module("PIL.Image")
        image_ops_module = importlib.import_module("PIL.ImageOps")
    except Exception as exc:  # noqa: BLE001
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="image read support requires Pillow to be installed",
            retryable=False,
        ) from exc
    return image_module, image_ops_module


def _load_pymupdf():
    try:
        fitz = importlib.import_module("fitz")
    except Exception as exc:  # noqa: BLE001
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="PDF read support requires PyMuPDF to be installed",
            retryable=False,
        ) from exc
    return fitz


def _is_pillow_pixel_limit_error(exc: BaseException, image_module: Any) -> bool:
    error_type = getattr(image_module, "DecompressionBombError", None)
    warning_type = getattr(image_module, "DecompressionBombWarning", None)
    if error_type is not None and isinstance(exc, error_type):
        return True
    if warning_type is not None and isinstance(exc, warning_type):
        return True
    message = str(exc).lower()
    return (
        "decompression bomb" in message
        or "pixel limit" in message
        or "too many pixels" in message
        or "exceeds pixel" in message
    )


def _pixel_limit_failure(*, target: str) -> ToolExecutionFailure:
    return ToolExecutionFailure(
        code=CMP_TOOL_EXECUTION_FAILED,
        message=f"{target} exceeds Pillow's safe pixel limit; reduce the image dimensions and try again",
        retryable=False,
    )


def _apply_pillow_safety_warning_policy(image_module: Any) -> None:
    warning_type = getattr(image_module, "DecompressionBombWarning", None)
    if warning_type is not None:
        warnings.simplefilter("error", warning_type)


def _preflight_media_pixels(width: int, height: int, *, target: str) -> None:
    """Refuse oversize media from declared dimensions BEFORE any full load.

    WIDE-021: rasterization and pixel decode must never run for a payload the
    budget would reject afterwards — the dimensions are known cheaply (lazy
    Pillow open / PyMuPDF page metadata) so the refusal is free.
    """
    pixels = max(int(width), 0) * max(int(height), 0)
    if pixels > MAX_MEDIA_PIXELS:
        raise ToolExecutionFailure(
            code=CMP_TOOL_CAP_EXCEEDED,
            message=(
                f"{target} dimensions {int(width)}x{int(height)} "
                f"({pixels} pixels) exceed the {MAX_MEDIA_PIXELS} pixel budget; "
                "reduce the media dimensions and try again"
            ),
            retryable=False,
        )


def _encode_complete_jpeg(
    image: Any,
    *,
    max_bytes: int,
) -> tuple[bytes | None, int, int]:
    """Encode ``image`` as the largest COMPLETE JPEG that fits ``max_bytes``.

    WIDE-021: encodings are never sliced — a candidate either fits whole or
    the ladder steps down. If even the smallest candidate exceeds the budget,
    returns ``(None, 0, 0)`` so the caller can omit the attachment with a
    structured reason instead of emitting corrupt media.
    """
    Image, _ = _load_pillow()
    working = image.copy()
    if getattr(working, "mode", "") not in {"RGB", "L"}:
        working = working.convert("RGB")
    dimensions = [768, 640, 512, 384, 256, 192, 128]
    qualities = [82, 72, 62, 52, 45]
    for dimension in dimensions:
        candidate = working.copy()
        candidate.thumbnail((dimension, dimension), Image.Resampling.LANCZOS)
        for quality in qualities:
            buffer = io.BytesIO()
            candidate.save(buffer, format="JPEG", quality=quality, optimize=True)
            encoded = buffer.getvalue()
            if len(encoded) <= max_bytes:
                return encoded, int(candidate.width), int(candidate.height)
    return None, 0, 0


def _build_output(payload: dict[str, object]) -> str:
    """Serialize the model-visible media summary. NEVER contains base64 —
    binary payloads ride the typed trusted-attachment side channel only."""
    trimmed = json.loads(json.dumps(payload, ensure_ascii=False))
    raw = json.dumps(trimmed, ensure_ascii=False, separators=(",", ":"))
    if len(raw) <= MAX_MEDIA_OUTPUT_CHARS:
        return raw
    trimmed["truncated"] = True

    pages = trimmed.get("pages")
    if isinstance(pages, list):
        for page in pages:
            if not isinstance(page, dict):
                continue
            if "text_excerpt" in page:
                page["text_excerpt"] = sanitize_tool_output(
                    page.get("text_excerpt", ""),
                    max_chars=320,
                    tool_name="read_file",
                )
        raw = json.dumps(trimmed, ensure_ascii=False, separators=(",", ":"))
        while len(raw) > MAX_MEDIA_OUTPUT_CHARS and len(pages) > 1:
            pages.pop()
            selected_pages = trimmed.get("selected_pages")
            if isinstance(selected_pages, list) and selected_pages:
                selected_pages.pop()
            raw = json.dumps(trimmed, ensure_ascii=False, separators=(",", ":"))
        return raw

    return json.dumps(trimmed, ensure_ascii=False, separators=(",", ":"))


def _attachment_ref_payload(attachment: dict[str, Any]) -> dict[str, object]:
    """Model-visible reference to a typed attachment (metadata only)."""
    ref: dict[str, object] = {
        "id": attachment["id"],
        "mime_type": attachment["mime_type"],
        "byte_length": attachment["byte_length"],
        "width": attachment["width"],
        "height": attachment["height"],
    }
    if "page_number" in attachment:
        ref["page_number"] = attachment["page_number"]
    return ref


def _read_image_file(path: Path, *, relative_path: str) -> ToolHandlerResult:
    Image, ImageOps = _load_pillow()
    try:
        with warnings.catch_warnings():
            _apply_pillow_safety_warning_policy(Image)
            with Image.open(path) as source:
                # WIDE-021: Pillow's open is lazy — declared dimensions are
                # available here without decoding pixels. Refuse oversize
                # media BEFORE load() allocates the full raster.
                _preflight_media_pixels(
                    int(getattr(source, "width", 0) or 0),
                    int(getattr(source, "height", 0) or 0),
                    target="image",
                )
                source.load()
                image = ImageOps.exif_transpose(source)
                original_width = int(image.width)
                original_height = int(image.height)
                jpeg_bytes, width, height = _encode_complete_jpeg(
                    image,
                    max_bytes=min(
                        MAX_ATTACHMENT_IMAGE_BYTES,
                        TRUSTED_ATTACHMENTS_MAX_TOTAL_BYTES,
                    ),
                )
                if image is not source:
                    image.close()
    except OSError as exc:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"failed to read image file: {exc}",
            retryable=False,
        ) from exc
    except Exception as exc:  # noqa: BLE001
        if _is_pillow_pixel_limit_error(exc, Image):
            raise _pixel_limit_failure(target="image") from exc
        raise

    attachments: tuple[dict[str, Any], ...] = ()
    attachment_refs_payload: list[dict[str, object]] = []
    omitted_reason: str | None = None
    if jpeg_bytes is not None:
        attachment = build_trusted_attachment(
            kind=ATTACHMENT_KIND_IMAGE,
            mime_type="image/jpeg",
            data=jpeg_bytes,
            source_tool="read_file",
            width=width,
            height=height,
        )
        attachments = (attachment,)
        attachment_refs_payload = [_attachment_ref_payload(attachment)]
    else:
        omitted_reason = "no complete encoding fit the attachment byte budget"

    payload = {
        "kind": "image",
        "path": relative_path,
        "mime_type": "image/jpeg",
        "width": width,
        "height": height,
        "original_width": original_width,
        "original_height": original_height,
        "attachments": attachment_refs_payload,
        "truncated": False,
        **({"attachment_omitted_reason": omitted_reason} if omitted_reason else {}),
    }
    return ToolHandlerResult(
        output=_build_output(payload),
        success=True,
        metadata={
            "kind": "image",
            "mime_type": "image/jpeg",
            "width": width,
            "height": height,
            "truncated": False,
            "backend": "Pillow",
        },
        trusted_attachments=attachments,
    )


def _parse_pages_argument(raw_value: object, *, page_count: int) -> list[int]:
    if raw_value is None:
        return list(range(1, min(page_count, MAX_PDF_PAGES) + 1))
    if not isinstance(raw_value, str) or not raw_value.strip():
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="tool argument 'pages' must be a non-empty string like '1-3,5'",
            retryable=False,
        )
    selected: list[int] = []
    seen: set[int] = set()
    for chunk in raw_value.split(","):
        token = chunk.strip()
        if not token:
            continue
        values: range | list[int]
        if "-" in token:
            start_text, end_text = token.split("-", 1)
            if not start_text.strip().isdigit() or not end_text.strip().isdigit():
                raise ToolExecutionFailure(
                    code=CMP_TOOL_EXECUTION_FAILED,
                    message="tool argument 'pages' must contain only positive page numbers",
                    retryable=False,
                )
            start = int(start_text.strip())
            end = int(end_text.strip())
            if start <= 0 or end <= 0 or end < start:
                raise ToolExecutionFailure(
                    code=CMP_TOOL_EXECUTION_FAILED,
                    message="tool argument 'pages' contains an invalid range",
                    retryable=False,
                )
            if start > page_count or end > page_count:
                missing_page = start if start > page_count else end
                raise ToolExecutionFailure(
                    code=CMP_TOOL_EXECUTION_FAILED,
                    message=f"tool argument 'pages' references page {missing_page}, but the PDF has {page_count} pages",
                    retryable=False,
                )
            if (end - start + 1) > MAX_PDF_PAGES:
                raise ToolExecutionFailure(
                    code=CMP_TOOL_EXECUTION_FAILED,
                    message=f'Page range "{token}" exceeds maximum of {MAX_PDF_PAGES} pages per request. Please use a smaller range.',
                    retryable=False,
                )
            values = range(start, end + 1)
        else:
            if not token.isdigit():
                raise ToolExecutionFailure(
                    code=CMP_TOOL_EXECUTION_FAILED,
                    message="tool argument 'pages' must contain only positive page numbers",
                    retryable=False,
                )
            values = [int(token)]
        for value in values:
            if value <= 0 or value > page_count:
                raise ToolExecutionFailure(
                    code=CMP_TOOL_EXECUTION_FAILED,
                    message=f"tool argument 'pages' references page {value}, but the PDF has {page_count} pages",
                    retryable=False,
                )
            if value not in seen:
                selected.append(value)
                seen.add(value)
                if len(selected) > MAX_PDF_PAGES:
                    raise ToolExecutionFailure(
                        code=CMP_TOOL_EXECUTION_FAILED,
                        message=(
                            f"tool argument 'pages' selects {len(selected)} pages, "
                            f"which exceeds the maximum of {MAX_PDF_PAGES} pages per request"
                        ),
                        retryable=False,
                    )
    if not selected:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="tool argument 'pages' did not select any pages",
            retryable=False,
        )
    return selected[:MAX_PDF_PAGES]


_PDF_RENDER_SCALE = 1.25


def _render_pdf_page_image(page: Any, *, max_bytes: int) -> tuple[bytes | None, int, int]:
    fitz = _load_pymupdf()
    # WIDE-021: page dimensions are metadata (MediaBox); refuse an enormous
    # page BEFORE get_pixmap rasterizes it into memory.
    rect = page.rect
    _preflight_media_pixels(
        int(float(rect.width) * _PDF_RENDER_SCALE),
        int(float(rect.height) * _PDF_RENDER_SCALE),
        target="PDF page",
    )
    pixmap = page.get_pixmap(matrix=fitz.Matrix(_PDF_RENDER_SCALE, _PDF_RENDER_SCALE), alpha=False)
    Image, _ = _load_pillow()
    try:
        with warnings.catch_warnings():
            _apply_pillow_safety_warning_policy(Image)
            with Image.open(io.BytesIO(pixmap.tobytes("png"))) as image:
                image.load()
                return _encode_complete_jpeg(image, max_bytes=max_bytes)
    except Exception as exc:  # noqa: BLE001
        if _is_pillow_pixel_limit_error(exc, Image):
            raise _pixel_limit_failure(target="rendered PDF page") from exc
        raise


def _read_pdf_file(
    path: Path,
    *,
    relative_path: str,
    pages_argument: object | None,
) -> ToolHandlerResult:
    fitz = _load_pymupdf()
    attachments: list[dict[str, Any]] = []
    try:
        with fitz.open(path) as document:
            page_count = int(document.page_count)
            selected_pages = _parse_pages_argument(pages_argument, page_count=page_count)
            pages_payload: list[dict[str, object]] = []
            any_truncated = False
            remaining_budget = TRUSTED_ATTACHMENTS_MAX_TOTAL_BYTES
            for page_number in selected_pages:
                page = document.load_page(page_number - 1)
                text_excerpt = sanitize_tool_output(
                    page.get_text("text"),
                    max_chars=MAX_PDF_PAGE_TEXT_CHARS,
                    tool_name="read_file",
                )
                any_truncated = any_truncated or len(text_excerpt) >= MAX_PDF_PAGE_TEXT_CHARS
                page_budget = min(MAX_ATTACHMENT_IMAGE_BYTES, remaining_budget)
                jpeg_bytes, width, height = (
                    _render_pdf_page_image(page, max_bytes=page_budget)
                    if page_budget > 0
                    else (None, 0, 0)
                )
                page_payload: dict[str, object] = {
                    "page_number": page_number,
                    "mime_type": "image/jpeg",
                    "width": width,
                    "height": height,
                    "text_excerpt": text_excerpt,
                }
                if jpeg_bytes is not None:
                    remaining_budget -= len(jpeg_bytes)
                    attachment = build_trusted_attachment(
                        kind=ATTACHMENT_KIND_PDF_PAGE,
                        mime_type="image/jpeg",
                        data=jpeg_bytes,
                        source_tool="read_file",
                        width=width,
                        height=height,
                        page_number=page_number,
                    )
                    attachments.append(attachment)
                    page_payload["attachment"] = _attachment_ref_payload(attachment)
                else:
                    # WIDE-021: never a sliced encoding — omit whole with a
                    # structured reason when no complete rendering fits.
                    page_payload["attachment_omitted_reason"] = (
                        "no complete page rendering fit the attachment byte budget"
                    )
                    any_truncated = True
                pages_payload.append(page_payload)
    except ToolExecutionFailure:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"failed to read PDF file: {exc}",
            retryable=False,
        ) from exc

    payload = {
        "kind": "pdf",
        "path": relative_path,
        "page_count": page_count,
        "selected_pages": selected_pages,
        "pages": pages_payload,
        "truncated": any_truncated or page_count > len(selected_pages),
    }
    return ToolHandlerResult(
        output=_build_output(payload),
        success=True,
        metadata={
            "kind": "pdf",
            "page_count": page_count,
            "selected_pages": selected_pages,
            "truncated": payload["truncated"],
            "backend": "PyMuPDF",
        },
        trusted_attachments=tuple(attachments),
    )
