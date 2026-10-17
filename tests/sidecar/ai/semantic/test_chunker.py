from __future__ import annotations

import pytest

from sidecar.ai.semantic.chunker import _parse_locator, chunk_sections
from sidecar.ai.semantic.store import MAX_CHUNKS_PER_DOCUMENT


def _lines(text: str) -> list[tuple[str, str]]:
    return [(f"L{index}-{index}", line) for index, line in enumerate(text.splitlines(), 1)]


def test_small_paragraphs_merge_and_locator_spans_lines() -> None:
    chunks = chunk_sections(_lines("alpha one\nalpha two\n\nbeta\n\n\ngamma"), max_chars=100)

    assert len(chunks) == 1
    assert chunks[0].locator == "L1-7"
    assert chunks[0].text == "alpha one\nalpha two\n\nbeta\n\ngamma"


def test_paragraphs_split_when_the_budget_is_exceeded_with_overlap() -> None:
    first = "first paragraph " * 4
    second = "second paragraph " * 4
    chunks = chunk_sections(_lines(f"{first}\n\n{second}"), max_chars=80, overlap_chars=20)

    # A22-F2: the second chunk starts with line 1's tail, so its locator covers line 1.
    assert [chunk.locator for chunk in chunks] == ["L1-1", "L1-3"]
    assert chunks[1].text.endswith(second.strip())
    tail = chunks[1].text.split("\n")[0]
    assert tail and first.strip().endswith(tail)  # overlap from the previous tail
    assert len(tail) <= 20


def _assert_recoverable(chunks, sections) -> None:
    """Every line of every chunk is found in the sections its locator names."""
    for chunk in chunks:
        prefix, first, last = _parse_locator(chunk.locator)
        cited = "\n".join(text for locator, text in sections
                          if _parse_locator(locator)[0] == prefix
                          and first <= _parse_locator(locator)[1] <= last)
        for line in chunk.text.split("\n"):
            assert line.strip() in cited, (chunk.locator, line)


def test_overlap_from_a_previous_page_is_inside_the_locator() -> None:
    pages = [("p1", ("Body text of the first page. " * 50) + "Invoice total -12.50 USD"),
             ("p2", "Second page body sentence. " * 60)]
    chunks = chunk_sections(pages)

    carried = next(chunk for chunk in chunks if "-12.50" in chunk.text and "Second" in chunk.text)
    assert carried.locator == "p1-2"
    _assert_recoverable(chunks, pages)


def test_overlap_from_previous_lines_is_inside_the_locator() -> None:
    sections = _lines("\n".join(f"line {n} " + f"only{n}here " * 12 for n in range(1, 41)))
    chunks = chunk_sections(sections, max_chars=300, overlap_chars=120)

    assert len(chunks) > 3
    _assert_recoverable(chunks, sections)
    for previous, chunk in zip(chunks, chunks[1:], strict=False):
        assert _parse_locator(chunk.locator)[1] <= _parse_locator(previous.locator)[2]


def test_markdown_headings_start_a_new_chunk() -> None:
    body = "word " * 30
    text = f"# One\n{body}\n# Two\n{body}"
    chunks = chunk_sections(_lines(text), max_chars=400, overlap_chars=0)

    assert [chunk.text.split("\n")[0] for chunk in chunks] == ["# One", "# Two"]
    assert [chunk.locator for chunk in chunks] == ["L1-2", "L3-4"]


def test_oversize_paragraph_splits_at_a_sentence_boundary() -> None:
    sentence = "This is a sentence that ends here. "
    chunks = chunk_sections([("p2", sentence * 10)], max_chars=100, overlap_chars=0)

    assert len(chunks) > 1
    assert all(len(chunk.text) <= 100 for chunk in chunks)
    assert all(chunk.text.endswith(".") for chunk in chunks)
    assert {chunk.locator for chunk in chunks} == {"p2"}


def test_oversize_paragraph_without_boundaries_hard_splits() -> None:
    chunks = chunk_sections([("L1-1", "x" * 250)], max_chars=100, overlap_chars=0)

    assert [len(chunk.text) for chunk in chunks] == [100, 100, 50]


def test_oversize_multi_line_paragraph_pieces_keep_their_line_spans() -> None:
    lines = [f"line {index} " + "y" * 40 + "." for index in range(1, 7)]
    chunks = chunk_sections(_lines("\n".join(lines)), max_chars=110, overlap_chars=0)

    assert [chunk.locator for chunk in chunks] == ["L1-2", "L3-4", "L5-6"]


def test_page_and_paragraph_locators_span_sections() -> None:
    pages = chunk_sections([("p2", "short page"), ("p3", "another short page")], max_chars=500)
    paras = chunk_sections([(f"para{n}", f"paragraph {n}") for n in range(4, 10)], max_chars=500)

    assert [chunk.locator for chunk in pages] == ["p2-3"]
    assert [chunk.locator for chunk in paras] == ["para4-9"]
    assert paras[0].text.count("\n\n") == 5  # section boundaries are paragraph breaks


def test_whitespace_only_input_has_no_chunks_and_the_cap_holds() -> None:
    assert chunk_sections([("L1-1", "   "), ("L2-2", "")]) == []
    many = [(f"para{n}", "x" * 50) for n in range(1, MAX_CHUNKS_PER_DOCUMENT * 2)]
    chunks = chunk_sections(many, max_chars=60, overlap_chars=0)
    assert len(chunks) == MAX_CHUNKS_PER_DOCUMENT
    assert [chunk.ordinal for chunk in chunks[:3]] == [0, 1, 2]


def test_rejects_bad_sizes() -> None:
    with pytest.raises(ValueError):
        chunk_sections([], max_chars=0)


def test_chunk_document_reports_cap_truncation() -> None:
    from sidecar.ai.semantic.chunker import chunk_document

    many = [(f"para{n}", "x" * 50) for n in range(1, MAX_CHUNKS_PER_DOCUMENT * 2)]
    chunks, truncated = chunk_document(many, max_chars=60, overlap_chars=0)
    assert (len(chunks), truncated) == (MAX_CHUNKS_PER_DOCUMENT, True)
    exact = [(f"para{n}", "x" * 50) for n in range(1, MAX_CHUNKS_PER_DOCUMENT + 1)]
    chunks, truncated = chunk_document(exact, max_chars=60, overlap_chars=0)
    assert (len(chunks), truncated) == (MAX_CHUNKS_PER_DOCUMENT, False)


class _CountingMarks:
    """A block's marks that count every element visit (``__getitem__``)."""

    def __init__(self, marks) -> None:
        self._marks = tuple(marks)
        self.visits = 0

    def __len__(self) -> int:
        return len(self._marks)

    def __getitem__(self, index):
        self.visits += 1
        return self._marks[index]


def test_large_single_paragraph_locators_are_exact_and_mark_visits_linear(monkeypatch) -> None:
    from sidecar.ai.semantic import chunker

    wrapped: list[_CountingMarks] = []
    original = chunker._block_of

    def counting_block_of(units, *, heading=False):
        block = original(units, heading=heading)
        wrapped.append(_CountingMarks(block.marks))
        return chunker._Block(block.text, wrapped[-1], block.heading)  # type: ignore[arg-type]

    monkeypatch.setattr(chunker, "_block_of", counting_block_of)
    lines = [(f"row {n:05d} " + "word " * 10)[:49] for n in range(1, 3001)]  # 50 chars per line
    chunks = chunk_sections(_lines("\n".join(lines)))

    # One 3000-line paragraph splits into 30-line pieces; each chunk after the
    # first carries a ~200-char tail that starts inside the previous piece's line 27.
    assert [chunk.locator for chunk in chunks] == ["L1-30"] + [
        f"L{30 * piece - 3}-{30 * (piece + 1)}" for piece in range(1, 100)]
    _assert_recoverable(chunks, _lines("\n".join(lines)))
    assert len(wrapped) == 1 and len(wrapped[0]) == 3000
    # A22 review R2: every piece rescanned all 3000 marks (about 600,000 visits).
    assert wrapped[0].visits <= 3 * (len(wrapped[0]) + len(chunks))
