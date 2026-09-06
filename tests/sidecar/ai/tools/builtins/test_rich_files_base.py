"""Rich-file Phase 1 — shared source validator tests.

Per-format adapter tests (test_rich_files_pdf.py / test_rich_files_image.py)
ship in Phase 2 alongside the actual PDF/image inspect handlers.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sidecar.ai.error_codes import (
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_RICH_FILES_DEPENDENCY_MISSING,
    CMP_TOOL_RICH_FILES_MIME_MISMATCH,
    CMP_TOOL_RICH_FILES_TOO_LARGE,
    CMP_TOOL_RICH_FILES_UNSUPPORTED,
)
from sidecar.ai.tools.builtins.rich_files import (
    RichFileSource,
    RichInspectFailure,
    RichInspectResult,
    RichSourceValidator,
    read_bounded_file_bytes,
    rich_inspect_result_to_tool_result,
    validate_rich_file_source,
)
from sidecar.ai.tools.builtins.rich_files.base import (
    MAX_RICH_INSPECT_OUTPUT_CHARS,
    build_dependency_missing_result,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


@pytest.fixture()
def workspace(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


def test_validate_returns_source_with_sha256_and_relative_posix(
    workspace: WorkspaceGuard, tmp_path: Path
) -> None:
    target = tmp_path / "doc.pdf"
    target.write_bytes(b"%PDF-1.4\n%fake content\n")
    source = validate_rich_file_source(
        requested_path="doc.pdf",
        workspace=workspace,
        adapter="pdf",
        expected_mime_prefix="application/pdf",
    )
    assert isinstance(source, RichFileSource)
    assert source.workspace_path == "doc.pdf"
    assert source.mime_type == "application/pdf"
    assert source.size_bytes == target.stat().st_size
    assert len(source.sha256) == 64  # hex digest length


def test_validate_uses_posix_separator_in_subdirectories(
    workspace: WorkspaceGuard, tmp_path: Path
) -> None:
    sub = tmp_path / "docs" / "subdir"
    sub.mkdir(parents=True)
    target = sub / "thing.png"
    target.write_bytes(b"\x89PNG\r\n\x1a\n")
    source = validate_rich_file_source(
        requested_path="docs/subdir/thing.png",
        workspace=workspace,
        adapter="image",
        expected_mime_prefix="image/",
    )
    assert source.workspace_path == "docs/subdir/thing.png"


def test_validate_rejects_blank_path(workspace: WorkspaceGuard) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        validate_rich_file_source(
            requested_path="   ",
            workspace=workspace,
            adapter="pdf",
        )
    assert excinfo.value.code == CMP_TOOL_INVALID_PATH


def test_validate_rejects_path_outside_workspace(
    workspace: WorkspaceGuard, tmp_path: Path
) -> None:
    with pytest.raises(ToolExecutionFailure):
        validate_rich_file_source(
            requested_path="../escape.pdf",
            workspace=workspace,
            adapter="pdf",
        )


def test_validate_rejects_directory_target(
    workspace: WorkspaceGuard, tmp_path: Path
) -> None:
    sub = tmp_path / "subdir"
    sub.mkdir()
    with pytest.raises(ToolExecutionFailure) as excinfo:
        validate_rich_file_source(
            requested_path="subdir",
            workspace=workspace,
            adapter="pdf",
        )
    assert excinfo.value.code == CMP_TOOL_INVALID_PATH


def test_validate_rejects_oversized_file(
    workspace: WorkspaceGuard, tmp_path: Path
) -> None:
    target = tmp_path / "big.pdf"
    target.write_bytes(b"%PDF-1.4\n" + b"x" * 200)
    with pytest.raises(ToolExecutionFailure) as excinfo:
        validate_rich_file_source(
            requested_path="big.pdf",
            workspace=workspace,
            adapter="pdf",
            max_bytes=50,
        )
    assert excinfo.value.code == CMP_TOOL_RICH_FILES_TOO_LARGE


def test_validate_oversized_absolute_request_reports_relative_path(
    workspace: WorkspaceGuard, tmp_path: Path
) -> None:
    target = tmp_path / "big.pdf"
    target.write_bytes(b"%PDF-1.4\n" + b"x" * 200)

    with pytest.raises(ToolExecutionFailure) as excinfo:
        validate_rich_file_source(
            requested_path=str(target),
            workspace=workspace,
            adapter="pdf",
            max_bytes=50,
        )

    assert excinfo.value.code == CMP_TOOL_RICH_FILES_TOO_LARGE
    assert str(tmp_path) not in excinfo.value.message
    assert "big.pdf" in excinfo.value.message


def test_validate_rejects_mime_mismatch(
    workspace: WorkspaceGuard, tmp_path: Path
) -> None:
    # An .html file fed into the PDF adapter must fail with MIME mismatch.
    target = tmp_path / "page.html"
    target.write_bytes(b"<html></html>")
    with pytest.raises(ToolExecutionFailure) as excinfo:
        validate_rich_file_source(
            requested_path="page.html",
            workspace=workspace,
            adapter="pdf",
            expected_mime_prefix="application/pdf",
        )
    assert excinfo.value.code == CMP_TOOL_RICH_FILES_MIME_MISMATCH


def test_validate_rejects_unknown_mime_when_adapter_requires_one(
    workspace: WorkspaceGuard, tmp_path: Path
) -> None:
    # ".zzfoo" is not in Python's MIME map, so guess_type returns None.
    target = tmp_path / "mystery.zzfoo"
    target.write_bytes(b"\x00\x01\x02")
    with pytest.raises(ToolExecutionFailure) as excinfo:
        validate_rich_file_source(
            requested_path="mystery.zzfoo",
            workspace=workspace,
            adapter="image",
            expected_mime_prefix="image/",
        )
    assert excinfo.value.code == CMP_TOOL_RICH_FILES_UNSUPPORTED


def test_validate_allows_no_mime_prefix_constraint(
    workspace: WorkspaceGuard, tmp_path: Path
) -> None:
    target = tmp_path / "mystery.zzfoo"
    target.write_bytes(b"\x00\x01\x02")
    # No expected_mime_prefix -> unknown MIME is OK.
    source = validate_rich_file_source(
        requested_path="mystery.zzfoo",
        workspace=workspace,
        adapter="document",
    )
    assert source.mime_type == ""


def test_build_dependency_missing_result_shape(
    workspace: WorkspaceGuard, tmp_path: Path
) -> None:
    target = tmp_path / "doc.pdf"
    target.write_bytes(b"%PDF-1.4")
    source = validate_rich_file_source(
        requested_path="doc.pdf",
        workspace=workspace,
        adapter="pdf",
        expected_mime_prefix="application/pdf",
    )
    result = build_dependency_missing_result(
        adapter="pdf",
        source=source,
        dependency="PyMuPDF",
        install_hint="pip install PyMuPDF",
    )
    assert isinstance(result, RichInspectResult)
    assert result.status == "unavailable"
    assert result.adapter == "pdf"
    assert result.failure is not None
    assert isinstance(result.failure, RichInspectFailure)
    assert result.failure.error_code == CMP_TOOL_RICH_FILES_DEPENDENCY_MISSING
    assert result.failure.install_hint == "pip install PyMuPDF"


def test_validator_class_round_trip(workspace: WorkspaceGuard, tmp_path: Path) -> None:
    target = tmp_path / "doc.pdf"
    target.write_bytes(b"%PDF-1.4 small content")
    validator = RichSourceValidator(
        workspace,
        expected_mime_prefix="application/pdf",
    )
    source = validator.validate(requested_path="doc.pdf", adapter="pdf")
    assert source.size_bytes == target.stat().st_size


def test_result_serialization_omits_absolute_path(
    workspace: WorkspaceGuard, tmp_path: Path
) -> None:
    target = tmp_path / "doc.pdf"
    target.write_bytes(b"%PDF-1.4 small content")
    source = validate_rich_file_source(
        requested_path="doc.pdf",
        workspace=workspace,
        adapter="pdf",
        expected_mime_prefix="application/pdf",
    )
    result = RichInspectResult(
        status="inspected",
        adapter="pdf",
        source=source,
        summary={"page_count": 1},
        previews=(
            {
                "artifact_id": "artifact_file_session_doc-preview_deadbeef",
                "page": 1,
                "mime_type": "image/png",
            },
        ),
        warnings=("preview skipped",),
    )

    tool_result = rich_inspect_result_to_tool_result(result)

    assert tool_result.success is True
    assert tool_result.metadata["result_kind"] == "pdf_inspect"
    assert tool_result.metadata["source"]["path"] == "doc.pdf"
    assert "absolute_path" not in tool_result.metadata["source"]
    assert str(tmp_path) not in tool_result.output
    assert "page_count" in tool_result.output


def test_result_serialization_bounded_output_stays_json(
    workspace: WorkspaceGuard, tmp_path: Path
) -> None:
    target = tmp_path / "doc.pdf"
    target.write_bytes(b"%PDF-1.4 small content")
    source = validate_rich_file_source(
        requested_path="doc.pdf",
        workspace=workspace,
        adapter="pdf",
        expected_mime_prefix="application/pdf",
    )
    result = RichInspectResult(
        status="inspected",
        adapter="pdf",
        source=source,
        summary={
            "page_count": 1,
            "notes": "x" * (MAX_RICH_INSPECT_OUTPUT_CHARS * 3),
            "pages": [
                {"page": page_number, "text_excerpt": "hello" * 5_000}
                for page_number in range(1, 80)
            ],
        },
        previews=(
            {
                "artifact_id": "artifact_file_session_doc-preview_deadbeef",
                "data_uri": "data:image/png;base64," + ("a" * 400),
                "absolute_path": str(tmp_path / "secret.png"),
            },
        )
        * 20,
        warnings=("warning " * 200,) * 20,
    )

    tool_result = rich_inspect_result_to_tool_result(result)
    payload = json.loads(tool_result.output)

    assert len(tool_result.output) <= MAX_RICH_INSPECT_OUTPUT_CHARS
    assert tool_result.metadata["truncated"] is True
    assert tool_result.metadata["summary"]["truncated"] is True
    assert payload["truncated"] is True
    assert payload["summary"]["truncated"] is True
    assert "data:image" not in tool_result.output
    assert str(tmp_path) not in tool_result.output


def test_read_bounded_file_bytes_rejects_growth_beyond_cap(tmp_path: Path) -> None:
    target = tmp_path / "sample.png"
    target.write_bytes(b"abcdef")

    with pytest.raises(ToolExecutionFailure, match="size limit"):
        read_bounded_file_bytes(target, max_bytes=3)


def test_unavailable_result_serialization_is_nonfatal(
    workspace: WorkspaceGuard, tmp_path: Path
) -> None:
    target = tmp_path / "doc.pdf"
    target.write_bytes(b"%PDF-1.4")
    source = validate_rich_file_source(
        requested_path="doc.pdf",
        workspace=workspace,
        adapter="pdf",
        expected_mime_prefix="application/pdf",
    )
    result = build_dependency_missing_result(
        adapter="pdf",
        source=source,
        dependency="PyMuPDF",
        install_hint="pip install PyMuPDF",
    )

    tool_result = rich_inspect_result_to_tool_result(result)

    assert tool_result.success is True
    assert tool_result.metadata["status"] == "unavailable"
    assert tool_result.metadata["failure"]["error_code"] == CMP_TOOL_RICH_FILES_DEPENDENCY_MISSING
