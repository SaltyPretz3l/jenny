"""grep_search over PDFs: page text through the shared page cache, not a binary skip."""

from __future__ import annotations

import os
import re
from concurrent.futures import TimeoutError as FutureTimeoutError
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import fitz
import pytest

from sidecar.ai.error_codes import CMP_TOOL_PDF_ADDON_MISSING
from sidecar.ai.tools.builtins import (
    filesystem_content,
    grep_search_pdf,
    pdf_ocr,
    pdf_ocr_rapid,
    pdf_page_cache,
    pdf_text,
)
from sidecar.ai.tools.builtins import grep_search as grep_module
from sidecar.ai.tools.builtins.filesystem_content import read_media_file
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


@pytest.fixture(autouse=True)
def _isolated(monkeypatch: pytest.MonkeyPatch) -> None:
    grep_module.configure_grep_search(None)
    monkeypatch.setenv("JENNY_ENABLE_PDF_OCR", "1")
    monkeypatch.setenv("JENNY_ENABLE_PDF_OCR_RAPID", "1")
    monkeypatch.delenv("JENNY_ENABLE_PDF_PAGE_CACHE", raising=False)
    pdf_page_cache.PDF_PAGE_CACHE.clear()
    pdf_page_cache.PDF_DOCUMENT_MEMO.clear()


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


def _write_text_pdf(path: Path, pages: list[list[str]]) -> None:
    document = fitz.open()
    for lines in pages:
        page = document.new_page(width=612, height=792)
        for index, line in enumerate(lines):
            page.insert_text((36, 60 + 18 * index), line, fontsize=11)
    document.save(path)
    document.close()


def _write_image_only_pdf(path: Path, *, pages: int = 1) -> None:
    source = fitz.open()
    source_page = source.new_page(width=612, height=792)
    source_page.insert_text((36, 60), "Losses 24,066,365", fontsize=12)
    pixmap = source_page.get_pixmap(dpi=72, colorspace=fitz.csRGB, alpha=False)
    scanned = fitz.open()
    for _ in range(pages):
        page = scanned.new_page(width=612, height=792)
        page.insert_image(page.rect, pixmap=pixmap)
    scanned.save(path)
    scanned.close()
    source.close()


def _fake_rapid(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    calls: list[int] = []

    def recognize(_engine: object, _page: object) -> tuple[list[pdf_ocr_rapid.RapidWord], int]:
        calls.append(1)
        return [pdf_ocr_rapid.RapidWord(36, 50, 76, 62, "Losses", 0.99)], 200

    monkeypatch.setattr(pdf_ocr_rapid, "load_engine", object)
    monkeypatch.setattr(pdf_ocr_rapid, "recognize_page", recognize)
    monkeypatch.setattr(
        pdf_ocr,
        "resolve_tessdata",
        lambda **_kwargs: pdf_ocr.TessdataResolution(None, "not installed"),
    )
    return calls


def test_grep_matches_pdf_text_with_page_and_line_numbers(tmp_path: Path) -> None:
    (tmp_path / "docs").mkdir()
    _write_text_pdf(
        tmp_path / "docs" / "statute.pdf",
        [["Chapter 1", "General provisions"], ["Chapter 2", "Intro", "Section 31 Definitions"]],
    )

    result = grep_module.grep_search_tool({"pattern": "Section 31"}, _guard(tmp_path))

    assert result.success is True
    assert result.metadata["skipped_binary_files"] == 0
    assert result.metadata["skipped_pdf_pages"] == 0
    assert result.metadata["file_count"] == 1
    assert result.metadata["total_match_count"] == 1
    assert "docs/statute.pdf:p2:L3:Section 31 Definitions" in result.output


def test_grep_pdf_context_lines_stay_on_the_page(tmp_path: Path) -> None:
    _write_text_pdf(tmp_path / "a.pdf", [["alpha", "needle one", "omega"], ["needle two"]])

    result = grep_module.grep_search_tool(
        {"pattern": "needle", "context_lines": 1}, _guard(tmp_path)
    )

    assert result.metadata["total_match_count"] == 2
    assert result.metadata["file_count"] == 1
    assert "a.pdf:p1:L1:alpha" in result.output
    assert "a.pdf:p1:L2:needle one" in result.output
    assert "a.pdf:p1:L3:omega" in result.output
    assert "a.pdf:p2:L1:needle two" in result.output


def test_grep_pdf_respects_the_match_budget(tmp_path: Path) -> None:
    _write_text_pdf(tmp_path / "many.pdf", [["hit"] * 5, ["hit"] * 5])

    result = grep_module.grep_search_tool({"pattern": "hit", "max_results": 3}, _guard(tmp_path))

    assert result.metadata["total_match_count"] == 10
    assert result.metadata["returned_match_count"] == 3
    assert result.metadata["truncated"] is True


def test_grep_skips_ocr_past_the_file_budget_and_counts_the_page(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_image_only_pdf(tmp_path / "scan.pdf")
    calls = _fake_rapid(monkeypatch)
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.grep_search_pdf.PDF_GREP_FILE_BUDGET_SECONDS", 0.0
    )

    result = grep_module.grep_search_tool({"pattern": "Losses"}, _guard(tmp_path))

    assert calls == []
    assert result.metadata["skipped_pdf_pages"] == 1
    assert result.metadata["total_match_count"] == 0
    assert "PDF page(s)" in result.output
    assert result.metadata["scan_complete"] is False


def test_grep_ocrs_a_scanned_page_inside_the_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_image_only_pdf(tmp_path / "scan.pdf")
    calls = _fake_rapid(monkeypatch)

    first = grep_module.grep_search_tool({"pattern": "Losses"}, _guard(tmp_path))
    second = grep_module.grep_search_tool({"pattern": "Losses"}, _guard(tmp_path))

    assert len(calls) == 1
    for result in (first, second):
        assert result.metadata["skipped_pdf_pages"] == 0
        assert "scan.pdf:p1:L1:Losses" in result.output


def test_grep_searches_a_page_read_file_already_recognized_without_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "scan.pdf"
    _write_image_only_pdf(target)
    calls = _fake_rapid(monkeypatch)
    read_media_file(target, relative_path="scan.pdf", pages_argument="1", authorized_root=tmp_path)
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.grep_search_pdf.PDF_GREP_FILE_BUDGET_SECONDS", 0.0
    )

    result = grep_module.grep_search_tool({"pattern": "Losses"}, _guard(tmp_path))

    assert len(calls) == 1
    assert result.metadata["skipped_pdf_pages"] == 0
    assert "scan.pdf:p1:L1:Losses" in result.output


def test_grep_without_the_pdf_addon_keeps_skipping_pdfs_as_binary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_text_pdf(tmp_path / "doc.pdf", [["needle"]])

    def missing() -> None:
        raise ToolExecutionFailure(
            code=CMP_TOOL_PDF_ADDON_MISSING, message="missing", retryable=False
        )

    monkeypatch.setattr(filesystem_content, "_load_pymupdf", missing)

    result = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert result.metadata["skipped_binary_files"] == 1
    assert result.metadata["total_match_count"] == 0


def test_a_page_split_across_worker_requests_keeps_its_line_numbers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("sidecar.ai.tools.builtins.grep_search_pdf._MAX_REQUEST_TEXT_CHARS", 20)
    _write_text_pdf(tmp_path / "dense.pdf", [["first row", "second row", "needle row"]])

    result = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert "dense.pdf:p1:L3:needle row" in result.output


def test_worker_rejects_a_malformed_lines_request() -> None:
    response = grep_module._run_worker_request(
        {"lines": [1, 2], "display_path": "a.pdf:p1", "pattern": "x"}
    )

    assert response["status"] == "error"


def test_an_encrypted_pdf_is_skipped_and_the_rest_of_the_tree_still_searches(
    tmp_path: Path,
) -> None:
    document = fitz.open()
    document.new_page(width=612, height=792).insert_text((36, 60), "needle", fontsize=11)
    document.save(
        tmp_path / "locked.pdf",
        encryption=fitz.PDF_ENCRYPT_AES_256,
        user_pw="secret",
        owner_pw="secret",
    )
    document.close()
    (tmp_path / "notes.txt").write_text("needle here\n", encoding="utf-8")

    result = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert result.success is True
    assert result.metadata["skipped_binary_files"] == 1
    assert result.metadata["total_match_count"] == 1
    assert "notes.txt" in result.output


def test_a_worker_timeout_mid_pdf_keeps_the_pages_before_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_text_pdf(tmp_path / "a.pdf", [["needle one"], ["needle two"], ["needle three"]])
    original = grep_module._RegexSearchWorker.request

    def flaky(self: object, request: dict[str, object], timeout_seconds: float) -> object:
        if str(request.get("display_path", "")).endswith(":p2"):
            raise FutureTimeoutError
        return original(self, request, timeout_seconds)  # type: ignore[arg-type]

    monkeypatch.setattr(grep_module._RegexSearchWorker, "request", flaky)

    result = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert result.metadata["timed_out_files"] == 1
    assert result.metadata["total_match_count"] == 1
    assert "a.pdf:p1:L1:needle one" in result.output
    assert "needle three" not in result.output


def test_the_per_pdf_budget_also_bounds_text_layer_pages(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_text_pdf(tmp_path / "long.pdf", [["needle"], ["needle"], ["needle"]])
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.grep_search_pdf.PDF_GREP_FILE_BUDGET_SECONDS", 0.0
    )

    result = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert result.metadata["skipped_pdf_pages"] == 3
    assert result.metadata["total_match_count"] == 0
    assert result.metadata["scan_complete"] is False
    assert result.metadata["narrowing_hint"]


def _count_digests(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    calls: list[int] = []
    real = pdf_text.document_digest

    def counting(raw_pdf: bytes) -> str:
        calls.append(len(raw_pdf))
        return real(raw_pdf)

    monkeypatch.setattr(pdf_text, "document_digest", counting)
    return calls


def _count_opens(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    calls: list[int] = []

    def counting_open(*args: Any, **kwargs: Any) -> Any:
        calls.append(1)
        return fitz.open(*args, **kwargs)

    monkeypatch.setattr(
        filesystem_content, "_load_pymupdf", lambda: SimpleNamespace(open=counting_open)
    )
    return calls


def test_repeat_grep_of_an_unchanged_cached_pdf_neither_hashes_nor_opens_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_text_pdf(tmp_path / "doc.pdf", [["alpha"], ["needle here"]])
    digests = _count_digests(monkeypatch)
    opens = _count_opens(monkeypatch)

    first = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))
    second = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert (len(digests), len(opens)) == (1, 1)
    assert len(pdf_page_cache.PDF_DOCUMENT_MEMO) == 1
    for result in (first, second):
        assert result.metadata["total_match_count"] == 1
        assert result.metadata["file_count"] == 1
        assert "doc.pdf:p2:L1:needle here" in result.output
    assert first.output == second.output


def test_memo_hit_with_evicted_pages_opens_the_pdf_but_skips_the_hash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_text_pdf(tmp_path / "doc.pdf", [["needle"]])
    digests = _count_digests(monkeypatch)
    opens = _count_opens(monkeypatch)
    grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))
    pdf_page_cache.PDF_PAGE_CACHE.clear()

    result = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert (len(digests), len(opens)) == (1, 2)
    assert "doc.pdf:p1:L1:needle" in result.output


def test_memo_misses_when_the_modification_time_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "doc.pdf"
    _write_text_pdf(target, [["needle"]])
    digests = _count_digests(monkeypatch)
    opens = _count_opens(monkeypatch)
    grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))
    stat = target.stat()
    os.utime(target, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))

    result = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert (len(digests), len(opens)) == (2, 2)
    assert len(pdf_page_cache.PDF_DOCUMENT_MEMO) == 2
    assert "doc.pdf:p1:L1:needle" in result.output


def test_memo_misses_when_the_size_changes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target = tmp_path / "doc.pdf"
    _write_text_pdf(target, [["needle one"]])
    digests = _count_digests(monkeypatch)
    grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))
    stat = target.stat()
    _write_text_pdf(target, [["needle one", "needle two"]])
    os.utime(target, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    assert target.stat().st_size != stat.st_size

    result = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert len(digests) == 2
    assert result.metadata["total_match_count"] == 2


def test_page_cache_kill_switch_also_disables_the_memo(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("JENNY_ENABLE_PDF_PAGE_CACHE", "0")
    _write_text_pdf(tmp_path / "doc.pdf", [["needle"]])
    digests = _count_digests(monkeypatch)
    opens = _count_opens(monkeypatch)

    for _ in range(2):
        result = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))
        assert "doc.pdf:p1:L1:needle" in result.output

    assert (len(digests), len(opens)) == (2, 2)
    assert len(pdf_page_cache.PDF_DOCUMENT_MEMO) == 0


def test_cached_ocr_page_is_not_served_without_opening_while_ocr_is_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_image_only_pdf(tmp_path / "scan.pdf")
    _fake_rapid(monkeypatch)
    first = grep_module.grep_search_tool({"pattern": "Losses"}, _guard(tmp_path))
    assert "scan.pdf:p1:L1:Losses" in first.output
    opens = _count_opens(monkeypatch)
    monkeypatch.setenv("JENNY_ENABLE_PDF_OCR", "0")

    second = grep_module.grep_search_tool({"pattern": "Losses"}, _guard(tmp_path))

    assert opens == [1]
    assert second.metadata["total_match_count"] == 0


class _FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def monotonic(self) -> float:
        return self.now


def _no_matches(_request: dict[str, object]) -> grep_search_pdf.FileSearchResult:
    return grep_search_pdf.FileSearchResult(
        lines=[],
        returned_match_count=0,
        total_match_count=0,
        truncated=False,
        truncated_by_bytes=False,
        truncated_by_line_length=False,
        output_bytes_used=0,
    )


def test_ocr_estimate_excludes_the_one_time_engine_load(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Budget 12 s, a 6 s engine load, 1 s per page: charging the load to page 1
    # would estimate 7 s and skip page 2 at t=7; the recognition alone fits.
    _write_image_only_pdf(tmp_path / "scan.pdf", pages=2)
    calls = _fake_rapid(monkeypatch)
    clock = _FakeClock()
    fake_recognize = pdf_ocr_rapid.recognize_page

    def slow_load() -> object:
        clock.now += 6.0
        return object()

    def slow_recognize(engine: object, page: object) -> Any:
        clock.now += 1.0
        return fake_recognize(engine, page)

    monkeypatch.setattr(pdf_ocr_rapid, "load_engine", slow_load)
    monkeypatch.setattr(pdf_ocr_rapid, "recognize_page", slow_recognize)
    monkeypatch.setattr(grep_search_pdf, "time", clock)
    monkeypatch.setattr(pdf_ocr, "time", clock)

    outcome = grep_search_pdf.search_pdf(
        tmp_path / "scan.pdf",
        re.compile("Losses"),
        workspace_root=tmp_path,
        context_lines=0,
        max_output_matches=10,
        max_output_bytes=10_000,
        deadline=1_000.0,
        send=_no_matches,
    )

    assert outcome is not None
    assert outcome.skipped_pages == 0
    assert len(calls) == 2
    assert clock.now == pytest.approx(8.0)
