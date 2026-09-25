"""Read-only rich PDF inspect tool."""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sidecar.ai.error_codes import CMP_TOOL_RICH_FILES_UNSUPPORTED
from sidecar.ai.tools.builtins import filesystem_content, pdf_text
from sidecar.ai.tools.builtins.artifacts import BinaryArtifactSpec, create_binary_artifact
from sidecar.ai.tools.builtins.rich_files.base import (
    MAX_RICH_INSPECT_OUTPUT_CHARS,
    MAX_RICH_INSPECT_STRING_CHARS,
    RichFileSource,
    RichInspectResult,
    RichPreviewResult,
    build_unsupported_result,
    preview_artifact_metadata,
    rich_inspect_result_payload,
    rich_inspect_result_to_tool_result,
    string_argument,
    validate_rich_file_source,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard

PDF_PREVIEW_SCALE = 1.25
MAX_PDF_PREVIEW_PIXELS = 4_000_000
# The rich-inspect serializer clips every summary string at
# MAX_RICH_INSPECT_STRING_CHARS, so the per-page excerpt cap is the smaller of
# the two: anything above it would be marked complete and then cut anyway.
PDF_INSPECT_PAGE_TEXT_CHARS = min(
    filesystem_content.MAX_PDF_PAGE_TEXT_CHARS, MAX_RICH_INSPECT_STRING_CHARS
)


@dataclass(frozen=True)
class PdfPreviewContext:
    workspace: WorkspaceGuard
    session_id: str
    source_path: Path
    fitz: Any


def pdf_inspect_tool(
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
) -> ToolHandlerResult:
    requested_path = string_argument(arguments, "path", required=True)
    source = validate_rich_file_source(
        requested_path=requested_path,
        workspace=workspace,
        adapter="pdf",
        max_bytes=filesystem_content.MAX_MEDIA_FILE_BYTES,
        expected_mime_prefix="application/pdf",
    )
    # A missing or unloadable PDF reading add-on fails the call with
    # CMP-TOOL-0047, so read_file and pdf_inspect tell the model and the chat
    # row the same thing (the row offers "Set up PDF reading").
    fitz = filesystem_content._load_pymupdf()

    try:
        return _inspect_pdf_with_fitz(
            arguments=arguments,
            workspace=workspace,
            source=source,
            fitz=fitz,
        )
    except ToolExecutionFailure:
        raise
    except Exception:  # noqa: BLE001
        return rich_inspect_result_to_tool_result(
            build_unsupported_result(
                adapter="pdf",
                source=source,
                reason="pdf_parse_failed",
            )
        )


def _inspect_pdf_with_fitz(
    *,
    arguments: dict[str, object],
    workspace: WorkspaceGuard,
    source: RichFileSource,
    fitz: Any,
) -> ToolHandlerResult:
    preview_requested = arguments.get("create_preview") is True
    session_id = str(arguments.get("_jenny_session_id") or "").strip()
    warnings_out: list[str] = []
    previews: list[dict[str, object]] = []
    generated_artifacts: list[dict[str, object]] = []

    raw_pdf = source.absolute_path.read_bytes()
    digest = pdf_text.document_digest(raw_pdf)
    with fitz.open(stream=raw_pdf, filetype="pdf") as document:
        page_count = int(document.page_count)
        if page_count <= 0:
            raise ValueError("PDF has no pages")
        selected_pages, starts, cursor, unread_pages = pdf_text.resolve_selection(
            cursor_argument=arguments.get("cursor"),
            pages_argument=arguments.get("pages"),
            digest=digest,
            page_count=page_count,
        )
        source_path = Path(source.workspace_path)
        preview_context = PdfPreviewContext(
            workspace=workspace,
            session_id=session_id,
            source_path=source_path,
            fitz=fitz,
        )
        if preview_requested and not session_id:
            warnings_out.append("preview skipped: session context unavailable")

        # Lazy: keeps pdf_ocr out of the sidecar.server import graph.
        from sidecar.ai.tools.builtins import pdf_ocr  # noqa: PLC0415

        ocr_session = pdf_ocr.PdfOcrSession()
        text_less_pages: list[int] = []
        page_lines: list[list[pdf_text.PdfTextLine]] = []
        page_details: list[dict[str, object]] = []
        for page_number in selected_pages:
            page = document.load_page(page_number - 1)
            lines, text_layer, ocr_info = pdf_text.page_lines(
                page,
                page_number=page_number,
                ocr_session=ocr_session,
                text_less_pages=text_less_pages,
                tool_name="pdf_inspect",
            )
            if cursor is not None:
                pdf_text.check_cursor_line(cursor, lines, page_number=page_number)
            page_lines.append(lines)
            page_detail: dict[str, object] = {
                "page": page_number,
                "text_layer": text_layer,
                **pdf_ocr.ocr_page_fields(
                    ocr_info,
                    text_layer=text_layer,
                    session=ocr_session,
                ),
            }
            page_details.append(page_detail)

            if preview_requested and session_id:
                preview_result = _create_pdf_page_preview(
                    context=preview_context,
                    page=page,
                    page_number=page_number,
                )
                previews.extend(preview_result.previews)
                warnings_out.extend(preview_result.warnings)
                generated_artifacts.extend(preview_result.generated_artifacts)

    ocr_note = ocr_session.note(text_less_pages=text_less_pages)

    def build_result(excerpts: Sequence[str]) -> RichInspectResult:
        pages = [
            {
                **page_details[index],
                **pdf_text.excerpt_fields(
                    page_lines[index],
                    start=starts[index],
                    excerpt=excerpt,
                    page=selected_pages[index],
                    digest=digest,
                ),
            }
            for index, excerpt in enumerate(excerpts)
        ]
        continuation = pdf_text.continuation_summary(pages)
        summary: dict[str, object] = {
            "page_count": page_count,
            "selected_pages": selected_pages,
            "pages": pages,
            **continuation,
            "truncated": page_count > len(selected_pages) or "cursor" in continuation,
        }
        if unread_pages:
            summary["unread_pages"] = unread_pages
        summary["note"] = pdf_text.read_note(ocr_note, unread_pages=unread_pages)
        return RichInspectResult(
            status="inspected",
            adapter="pdf",
            source=source,
            summary=summary,
            previews=tuple(previews),
            warnings=tuple(warnings_out),
        )

    # Pre-fit whole lines against the serializer's exact budget so base.py's
    # 320-char excerpt fallback never runs for PDF pages.
    fitted_excerpts = pdf_text.fit_excerpts(
        page_lines,
        starts=starts,
        page_max_chars=PDF_INSPECT_PAGE_TEXT_CHARS,
        total_max_chars=MAX_RICH_INSPECT_OUTPUT_CHARS,
        serialized_length=lambda excerpts: len(
            json.dumps(
                rich_inspect_result_payload(build_result(excerpts)),
                ensure_ascii=False,
                separators=(",", ":"),
            )
        ),
    )
    result = build_result([text for text, _next in fitted_excerpts])
    return rich_inspect_result_to_tool_result(
        result,
        generated_artifacts=tuple(generated_artifacts),
    )


def _create_pdf_page_preview(
    *,
    context: PdfPreviewContext,
    page: Any,
    page_number: int,
) -> RichPreviewResult:
    try:
        preview_width, preview_height = _preview_dimensions(page)
        if preview_width * preview_height > MAX_PDF_PREVIEW_PIXELS:
            raise ToolExecutionFailure(
                code=CMP_TOOL_RICH_FILES_UNSUPPORTED,
                message="rendered PDF page preview exceeds pixel limit",
                retryable=False,
            )
        pixmap = page.get_pixmap(
            matrix=context.fitz.Matrix(PDF_PREVIEW_SCALE, PDF_PREVIEW_SCALE),
            alpha=False,
        )
        png_bytes = pixmap.tobytes("png")
        if len(png_bytes) > filesystem_content.MAX_MEDIA_FILE_BYTES:
            raise ToolExecutionFailure(
                code=CMP_TOOL_RICH_FILES_UNSUPPORTED,
                message="rendered PDF page preview exceeds byte limit",
                retryable=False,
            )
        preview = create_binary_artifact(
            workspace=context.workspace,
            session_id=context.session_id,
            spec=BinaryArtifactSpec(
                artifact_kind="image",
                title=f"PDF page {page_number}: {context.source_path.name}",
                content=png_bytes,
                mime_type="image/png",
                file_name=f"{context.source_path.stem}-page-{page_number}.png",
                metadata_extra={
                    "width": int(pixmap.width),
                    "height": int(pixmap.height),
                    "page": page_number,
                },
            ),
        )
    except Exception as error:  # noqa: BLE001
        return RichPreviewResult(
            warnings=(f"preview skipped for page {page_number}: {type(error).__name__}",)
        )

    metadata = dict(preview.generated_artifacts[0])
    return RichPreviewResult(
        previews=(
            preview_artifact_metadata(
                metadata,
                extra={
                    "width": metadata.get("width"),
                    "height": metadata.get("height"),
                    "page": page_number,
                },
            ),
        ),
        generated_artifacts=(metadata,),
    )


def _preview_dimensions(page: Any) -> tuple[int, int]:
    rect = getattr(page, "rect", None)
    width = max(1, math.ceil(float(getattr(rect, "width", 0) or 0) * PDF_PREVIEW_SCALE))
    height = max(1, math.ceil(float(getattr(rect, "height", 0) or 0) * PDF_PREVIEW_SCALE))
    return width, height
