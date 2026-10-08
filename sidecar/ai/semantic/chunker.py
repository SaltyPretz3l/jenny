"""Paragraph- and heading-aware chunking of extracted sections.

Sections are ``(locator, text)`` pairs from ``extract.py``: one per line
(``L<n>-<n>``), page (``p<n>``) or docx paragraph (``para<n>``). Blank lines,
markdown headings and every non-line section boundary end a paragraph; small
paragraphs merge up to ``max_chars``; an oversize paragraph is split at a
sentence boundary (else hard at ``max_chars``). Each chunk after the first
starts with the tail of the previous one, and its locator spans the first..last
unit it covers (``L3-40``, ``p2-3``, ``para4-9``).
"""

from __future__ import annotations

import re
from bisect import bisect_right
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from sidecar.ai.semantic.store import MAX_CHUNKS_PER_DOCUMENT

_LOCATOR_RE = re.compile(r"^(?P<prefix>L|p|para)(?P<start>\d+)(?:-(?P<end>\d+))?$")
_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s")
_SENTENCE_END_RE = re.compile(r"[.!?;](?=\s)|\n")
_LINE_PREFIX = "L"


@dataclass(frozen=True)
class Chunk:
    ordinal: int
    locator: str
    text: str


@dataclass(frozen=True)
class _Unit:
    """One source line with the locator unit (line/page/paragraph) it came from."""

    text: str
    prefix: str
    number: int


@dataclass(frozen=True)
class _Block:
    """A paragraph (or a piece of one) plus the units its locator spans."""

    text: str
    units: tuple[_Unit, ...]
    heading: bool = False


def _block_of(units: Sequence[_Unit], *, heading: bool = False) -> _Block:
    return _Block("\n".join(unit.text for unit in units), tuple(units), heading)


def _parse_locator(locator: str) -> tuple[str, int, int]:
    match = _LOCATOR_RE.match(locator)
    if match is None:
        return locator, 0, 0
    start = int(match.group("start"))
    return match.group("prefix"), start, int(match.group("end") or start)


def _format_locator(units: Sequence[_Unit]) -> str:
    prefix = units[0].prefix
    numbers = [unit.number for unit in units if unit.prefix == prefix]
    first, last = min(numbers), max(numbers)
    if prefix != _LINE_PREFIX and first == last:
        return f"{prefix}{first}"
    return f"{prefix}{first}-{last}"


def _blocks(sections: Iterable[tuple[str, str]]) -> list[_Block]:
    blocks: list[_Block] = []
    current: list[_Unit] = []

    def flush() -> None:
        if current:
            blocks.append(_block_of(current))
            current.clear()

    for locator, text in sections:
        prefix, start, _end = _parse_locator(locator)
        if prefix != _LINE_PREFIX:
            flush()
        for line in str(text).splitlines() or [""]:
            if not line.strip():
                flush()
                continue
            if _HEADING_RE.match(line):
                flush()
                blocks.append(_block_of([_Unit(line, prefix, start)], heading=True))
                continue
            current.append(_Unit(line, prefix, start))
    flush()
    return blocks


def _split_point(text: str, max_chars: int) -> int:
    window = text[: max_chars + 1]
    best = -1
    for match in _SENTENCE_END_RE.finditer(window):
        if match.end() > max_chars // 2:
            best = match.end()
    return best if 0 < best <= max_chars else max_chars


def _split_oversize(block: _Block, max_chars: int) -> list[_Block]:
    """Split one paragraph into pieces of at most ``max_chars``, keeping unit spans."""
    text = block.text
    starts: list[int] = []
    position = 0
    for unit in block.units:
        starts.append(position)
        position += len(unit.text) + 1
    pieces: list[_Block] = []
    offset = 0
    while offset < len(text):
        window = text[offset : offset + max_chars + 1]
        cut = len(window) if len(text) - offset <= max_chars else _split_point(window, max_chars)
        piece = text[offset : offset + cut].strip()
        if piece:
            first = bisect_right(starts, offset) - 1
            last = bisect_right(starts, offset + cut - 1) - 1
            pieces.append(_Block(piece, block.units[first : last + 1], block.heading))
        offset += cut
    return pieces


def _overlap_tail(text: str, overlap_chars: int) -> str:
    if overlap_chars <= 0 or not text:
        return ""
    tail = text[-overlap_chars:]
    space = tail.find(" ")
    if len(text) > overlap_chars and 0 <= space < len(tail) - 1:
        tail = tail[space + 1 :]
    return tail.strip()


class _Assembler:
    def __init__(self, max_chars: int, overlap_chars: int) -> None:
        self.max_chars = max_chars
        self.overlap_chars = overlap_chars
        self.chunks: list[Chunk] = []
        self._texts: list[str] = []
        self._units: list[_Unit] = []
        self._size = 0

    def add(self, block: _Block) -> None:
        text = block.text
        if block.heading and self._size >= self.max_chars // 3:
            self.flush()
        if self._size and self._size + len(text) + 2 > self.max_chars:
            self.flush()
        self._texts.append(text)
        self._units.extend(block.units)
        self._size += len(text) + (2 if self._size else 0)

    def flush(self) -> None:
        if not self._texts:
            return
        body = "\n\n".join(self._texts).strip()
        if body:
            previous = self.chunks[-1].text if self.chunks else ""
            tail = _overlap_tail(previous, self.overlap_chars)
            text = f"{tail}\n{body}" if tail else body
            self.chunks.append(Chunk(len(self.chunks), _format_locator(self._units), text))
        self._texts, self._units, self._size = [], [], 0


def chunk_sections(
    sections: Sequence[tuple[str, str]],
    *,
    max_chars: int = 1500,
    overlap_chars: int = 200,
) -> list[Chunk]:
    """Chunk extracted sections; at most ``MAX_CHUNKS_PER_DOCUMENT`` chunks."""
    if max_chars < 1 or overlap_chars < 0:
        raise ValueError("max_chars must be positive and overlap_chars non-negative")
    assembler = _Assembler(max_chars, min(overlap_chars, max_chars // 2))
    for block in _blocks(sections):
        pieces = [block] if len(block.text) <= max_chars else _split_oversize(block, max_chars)
        for piece in pieces:
            assembler.add(piece)
        if len(assembler.chunks) >= MAX_CHUNKS_PER_DOCUMENT:
            break
    assembler.flush()
    return assembler.chunks[:MAX_CHUNKS_PER_DOCUMENT]
