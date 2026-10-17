"""Citation locators: parsing, the locator kind a file needs, and range checks.

Catalog chunks cite ``L<a>-<b>`` (text lines), ``p<N>``/``p<a>-<b>`` (PDF pages)
or ``para<N>`` (docx paragraphs; see ``chunker.py``). These pure helpers let the
knowledge tools and the evaluation answer boundary reject a locator whose kind
does not fit the cited file (a page locator for a markdown file) or whose range
cannot exist, instead of trusting the model's translation. No I/O.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import PurePath

LINES = "lines"
PAGES = "pages"
PARAGRAPHS = "paragraphs"

OK = "ok"
INVALID_LOCATOR = "invalid_locator"
INVALID_LOCATOR_KIND = "invalid_locator_kind"
LOCATOR_OUT_OF_RANGE = "locator_out_of_range"

MAX_LOCATOR_CHARS = 32
_KIND_BY_PREFIX = {"L": LINES, "p": PAGES, "para": PARAGRAPHS}
_KIND_BY_SUFFIX = {".pdf": PAGES, ".docx": PARAGRAPHS}
_LOCATOR_RE = re.compile(r"(?P<prefix>L|para|p)(?P<start>[0-9]{1,9})(?:-(?P<end>[0-9]{1,9}))?")


@dataclass(frozen=True)
class Locator:
    kind: str
    start: int
    end: int


def parse_locator(text: object) -> Locator | None:
    """The locator ``text`` names, or None when it is not one of the catalog shapes."""
    if not isinstance(text, str) or len(text) > MAX_LOCATOR_CHARS:
        return None
    match = _LOCATOR_RE.fullmatch(text.strip())
    if match is None:
        return None
    start = int(match.group("start"))
    end = int(match.group("end") or start)
    return Locator(_KIND_BY_PREFIX[match.group("prefix")], start, end)


def locator_kind_for_path(path: str | PurePath) -> str:
    """The locator kind a citation of ``path`` must use."""
    return _KIND_BY_SUFFIX.get(PurePath(path).suffix.lower(), LINES)


def validate_locator(
    locator_text: object, path: str | PurePath, *, extent: int | None = None,
) -> str:
    """``ok`` or the reason ``locator_text`` cannot cite ``path``.

    ``extent`` is the file's line/page/paragraph count when the caller knows it;
    without it only the range's own shape (start >= 1, end >= start) is checked.
    """
    locator = parse_locator(locator_text)
    if locator is None:
        return INVALID_LOCATOR
    if locator.kind != locator_kind_for_path(path):
        return INVALID_LOCATOR_KIND
    if locator.start < 1 or locator.end < locator.start:
        return LOCATOR_OUT_OF_RANGE
    if extent is not None and locator.end > extent:
        return LOCATOR_OUT_OF_RANGE
    return OK
