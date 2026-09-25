"""Binary content helpers for image/PDF reads."""

from __future__ import annotations

import importlib
import io
import json
import warnings
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from sidecar.ai.error_codes import (
    CMP_TOOL_CAP_EXCEEDED,
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_IO_FAILED,
    CMP_TOOL_PDF_ADDON_MISSING,
)
from sidecar.ai.tools.builtins import pdf_text
from sidecar.ai.tools.builtins.file_state import (
    open_regular_file,
    workspace_root_from_relative_path,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.trusted_attachments import (
    ATTACHMENT_KIND_IMAGE,
    ATTACHMENT_KIND_PDF_PAGE,
    TRUSTED_ATTACHMENTS_MAX_TOTAL_BYTES,
    build_trusted_attachment,
)
from sidecar.runtime.media_site import pdf_addon_configured

MAX_MEDIA_FILE_BYTES = 25 * 1024 * 1024
MAX_MEDIA_OUTPUT_CHARS = 12_000
MAX_PDF_PAGES = pdf_text.MAX_PDF_PAGES
# Kept under the private name for existing callers and tests.
_parse_pages_argument = pdf_text.parse_pages_argument
# Per-page whole-line text budget. Three pages must still fit under the
# router's MAX_RESPONSE_CHARS (16_000) with room for page metadata.
MAX_PDF_PAGE_TEXT_CHARS = 4000
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
    cursor_argument: object | None = None,
    authorized_root: Path | None = None,
) -> ToolHandlerResult:
    if path.stat().st_size > MAX_MEDIA_FILE_BYTES:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"media file exceeds {MAX_MEDIA_FILE_BYTES} byte limit: {relative_path}",
            retryable=False,
        )
    root = authorized_root or workspace_root_from_relative_path(path, relative_path)
    if path.suffix.lower() == ".pdf":
        return _read_pdf_file(
            path,
            relative_path=relative_path,
            pages_argument=pages_argument,
            cursor_argument=cursor_argument,
            authorized_root=root,
        )
    if pages_argument is not None:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="tool argument 'pages' is only supported for PDF files",
            retryable=False,
        )
    if cursor_argument is not None:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="tool argument 'cursor' is only supported for PDF files",
            retryable=False,
        )
    return _read_image_file(path, relative_path=relative_path, authorized_root=root)


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
        if not pdf_addon_configured():
            message = (
                "PDF reading needs the optional PDF reading add-on, which is not installed. "
                "Tell the user they can install it in Settings › Tools › PDF reading add-on. "
                "Do not retry this PDF until they say it is installed."
            )
        else:
            message = (
                "The PDF reading add-on is installed but could not be loaded. "
                "Tell the user to remove it and install it again in Settings › Tools › "
                "PDF reading add-on. Do not retry this PDF until they say it is reinstalled."
            )
        raise ToolExecutionFailure(
            code=CMP_TOOL_PDF_ADDON_MISSING,
            message=message,
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
        # PDF excerpts are pre-fitted as whole lines against this exact
        # serialized budget; page removal remains a last-resort guard.
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


def _read_image_file(
    path: Path,
    *,
    relative_path: str,
    authorized_root: Path | None = None,
) -> ToolHandlerResult:
    Image, ImageOps = _load_pillow()
    try:
        with warnings.catch_warnings():
            _apply_pillow_safety_warning_policy(Image)
            with open_regular_file(path, "rb", authorized_root=authorized_root) as handle:
                source = Image.open(handle)
                with source:
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


def _attach_pdf_page(
    page: Any,
    *,
    page_number: int,
    remaining_budget: int,
    attachments: list[dict[str, Any]],
) -> tuple[dict[str, object], int]:
    """Render one page into the typed attachment channel.

    Returns the model-visible page fields and the bytes consumed; when no
    complete rendering fits the budget the fields carry a structured reason
    instead (WIDE-021: never a sliced encoding).
    """

    page_budget = min(MAX_ATTACHMENT_IMAGE_BYTES, remaining_budget)
    jpeg_bytes, width, height = (
        _render_pdf_page_image(page, max_bytes=page_budget) if page_budget > 0 else (None, 0, 0)
    )
    fields: dict[str, object] = {
        "page_number": page_number,
        "mime_type": "image/jpeg",
        "width": width,
        "height": height,
    }
    if jpeg_bytes is None:
        fields["attachment_omitted_reason"] = (
            "no complete page rendering fit the attachment byte budget"
        )
        return fields, 0
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
    fields["attachment"] = _attachment_ref_payload(attachment)
    return fields, len(jpeg_bytes)


def _read_pdf_file(
    path: Path,
    *,
    relative_path: str,
    pages_argument: object | None,
    cursor_argument: object | None = None,
    authorized_root: Path | None = None,
) -> ToolHandlerResult:
    fitz = _load_pymupdf()
    attachments: list[dict[str, Any]] = []
    try:
        with open_regular_file(path, "rb", authorized_root=authorized_root) as handle:
            raw_pdf = handle.read(MAX_MEDIA_FILE_BYTES + 1)
        if len(raw_pdf) > MAX_MEDIA_FILE_BYTES:
            raise ToolExecutionFailure(
                code=CMP_TOOL_IO_FAILED,
                message=(
                    f"media file exceeds {MAX_MEDIA_FILE_BYTES} byte limit: {relative_path}"
                ),
                retryable=False,
            )
        digest = pdf_text.document_digest(raw_pdf)
        with fitz.open(stream=raw_pdf, filetype="pdf") as document:
            page_count = int(document.page_count)
            selected_pages, starts, cursor, unread_pages = pdf_text.resolve_selection(
                cursor_argument=cursor_argument,
                pages_argument=pages_argument,
                digest=digest,
                page_count=page_count,
            )
            pages_payload: list[dict[str, object]] = []
            pages_lines: list[list[pdf_text.PdfTextLine]] = []
            attachment_truncated = False
            remaining_budget = TRUSTED_ATTACHMENTS_MAX_TOTAL_BYTES
            # Lazy: pdf_ocr (urllib, hashing, download lock) stays out of the
            # sidecar.server import graph until a PDF is actually read.
            from sidecar.ai.tools.builtins import pdf_ocr  # noqa: PLC0415

            ocr_session = pdf_ocr.PdfOcrSession()
            text_less_pages: list[int] = []
            for page_number in selected_pages:
                page = document.load_page(page_number - 1)
                lines, text_layer, ocr_info = pdf_text.page_lines(
                    page,
                    page_number=page_number,
                    ocr_session=ocr_session,
                    text_less_pages=text_less_pages,
                    tool_name="read_file",
                )
                if cursor is not None:
                    pdf_text.check_cursor_line(cursor, lines, page_number=page_number)
                pages_lines.append(lines)
                page_fields, used_bytes = _attach_pdf_page(
                    page,
                    page_number=page_number,
                    remaining_budget=remaining_budget,
                    attachments=attachments,
                )
                remaining_budget -= used_bytes
                attachment_truncated = attachment_truncated or "attachment" not in page_fields
                page_payload: dict[str, object] = {
                    **page_fields,
                    "text_layer": text_layer,
                    "line_count": len(lines),
                    **pdf_ocr.ocr_page_fields(
                        ocr_info,
                        text_layer=text_layer,
                        session=ocr_session,
                    ),
                }
                pages_payload.append(page_payload)

            ocr_note = ocr_session.note(text_less_pages=text_less_pages)

            def build_payload(excerpts: Sequence[str]) -> dict[str, object]:
                pages = [
                    {
                        **pages_payload[index],
                        **pdf_text.excerpt_fields(
                            pages_lines[index],
                            start=starts[index],
                            excerpt=excerpt,
                            page=selected_pages[index],
                            digest=digest,
                        ),
                    }
                    for index, excerpt in enumerate(excerpts)
                ]
                continuation = pdf_text.continuation_summary(pages)
                built: dict[str, object] = {
                    "kind": "pdf",
                    "path": relative_path,
                    "page_count": page_count,
                    "selected_pages": selected_pages,
                    "pages": pages,
                    **continuation,
                    "truncated": bool(
                        "cursor" in continuation
                        or attachment_truncated
                        or page_count > len(selected_pages)
                    ),
                }
                if unread_pages:
                    built["unread_pages"] = unread_pages
                built["note"] = pdf_text.read_note(ocr_note, unread_pages=unread_pages)
                return built

            # Whole-line budgeting against the exact serialized output, so
            # _build_output's page-dropping guard never fires for PDF reads.
            fitted = pdf_text.fit_excerpts(
                pages_lines,
                starts=starts,
                page_max_chars=MAX_PDF_PAGE_TEXT_CHARS,
                total_max_chars=MAX_MEDIA_OUTPUT_CHARS,
                serialized_length=lambda excerpts: len(
                    json.dumps(
                        build_payload(excerpts), ensure_ascii=False, separators=(",", ":")
                    )
                ),
            )
            payload = build_payload([text for text, _next in fitted])
    except ToolExecutionFailure:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED,
            message=f"failed to read PDF file: {exc}",
            retryable=False,
        ) from exc

    return ToolHandlerResult(
        output=_build_output(payload),
        success=True,
        metadata={
            "kind": "pdf",
            "page_count": page_count,
            "selected_pages": selected_pages,
            "truncated": payload["truncated"],
            "backend": "PyMuPDF",
            "text_less_pages": text_less_pages,
            "ocr_pages": list(ocr_session.used_pages or []),
            "ocr_engines": ocr_session.engines_used,
            "digest": digest,
            "cursor": payload.get("cursor"),
            "line_counts": {
                page_number: len(pages_lines[index])
                for index, page_number in enumerate(selected_pages)
            },
        },
        trusted_attachments=tuple(attachments),
    )
