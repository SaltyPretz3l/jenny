"""`fetch_url` reads a long page in parts with `offset` (row 129, C5)."""

from __future__ import annotations

import json

import pytest

from sidecar.ai.tools.builtins import web
from sidecar.ai.tools.builtins.web import (
    _CachedFetchEntry,
    _fetch_cache,
    configure_web_tools,
    fetch_url_tool,
)

_URL = "https://example.com/long"


def _entry(content: str, *, truncated: bool = False) -> _CachedFetchEntry:
    return _CachedFetchEntry(
        requested_url=_URL, final_url=_URL, redirect_chain=(), status_code=200,
        content_type="text/plain", content_format="text", content=content,
        truncated=truncated, size_bytes=len(content),
    )


def _page(chars: int) -> str:
    return "".join(f"{index:07d}\n" for index in range(chars // 8 + 1))[:chars]


@pytest.fixture(autouse=True)
def _clean_web_state():
    def reset() -> None:
        configure_web_tools({"tools_web_rate_limit_per_min": 300})
        _fetch_cache.clear()

    reset()
    yield
    reset()


def _fetch(**arguments: object) -> dict[str, object]:
    result = fetch_url_tool({"url": _URL, **arguments}, None)
    assert result.success
    assert len(result.output) <= 16_000  # the router's per-result cap: the JSON must stay whole
    return json.loads(result.output)


def test_a_truncated_result_says_the_page_size_and_the_offset_to_continue() -> None:
    page = _page(30_000)
    _fetch_cache.set(_URL, _entry(page))

    data = _fetch(max_chars=2000)

    assert data["truncated"] is True
    assert data["total_chars"] == 30_000
    next_offset = data["next_offset"]
    assert isinstance(next_offset, int) and 0 < next_offset < 2000
    assert f"offset={next_offset}" in str(data["note"])
    assert "30000 characters" in str(data["note"])
    assert page.startswith(str(data["content"])[:next_offset])


def test_continuing_from_next_offset_is_gap_free_and_served_from_the_cache() -> None:
    page = _page(30_000)
    _fetch_cache.set(_URL, _entry(page))

    pieces: list[str] = []
    offset = 0
    for _ in range(40):
        data = _fetch(max_chars=20_000, offset=offset)
        assert data["cache_hit"] is True
        next_offset = data.get("next_offset")
        shown = next_offset - offset if isinstance(next_offset, int) else len(page) - offset
        pieces.append(str(data["content"])[:shown])
        if not isinstance(next_offset, int):
            break
        offset = next_offset
    assert "".join(pieces) == page


def test_a_result_that_fits_has_no_paging_note() -> None:
    _fetch_cache.set(_URL, _entry("short page"))

    data = _fetch()

    assert data["content"] == "short page"
    assert "next_offset" not in data and "note" not in data


def test_an_offset_past_the_end_is_a_short_message_not_an_error() -> None:
    _fetch_cache.set(_URL, _entry("x" * 500))

    data = _fetch(offset=9000)

    assert data["ok"] is True
    assert data["content"] == ""
    assert "past the end" in str(data["note"]) and "500 characters" in str(data["note"])


def test_a_negative_or_bad_offset_reads_from_the_start() -> None:
    _fetch_cache.set(_URL, _entry("hello page"))

    assert _fetch(offset=-5)["content"] == "hello page"
    assert _fetch(offset="soon")["content"] == "hello page"


def test_the_cache_keeps_more_of_a_long_page_than_one_result_returns() -> None:
    assert web._FETCH_CACHED_CONTENT_CHARS > web._MAX_FETCH_CONTENT_CHARS


def test_a_page_full_of_escaped_characters_still_pages_without_gaps() -> None:
    page = '"\n' * 15_000
    _fetch_cache.set(_URL, _entry(page))

    pieces: list[str] = []
    offset = 0
    for _ in range(80):
        data = _fetch(max_chars=20_000, offset=offset)
        next_offset = data.get("next_offset")
        shown = next_offset - offset if isinstance(next_offset, int) else len(page) - offset
        pieces.append(str(data["content"])[:shown])
        if not isinstance(next_offset, int):
            break
        offset = next_offset
    assert "".join(pieces) == page


def test_a_page_cut_at_the_cache_cap_says_it_is_longer_than_what_can_be_read() -> None:
    page = _page(web._FETCH_CACHED_CONTENT_CHARS)
    _fetch_cache.set(_URL, _entry(page))

    data = _fetch(offset=len(page) - 100)

    assert data["content"] == page[-100:]
    assert "longer than" in str(data["note"])
    assert "next_offset" not in data
