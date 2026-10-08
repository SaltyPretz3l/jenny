from __future__ import annotations

import hashlib
import os
import sys
import zipfile
from pathlib import Path

import pytest

import sidecar.ai.semantic.extract as extract_module
from sidecar.ai.semantic.extract import extract_document
from sidecar.ai.tools.workspace import WorkspaceGuard

_DOCX_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    "<w:body><w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p>"
    "<w:p></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>"
)


@pytest.fixture
def root(tmp_path: Path) -> Path:
    path = tmp_path / "root"
    path.mkdir()
    return path


def test_text_files_yield_line_sections_and_raw_sha(root: Path) -> None:
    raw = b"first\n\nthird \xff\n"
    path = root / "notes.md"
    path.write_bytes(raw)

    result = extract_document(path, WorkspaceGuard(str(root)))

    assert result.status == "ok"
    assert result.sections == [("L1-1", "first"), ("L2-2", ""), ("L3-3", "third �")]
    assert result.sha256 == hashlib.sha256(raw).hexdigest()


def test_binary_oversize_and_unsupported_are_skipped(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    guard = WorkspaceGuard(str(root))
    (root / "blob.txt").write_bytes(b"abc\x00def")
    (root / "big.md").write_text("y" * 64, encoding="utf-8")
    (root / "image.png").write_bytes(b"\x89PNG")
    monkeypatch.setattr(extract_module, "MAX_TEXT_FILE_BYTES", 32)

    assert extract_document(root / "blob.txt", guard).reason == "binary"
    assert extract_document(root / "big.md", guard).reason == "too_large"
    unsupported = extract_document(root / "image.png", guard)
    assert (unsupported.status, unsupported.reason) == ("skipped", "unsupported_type")


def test_paths_outside_the_root_are_never_read(root: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.md").write_text("secret", encoding="utf-8")
    guard = WorkspaceGuard(str(root))

    assert extract_document(outside / "secret.md", guard).reason == "outside_root"
    links = []
    try:
        os.symlink(outside / "secret.md", root / "link.md")
        links.append(root / "link.md")
    except (OSError, NotImplementedError):
        pass
    if sys.platform == "win32":
        import _winapi

        _winapi.CreateJunction(str(outside), str(root / "junction"))
        links.append(root / "junction" / "secret.md")
    if not links:
        pytest.skip("the OS refused to create a symlink or junction")
    for link in links:
        result = extract_document(link, guard)
        assert (result.status, result.reason) == ("skipped", "outside_root")
        assert result.sections == []


def test_docx_paragraphs_and_malformed_docx(root: Path) -> None:
    good = root / "doc.docx"
    with zipfile.ZipFile(good, "w") as archive:
        archive.writestr("word/document.xml", _DOCX_XML)
    bad = root / "bad.docx"
    bad.write_bytes(b"not a zip")
    guard = WorkspaceGuard(str(root))

    result = extract_document(good, guard)

    assert result.status == "ok"
    assert result.sections == [("para1", "Hello world"), ("para2", "Second paragraph")]
    broken = extract_document(bad, guard)
    assert (broken.status, broken.reason) == ("failed", "docx_unreadable")


def test_docx_xml_size_cap(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = root / "doc.docx"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("word/document.xml", _DOCX_XML)
    monkeypatch.setattr(extract_module, "MAX_DOCX_XML_BYTES", 10)

    assert extract_document(path, WorkspaceGuard(str(root))).reason == "too_large"


def test_pdf_without_the_addon_is_skipped(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (root / "paper.pdf").write_bytes(b"%PDF-1.4\n")
    monkeypatch.setattr(extract_module, "_load_fitz", lambda: None)

    result = extract_document(root / "paper.pdf", WorkspaceGuard(str(root)))

    assert (result.status, result.reason) == ("skipped", "pdf_addon_missing")


def test_pdf_pages_and_needs_ocr(root: Path) -> None:
    fitz = pytest.importorskip("fitz")
    text_pdf = fitz.open()
    text_pdf.new_page()
    page = text_pdf.new_page()
    page.insert_text((72, 72), "Orbital mechanics notes")
    text_pdf.save(str(root / "text.pdf"))
    text_pdf.close()
    blank = fitz.open()
    blank.new_page()
    blank.save(str(root / "scan.pdf"))
    blank.close()
    guard = WorkspaceGuard(str(root))

    result = extract_document(root / "text.pdf", guard)
    scanned = extract_document(root / "scan.pdf", guard)

    assert result.status == "ok"
    assert [locator for locator, _text in result.sections] == ["p2"]
    assert "Orbital mechanics" in result.sections[0][1]
    assert (scanned.status, scanned.reason) == ("skipped", "needs_ocr")


class _FakePage:
    def __init__(self, text: str, clock: list[float]) -> None:
        self._text = text
        self._clock = clock

    def get_text(self, _mode: str) -> str:
        self._clock[0] += 1.0  # each page takes a second
        return self._text


class _FakePdf:
    needs_pass = False

    def __init__(self, pages: int, text: str, clock: list[float]) -> None:
        self._pages = [_FakePage(text, clock) for _ in range(pages)]

    def __len__(self) -> int:
        return len(self._pages)

    def __getitem__(self, index: int) -> _FakePage:
        return self._pages[index]

    def close(self) -> None:
        pass


def test_pdf_extraction_stops_at_its_time_and_text_bounds(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (root / "long.pdf").write_bytes(b"%PDF-1.4\n")
    clock = [0.0]
    monkeypatch.setattr(extract_module.time, "monotonic", lambda: clock[0])
    pdf = _FakePdf(50, "slow page text", clock)
    monkeypatch.setattr(
        extract_module, "_load_fitz", lambda: type("Fitz", (), {"open": staticmethod(lambda _p: pdf)})
    )
    result = extract_document(root / "long.pdf", WorkspaceGuard(str(root)))
    assert result.status == "ok"
    assert len(result.sections) == extract_module.MAX_PDF_EXTRACT_SECONDS, "pages read so far are kept"

    clock[0] = 0.0
    monkeypatch.setattr(extract_module, "MAX_PDF_TEXT_CHARS", 30)
    capped = extract_document(root / "long.pdf", WorkspaceGuard(str(root)))
    assert len(capped.sections) == 3
