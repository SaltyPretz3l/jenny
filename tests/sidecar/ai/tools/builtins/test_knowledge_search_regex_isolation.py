"""knowledge_search never runs the model's regex in the sidecar process.

The grep worker subprocess (killable, per-request timeout) is the only place a
model-supplied pattern executes. knowledge_search once re-ran the pattern
in-process over the worker's rendered lines to pick a snippet and count distinct
terms; a polynomial pattern the ReDoS pre-filter misses then held the GIL for
seconds per file and stalled the whole sidecar.
"""

from __future__ import annotations

import json
import re
import time
from concurrent.futures import TimeoutError as FutureTimeoutError
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins import grep_search as grep_module
from sidecar.ai.tools.builtins.grep_search_file import (
    MATCH_SUMMARY_OP,
    FileSearchResult,
    run_lines_request,
)
from sidecar.ai.tools.builtins.knowledge import search as search_module
from sidecar.ai.tools.builtins.knowledge.roots import scoped_knowledge_tools
from sidecar.ai.tools.contracts import ToolHandlerResult

# Passes looks_like_catastrophic_regex; ``^x`` lets the worker's line search stop
# at once, while a finditer over the rest of the line backtracks polynomially
# (about 6 s for a 70-character line in-process before the fix).
_POLYNOMIAL_PATTERN = r"^x|\w*\w*\w*\w*\w*\w*!"
_LONG_LINE = "x" + "a" * 80


def _payload(result: ToolHandlerResult) -> dict[str, object]:
    parsed = json.loads(result.output)
    assert isinstance(parsed, dict)
    return parsed


def _sources(result: ToolHandlerResult) -> dict[str, dict[str, object]]:
    sources = _payload(result)["sources"]
    assert isinstance(sources, list)
    return {str(source["path"]): source for source in sources}


def _search_result(lines: list[str], **summary: int | None) -> FileSearchResult:
    return FileSearchResult(
        lines=lines,
        returned_match_count=len(lines),
        total_match_count=len(lines),
        truncated=False,
        truncated_by_bytes=False,
        truncated_by_line_length=False,
        output_bytes_used=sum(len(line) for line in lines),
        **summary,
    )


class _FakeWorker:
    """Stands in for the regex worker: every file yields the probe's long line."""

    summary_timeout = False
    instances: list[_FakeWorker] = []

    def __init__(self) -> None:
        self.summary_requests: list[dict[str, object]] = []
        _FakeWorker.instances.append(self)

    def search(self, *, path: Path, **_kwargs: object) -> FileSearchResult:
        return _search_result([f"{path.name}:1:{_LONG_LINE}"])

    def request(self, request: dict[str, object], timeout_seconds: float) -> FileSearchResult:
        assert timeout_seconds == grep_module.REGEX_SEARCH_TIMEOUT_SECONDS
        self.summary_requests.append(request)
        if self.summary_timeout:
            raise FutureTimeoutError()
        return _search_result([], first_match_index=0, distinct_match_count=1)

    def close(self) -> None:
        return None


@pytest.fixture
def fake_worker(monkeypatch: pytest.MonkeyPatch) -> type[_FakeWorker]:
    _FakeWorker.instances = []
    _FakeWorker.summary_timeout = False
    monkeypatch.setattr(search_module, "_RegexSearchWorker", _FakeWorker)
    return _FakeWorker


def test_polynomial_regex_on_a_long_line_does_not_stall_the_sidecar(
    tmp_path: Path, fake_worker: type[_FakeWorker]
) -> None:
    root = tmp_path / "notes"
    root.mkdir()
    (root / "long.txt").write_text(_LONG_LINE + "\n", encoding="utf-8")

    with scoped_knowledge_tools((str(root),)):
        started = time.perf_counter()
        result = search_module.knowledge_search_tool({"pattern": _POLYNOMIAL_PATTERN}, None)
        elapsed = time.perf_counter() - started

    assert elapsed < 2.0, f"knowledge_search took {elapsed:.2f}s on a polynomial pattern"
    assert result.success is True
    assert _sources(result)["notes/long.txt"]["snippet"] == _LONG_LINE
    (worker,) = fake_worker.instances
    (summary,) = worker.summary_requests
    assert summary["op"] == MATCH_SUMMARY_OP
    assert summary["pattern"] == _POLYNOMIAL_PATTERN
    assert summary["lines"] == [_LONG_LINE]


def test_summary_timeout_keeps_matches_and_stops_further_summaries(
    tmp_path: Path, fake_worker: type[_FakeWorker]
) -> None:
    root = tmp_path / "notes"
    root.mkdir()
    for name in ("a.txt", "b.txt", "c.txt"):
        (root / name).write_text(_LONG_LINE + "\n", encoding="utf-8")
    fake_worker.summary_timeout = True

    with scoped_knowledge_tools((str(root),)):
        result = search_module.knowledge_search_tool({"pattern": _POLYNOMIAL_PATTERN}, None)

    assert result.success is True
    sources = _sources(result)
    assert set(sources) == {"notes/a.txt", "notes/b.txt", "notes/c.txt"}
    assert {source["snippet"] for source in sources.values()} == {_LONG_LINE}
    (worker,) = fake_worker.instances
    assert len(worker.summary_requests) == 1
    # A summary timeout is not a search timeout: every file's lines were kept.
    assert result.metadata["timed_out_files"] == 0


class _NoInProcessRegex:
    """A compiled-pattern stand-in that only exposes what the worker request needs."""

    def __init__(self, compiled: re.Pattern[str], calls: list[str]) -> None:
        self.pattern = compiled.pattern
        self.flags = compiled.flags
        self._calls = calls

    def _forbidden(self, name: str) -> None:
        self._calls.append(name)
        raise AssertionError(f"regex {name} ran in the sidecar process")

    def search(self, *_args: object, **_kwargs: object) -> None:
        self._forbidden("search")

    def match(self, *_args: object, **_kwargs: object) -> None:
        self._forbidden("match")

    def fullmatch(self, *_args: object, **_kwargs: object) -> None:
        self._forbidden("fullmatch")

    def finditer(self, *_args: object, **_kwargs: object) -> None:
        self._forbidden("finditer")

    def findall(self, *_args: object, **_kwargs: object) -> None:
        self._forbidden("findall")

    def sub(self, *_args: object, **_kwargs: object) -> None:
        self._forbidden("sub")

    def split(self, *_args: object, **_kwargs: object) -> None:
        self._forbidden("split")


@pytest.mark.parametrize("context_lines", [0, 1])
def test_knowledge_search_runs_the_regex_only_in_the_worker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, context_lines: int
) -> None:
    root = tmp_path / "notes"
    root.mkdir()
    (root / "context.txt").write_text(
        "leading context\nthe Needle line\ntrailing needle NEEDLE\n", encoding="utf-8"
    )
    calls: list[str] = []
    original = search_module.compile_search_pattern

    def guarded(arguments: dict[str, object]) -> tuple[object, str | None]:
        compiled, query = original(arguments)
        return _NoInProcessRegex(compiled, calls), query

    monkeypatch.setattr(search_module, "compile_search_pattern", guarded)
    strengths: list[dict[str, tuple[int, int]]] = []
    real_result = search_module._knowledge_search_result

    def spy_result(*, context: search_module._RootSearchContext, **kwargs: object):
        strengths.append(dict(context.lexical_strength))
        return real_result(context=context, **kwargs)

    monkeypatch.setattr(search_module, "_knowledge_search_result", spy_result)

    with scoped_knowledge_tools((str(root),)):
        result = search_module.knowledge_search_tool(
            {"pattern": "needle", "ignore_case": True, "context_lines": context_lines}, None
        )

    assert calls == []
    assert result.success is True
    assert _sources(result)["notes/context.txt"]["snippet"] == "the Needle line"
    # Distinct terms casefold; two matching lines.
    assert strengths == [{"notes/context.txt": (1, 2)}]


def _summary(texts: list[str], pattern: str, flags: int = 0) -> dict[str, object]:
    response = run_lines_request({
        "op": MATCH_SUMMARY_OP, "lines": texts, "pattern": pattern, "flags": flags,
    })
    assert response["status"] == "ok"
    result = grep_module._response_to_search_result(response)
    return {
        "first": result.first_match_index,
        "distinct": result.distinct_match_count,
    }


def test_match_summary_worker_op_keeps_snippet_and_distinct_semantics() -> None:
    texts = ["leading context", "a Needle here", "NEEDLE and needle", "no"]
    assert _summary(texts, "needle", int(re.IGNORECASE)) == {"first": 1, "distinct": 1}
    assert _summary(texts, "needle|here") == {"first": 1, "distinct": 2}
    assert _summary(texts, "absent") == {"first": None, "distinct": 0}
    # An empty match still selects its line but is never a distinct term.
    assert _summary(texts, "z*") == {"first": 0, "distinct": 0}


def test_match_summary_rejects_malformed_requests() -> None:
    response = run_lines_request({"op": MATCH_SUMMARY_OP, "lines": [1], "pattern": "x"})
    assert response["status"] == "error"


def test_plain_grep_responses_carry_no_summary() -> None:
    response = run_lines_request({
        "lines": ["needle"], "display_path": "f.txt", "pattern": "needle",
        "context_lines": 0, "max_output_matches": 5, "max_output_bytes": 1000,
    })
    assert "distinct_match_count" not in response
    result = grep_module._response_to_search_result(response)
    assert result.lines == ["f.txt:1:needle"]
    assert result.first_match_index is None
    assert result.distinct_match_count is None


def test_summary_request_texts_fit_the_worker_protocol() -> None:
    texts = ["\x01" * 450] * 60  # each control char JSON-escapes to six characters
    bounded = search_module._summary_texts(texts)
    assert 0 < len(bounded) < len(texts)
    assert bounded == texts[: len(bounded)]
    request = {
        "op": MATCH_SUMMARY_OP, "lines": bounded, "pattern": "\x01" * 2000, "flags": 0,
    }
    assert grep_module._encode_worker_message(request)
