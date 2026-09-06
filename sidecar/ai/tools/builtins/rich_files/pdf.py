"""Read-only rich PDF inspect tool."""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sidecar.ai.error_codes import CMP_TOOL_RICH_FILES_UNSUPPORTED
from sidecar.ai.tools.builtins import filesystem_content
from sidecar.ai.tools.builtins.artifacts import BinaryArtifactSpec, create_binary_artifact
from sidecar.ai.tools.builtins.rich_files.base import (
    RichFileSource,
    RichInspectResult,
    RichPreviewResult,
    build_dependency_missing_result,
    build_unsupported_result,
    preview_artifact_metadata,
    rich_inspect_result_to_tool_result,
    string_argument,
    validate_rich_file_source,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.sanitization import (
    sanitize_tool_output,
    sanitize_tool_output_no_truncate,
)
from sidecar.ai.tools.workspace import WorkspaceGuard

PDF_PREVIEW_SCALE = 1.25
MAX_PDF_PREVIEW_PIXELS = 4_000_000


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
    try:
        fitz = filesystem_content._load_pymupdf()
    except (ModuleNotFoundError, ToolExecutionFailure):
        return rich_inspect_result_to_tool_result(
            build_dependency_missing_result(
                adapter="pdf",
                source=source,
                dependency="PyMuPDF",
                install_hint="Install the optional media extra to enable PDF inspection.",
            )
        )

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

    with fitz.open(source.absolute_path) as document:
        page_count = int(document.page_count)
        if page_count <= 0:
            raise ValueError("PDF has no pages")
        selected_pages = filesystem_content._parse_pages_argument(
            arguments.get("pages"),
            page_count=page_count,
        )
        pages_payload: list[dict[str, object]] = []
        source_path = Path(source.workspace_path)
        preview_context = PdfPreviewContext(
            workspace=workspace,
            session_id=session_id,
            source_path=source_path,
            fitz=fitz,
        )
        if preview_requested and not session_id:
            warnings_out.append("preview skipped: session context unavailable")

        for page_number in selected_pages:
            page = document.load_page(page_number - 1)
            sanitized_text = sanitize_tool_output_no_truncate(
                page.get_text("text"), tool_name="pdf_inspect"
            )
            text_truncated = (
                len(sanitized_text) > filesystem_content.MAX_PDF_PAGE_TEXT_CHARS
            )
            text_excerpt = (
                sanitize_tool_output(
                    sanitized_text,
                    max_chars=filesystem_content.MAX_PDF_PAGE_TEXT_CHARS,
                    tool_name="pdf_inspect",
                )
                if text_truncated
                else sanitized_text
            )
            page_payload: dict[str, object] = {
                "page": page_number,
                "text_excerpt": text_excerpt,
            }
            if text_truncated:
                page_payload["text_truncated"] = True
            pages_payload.append(page_payload)

            if preview_requested and session_id:
                preview_result = _create_pdf_page_preview(
                    context=preview_context,
                    page=page,
                    page_number=page_number,
                )
                previews.extend(preview_result.previews)
                warnings_out.extend(preview_result.warnings)
                generated_artifacts.extend(preview_result.generated_artifacts)

    result = RichInspectResult(
        status="inspected",
        adapter="pdf",
        source=source,
        summary={
            "page_count": page_count,
            "selected_pages": selected_pages,
            "pages": pages_payload,
            "truncated": page_count > len(selected_pages),
        },
        previews=tuple(previews),
        warnings=tuple(warnings_out),
    )
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
