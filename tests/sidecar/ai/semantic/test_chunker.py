from __future__ import annotations

import pytest

from sidecar.ai.semantic.chunker import chunk_sections
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

    assert [chunk.locator for chunk in chunks] == ["L1-1", "L3-3"]
    assert chunks[1].text.endswith(second.strip())
    tail = chunks[1].text.split("\n")[0]
    assert tail and first.strip().endswith(tail)  # overlap from the previous tail
    assert len(tail) <= 20


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
