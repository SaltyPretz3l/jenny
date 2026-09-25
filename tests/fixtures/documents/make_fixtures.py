"""Generate the representative document fixtures for the Workspace document
editing program (docs/plans/WORKSPACE_DOCUMENT_EDITING.md).

DOCX fixtures are hand-written minimal OOXML packages (no python-docx needed);
PDF fixtures come from PyMuPDF, which lives in the sidecar venv. Re-run with
`.venv/Scripts/python tests/fixtures/documents/make_fixtures.py`. Outputs are
committed so the Node tests never depend on Python."""
# ruff: noqa: E501

from __future__ import annotations

import struct
import sys
import zipfile
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent

W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
WP_NS = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
PIC_NS = 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'


def png_2x2() -> bytes:
    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xFFFFFFFF)
    raw = b''.join(b'\x00' + bytes([255, 0, 0, 0, 0, 255]) for _ in range(2))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 2, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def content_types(extra: str = '') -> str:
    return (XML_DECL + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Default Extension="png" ContentType="image/png"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            + extra + '</Types>')


ROOT_RELS = (XML_DECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
             '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
             '</Relationships>')


def doc_rels(extra: str = '') -> str:
    return (XML_DECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + extra + '</Relationships>')


def document(body: str, extra_ns: str = '') -> str:
    return XML_DECL + f'<w:document {W_NS} {R_NS} {extra_ns}><w:body>{body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>'


def run(text: str, props: str = '') -> str:
    rpr = f'<w:rPr>{props}</w:rPr>' if props else ''
    return f'<w:r>{rpr}<w:t xml:space="preserve">{text}</w:t></w:r>'


NUMBERING = (XML_DECL + f'<w:numbering {W_NS}>'
             '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>'
             '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>'
             '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
             '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
             '</w:numbering>')


def write_docx(name: str, parts: dict[str, bytes | str]) -> None:
    target = HERE / name
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        for part_name, payload in parts.items():
            data = payload.encode('utf-8') if isinstance(payload, str) else payload
            archive.writestr(part_name, data)


def paragraphs_docx() -> None:
    body = (
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' + run('Quarterly summary') + '</w:p>'
        '<w:p>' + run('Plain ') + run('bold', '<w:b/>') + run(' and ') + run('italic', '<w:i/>')
        + run(' and ') + run('underlined', '<w:u w:val="single"/>') + run(' text.') + '</w:p>'
        '<w:p>' + run('Tab') + '<w:r><w:tab/></w:r>' + run('after tab, then') + '<w:r><w:br/></w:r>' + run('a manual line break.') + '</w:p>'
    )
    write_docx('paragraphs.docx', {
        '[Content_Types].xml': content_types(),
        '_rels/.rels': ROOT_RELS,
        'word/document.xml': document(body),
        'word/_rels/document.xml.rels': doc_rels(),
    })


def lists_tables_docx() -> None:
    def list_item(text: str, num_id: int) -> str:
        return f'<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="{num_id}"/></w:numPr></w:pPr>{run(text)}</w:p>'

    def cell(text: str) -> str:
        return f'<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr><w:p>{run(text)}</w:p></w:tc>'
    body = (
        '<w:p>' + run('Shopping list') + '</w:p>'
        + list_item('Apples', 1) + list_item('Bread', 1)
        + '<w:p>' + run('Steps') + '</w:p>'
        + list_item('First step', 2) + list_item('Second step', 2)
        + '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>'
        '<w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>'
        '<w:tr>' + cell('Account') + cell('Balance') + '</w:tr>'
        '<w:tr>' + cell('Cash') + cell('1,250.00') + '</w:tr>'
        '</w:tbl>'
        '<w:p>' + run('After the table.') + '</w:p>'
    )
    write_docx('lists-tables.docx', {
        '[Content_Types].xml': content_types(
            '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'),
        '_rels/.rels': ROOT_RELS,
        'word/document.xml': document(body),
        'word/numbering.xml': NUMBERING,
        'word/_rels/document.xml.rels': doc_rels(
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'),
    })


def images_headers_docx() -> None:
    drawing = (
        '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
        '<wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Picture 1"/>'
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        '<pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>'
        '<pic:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>'
        '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
    )
    body = (
        '<w:p>' + run('Before the picture ') + drawing + run(' after the picture.') + '</w:p>'
        '<w:p><w:bookmarkStart w:id="0" w:name="anchor"/>' + run('Bookmarked paragraph with a ')
        + '<w:hyperlink r:id="rId4">' + run('link', '<w:color w:val="0563C1"/><w:u w:val="single"/>') + '</w:hyperlink>'
        + run(' and page ') + '<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>'
        + run(' with a footnote') + '<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r>'
        + '<w:bookmarkEnd w:id="0"/></w:p>'
        '<w:p>' + run('Last paragraph on page one.') + '<w:r><w:br w:type="page"/></w:r></w:p>'
        '<w:p>' + run('First paragraph on page two.') + '</w:p>'
    )
    header = XML_DECL + f'<w:hdr {W_NS}><w:p>{run("Confidential header")}</w:p></w:hdr>'
    footer = XML_DECL + f'<w:ftr {W_NS}><w:p>{run("Footer text")}</w:p></w:ftr>'
    footnotes = (XML_DECL + f'<w:footnotes {W_NS}>'
                 '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>'
                 '<w:footnote w:id="1"><w:p>' + run('The footnote body.') + '</w:p></w:footnote></w:footnotes>')
    doc = document(body, f'{WP_NS} {A_NS} {PIC_NS}').replace(
        '<w:sectPr>', '<w:sectPr><w:headerReference w:type="default" r:id="rId1"/><w:footerReference w:type="default" r:id="rId3"/>')
    write_docx('images-headers.docx', {
        '[Content_Types].xml': content_types(
            '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>'
            '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
            '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>'),
        '_rels/.rels': ROOT_RELS,
        'word/document.xml': doc,
        'word/header1.xml': header,
        'word/footer1.xml': footer,
        'word/footnotes.xml': footnotes,
        'word/media/image1.png': png_2x2(),
        'word/_rels/document.xml.rels': doc_rels(
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>'
            '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'
            '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/>'
            '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>'),
    })


def not_a_docx() -> None:
    write_docx('not-a-docx.docx', {'readme.txt': 'This zip has no word/document.xml part.'})


def malformed_docx() -> None:
    source = (HERE / 'paragraphs.docx').read_bytes()
    (HERE / 'malformed.docx').write_bytes(source[: len(source) // 2])


def pdfs() -> None:
    import fitz  # noqa: PLC0415 - PyMuPDF from the sidecar venv

    doc = fitz.open()
    for index in range(2):
        page = doc.new_page(width=612, height=792)
        page.insert_text((72, 100), f'Page {index + 1} of the text fixture.', fontsize=14)
        page.insert_text((72, 140), 'Searchable words: revenue balance ledger', fontsize=12)
    doc.save(HERE / 'text.pdf')
    doc.close()

    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((72, 100), 'This page already carries a highlight annotation.', fontsize=12)
    rects = page.search_for('highlight annotation')
    page.add_highlight_annot(rects[0])
    widget = fitz.Widget()
    widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
    widget.field_name = 'note'
    widget.rect = fitz.Rect(72, 200, 400, 230)
    widget.field_value = ''
    page.add_widget(widget)
    doc.save(HERE / 'annotated.pdf')
    doc.close()

    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 200, 60), 0)
    pix.clear_with(255)
    page.insert_image(fitz.Rect(72, 72, 472, 192), pixmap=pix)
    doc.save(HERE / 'scanned.pdf')
    doc.close()

    source = (HERE / 'text.pdf').read_bytes()
    (HERE / 'malformed.pdf').write_bytes(source[: len(source) // 3])


def gate_pdfs(out_dir: Path = HERE) -> None:
    import fitz  # noqa: PLC0415 - PyMuPDF from the sidecar venv

    def save(document: fitz.Document, name: str) -> None:
        document.set_metadata({})
        document.save(out_dir / name, garbage=4, deflate=True, no_new_id=True)
        document.close()

    document = fitz.open()
    scanned_pages = (
        (1, ('SCANNED PAGE 1', 'Invoice 4417 total 1,250.00')),
        (2, ('SCANNED PAGE 2', 'Balance due 3,905.12')),
    )
    for _page_number, lines in scanned_pages:
        source = fitz.open()
        source_page = source.new_page(width=612, height=792)
        for row, text in enumerate(lines):
            source_page.insert_text((72, 110 + 40 * row), text, fontsize=20)
        pixmap = source_page.get_pixmap(dpi=150, alpha=False)
        page = document.new_page(width=612, height=792)
        page.insert_image(page.rect, pixmap=pixmap)
        source.close()
    save(document, 'scanned-text.pdf')

    document = fitz.open()
    items = [(f'Schedule A item {number:02d}', 1000 + 37 * number) for number in range(1, 49)]
    running_total = 0
    for page_index in range(4):
        page = document.new_page(width=612, height=792)
        page.insert_text(
            (72, 60),
            f'Annual Statement 2026 - page {page_index + 1} of 4',
            fontsize=12,
        )
        y = 100
        for label, amount in items[page_index * 12:(page_index + 1) * 12]:
            running_total += amount
            page.insert_text(
                (72, y),
                f'{label} {"." * 40} {amount:,.2f}',
                fontsize=10,
            )
            y += 20
        if page_index == 3:  # noqa: PLR2004 - the fourth page carries the total
            page.insert_text(
                (72, y + 20),
                f'Total Schedule A {"." * 40} {running_total:,.2f}',
                fontsize=10,
            )
    save(document, 'long-statement.pdf')


def main() -> None:
    if sys.argv[1:] == ['gate']:
        gate_pdfs()
        return
    if sys.argv[1:]:
        raise SystemExit('usage: make_fixtures.py [gate]')
    paragraphs_docx()
    lists_tables_docx()
    images_headers_docx()
    not_a_docx()
    malformed_docx()
    pdfs()
    for item in sorted(HERE.iterdir()):
        if item.suffix in {'.docx', '.pdf'}:
            print(f'{item.name}: {item.stat().st_size} bytes')


if __name__ == '__main__':
    main()
