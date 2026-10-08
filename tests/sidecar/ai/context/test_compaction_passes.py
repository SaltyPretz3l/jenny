"""CMC-008 follow-up: an over-limit summary source is folded in passes, not dropped.

One summariser request cannot hold a source larger than its input limit. The
old admission dropped the oldest rows; the saved summary then stood in for
rows the summariser never read. Folding the source oldest first (running
summary plus the next rows that fit) keeps every row in what the model sees.
"""

from __future__ import annotations

from functools import partial
from typing import Any

import pytest

from sidecar.ai.context.compaction import (
    COMPACTED_SUMMARY_HEADING,
    CompactionCircuitBreaker,
    compact_context,
)
from sidecar.ai.context.compaction_passes import (
    MAX_SUMMARY_PASSES,
    SUMMARY_PASS_TIME_BUDGET_SECONDS,
    summarize_source_in_passes,
)
from sidecar.ai.context.compaction_prompts import (
    COMPACTION_SUMMARY_RETRY_REMINDER,
    build_full_compaction_messages,
)
from sidecar.ai.context.compaction_window import summary_input_limit
from sidecar.ai.context.token_budget import (
    CharEstimationBackend,
    TokenBudget,
    estimate_messages_tokens,
)

_SECTIONS = (
    "Intent Summary",
    "Key Technical Concepts",
    "Relevant Files & Code",
    "Errors & Debugging",
    "Problem-Solving Approaches",
    "User Messages",
    "Pending Tasks",
    "Current Work",
    "Next Step",
)


def _canned_summary(tag: str) -> str:
    body = "\n".join(f"{index}. **{name}** — {tag}." for index, name in enumerate(_SECTIONS, 1))
    return f"<summary>\n{body}\n</summary>"


def _budget() -> TokenBudget:
    return TokenBudget(context_window=4_000, max_output_tokens=400, reserved_for_summary=400)


def _limit(budget: TokenBudget, backend: CharEstimationBackend) -> int:
    prompt_tokens = estimate_messages_tokens(
        [
            *build_full_compaction_messages([]),
            {"role": "system", "content": COMPACTION_SUMMARY_RETRY_REMINDER},
        ],
        backend,
    )
    return summary_input_limit(budget, prompt_tokens=prompt_tokens, backend=backend)


def _rows(count: int, *, chars: int = 1_000) -> list[dict[str, Any]]:
    """Alternating user/assistant rows, each carrying a unique ``row-<n>-key`` marker."""
    return [
        {
            "role": "user" if index % 2 == 0 else "assistant",
            "content": f"row-{index}-key " + ("x" * chars),
        }
        for index in range(count)
    ]


def _summary_row(text: str) -> dict[str, Any]:
    return {"role": "system", "content": f"{COMPACTED_SUMMARY_HEADING}\n\n{text}"}


class _Summariser:
    """Records each request's conversation block and answers ``pass-<n>``."""

    def __init__(self) -> None:
        self.requests: list[str] = []

    def __call__(self, request: list[dict[str, str]]) -> str:
        self.requests.append(request[1]["content"])
        return f"pass-{len(self.requests)}"


def _run(rows: list[dict[str, Any]], summariser: _Summariser, **kwargs: Any) -> Any:
    return summarize_source_in_passes(
        rows,
        _budget(),
        CharEstimationBackend(),
        build_request=partial(build_full_compaction_messages),
        summarize=summariser,
        summary_row=_summary_row,
        pin_first=kwargs.pop("pin_first", False),
        **kwargs,
    )


def test_a_source_that_fits_is_one_pass_with_the_rows_untouched() -> None:
    rows = _rows(2)
    summariser = _Summariser()

    outcome = _run(rows, summariser)

    assert (outcome.passes, outcome.dropped_messages, outcome.truncated) == (1, 0, False)
    assert outcome.summary_text == "pass-1"
    assert len(summariser.requests) == 1
    assert all(f"row-{index}-key" in summariser.requests[0] for index in range(2))


def test_an_over_limit_source_is_folded_in_passes_and_no_row_is_dropped() -> None:
    backend = CharEstimationBackend()
    rows = _rows(9)
    limit = _limit(_budget(), backend)
    assert estimate_messages_tokens(rows, backend) > limit
    summariser = _Summariser()

    outcome = _run(rows, summariser)

    assert 2 <= outcome.passes <= MAX_SUMMARY_PASSES
    assert outcome.passes == len(summariser.requests)
    assert outcome.dropped_messages == 0
    assert outcome.summary_text == f"pass-{outcome.passes}"
    # Every row reached the summariser exactly once, oldest first.
    seen = [
        [index for index in range(9) if f"row-{index}-key" in request]
        for request in summariser.requests
    ]
    assert [index for chunk in seen for index in chunk] == list(range(9))
    # Each later pass re-folds the summary of the pass before it.
    for number, request in enumerate(summariser.requests[1:], start=1):
        assert COMPACTED_SUMMARY_HEADING in request
        assert f"pass-{number}" in request
    assert "omitted from this summary input" not in "".join(summariser.requests)


def test_every_pass_request_fits_the_summary_input_limit() -> None:
    backend = CharEstimationBackend()
    limit = _limit(_budget(), backend)
    sent: list[int] = []

    def summarise(request: list[dict[str, str]]) -> str:
        sent.append(estimate_messages_tokens([request[1]], backend))
        return "ok"

    summarize_source_in_passes(
        _rows(9),
        _budget(),
        backend,
        build_request=partial(build_full_compaction_messages),
        summarize=summarise,
        summary_row=_summary_row,
        pin_first=False,
    )

    block_overhead = estimate_messages_tokens(
        [build_full_compaction_messages([])[1]], backend
    )
    assert len(sent) >= 2
    assert all(tokens - block_overhead <= limit for tokens in sent), (sent, limit)


def test_a_pinned_prior_summary_is_folded_into_the_first_pass() -> None:
    prior = _summary_row("Prior facts: reconcile account 4411.")
    summariser = _Summariser()

    outcome = _run([prior, *_rows(9)], summariser, pin_first=True)

    assert outcome.dropped_messages == 0
    assert "Prior facts: reconcile account 4411." in summariser.requests[0]
    assert all("Prior facts" not in request for request in summariser.requests[1:])


def test_the_pass_cap_falls_back_to_the_reported_oldest_first_drop() -> None:
    summariser = _Summariser()

    outcome = _run(_rows(40), summariser)

    assert outcome.passes == MAX_SUMMARY_PASSES == len(summariser.requests)
    assert outcome.dropped_messages > 0
    assert outcome.truncated is True
    final = summariser.requests[-1]
    assert f"[{outcome.dropped_messages} earlier messages omitted from this summary input]" in final
    # The running summary and the newest rows survive the drop.
    assert f"pass-{MAX_SUMMARY_PASSES - 1}" in final
    assert "row-39-key" in final


def test_the_time_budget_stops_further_passes() -> None:
    summariser = _Summariser()
    now = {"value": 0.0}

    def slow(request: list[dict[str, str]]) -> str:
        now["value"] += SUMMARY_PASS_TIME_BUDGET_SECONDS / 2
        return summariser(request)

    outcome = summarize_source_in_passes(
        _rows(20),
        _budget(),
        CharEstimationBackend(),
        build_request=partial(build_full_compaction_messages),
        summarize=slow,
        summary_row=_summary_row,
        pin_first=False,
        clock=lambda: now["value"],
    )

    # One fold, then the final (dropping) pass: a third pass would overrun.
    assert outcome.passes == 2
    assert outcome.dropped_messages > 0
    assert "pass-1" in summariser.requests[-1]


def test_a_pace_that_fits_one_more_fold_takes_it() -> None:
    summariser = _Summariser()
    now = {"value": 0.0}

    def paced(request: list[dict[str, str]]) -> str:
        now["value"] += SUMMARY_PASS_TIME_BUDGET_SECONDS * 0.3
        return summariser(request)

    outcome = summarize_source_in_passes(
        _rows(40),
        _budget(),
        CharEstimationBackend(),
        build_request=partial(build_full_compaction_messages),
        summarize=paced,
        summary_row=_summary_row,
        pin_first=False,
        clock=lambda: now["value"],
    )

    # 0.3 + 2 * 0.3 fits the budget (second fold runs); 0.6 + 2 * 0.3 does not.
    assert outcome.passes == 3


def test_a_running_summary_over_half_the_limit_is_kept_through_the_drop() -> None:
    backend = CharEstimationBackend()
    limit = _limit(_budget(), backend)
    rows = _rows(5, chars=int(limit * 0.4) * 4)
    requests: list[str] = []

    def long_summary(request: list[dict[str, str]]) -> str:
        requests.append(request[1]["content"])
        return f"fold-{len(requests)}-key " + "s" * (int(limit * 0.7) * 4)

    outcome = summarize_source_in_passes(
        rows,
        _budget(),
        backend,
        build_request=partial(build_full_compaction_messages),
        summarize=long_summary,
        summary_row=_summary_row,
        pin_first=False,
    )

    # Rows 0 and 1 were folded; that summary must reach the final request.
    assert "row-0-key" in requests[0] and "row-1-key" in requests[0]
    assert "fold-1-key" in requests[-1]
    assert "row-4-key" in requests[-1]
    missing = [
        index for index in range(5) if not any(f"row-{index}-key" in text for text in requests)
    ]
    assert outcome.dropped_messages == len(missing) > 0


def test_a_fold_summary_larger_than_the_limit_fails_the_attempt() -> None:
    backend = CharEstimationBackend()
    limit = _limit(_budget(), backend)

    def huge_summary(_request: list[dict[str, str]]) -> str:
        return "s" * (limit * 8)

    with pytest.raises(ValueError, match="size limit"):
        summarize_source_in_passes(
            _rows(9),
            _budget(),
            backend,
            build_request=partial(build_full_compaction_messages),
            summarize=huge_summary,
            summary_row=_summary_row,
            pin_first=False,
        )


def test_an_oversized_row_dropped_at_the_cap_is_counted_once() -> None:
    backend = CharEstimationBackend()
    limit = _limit(_budget(), backend)
    rows = _rows(40)
    rows[30] = {"role": "user", "content": "giant-paste-key " + "g" * (limit * 8)}
    summariser = _Summariser()

    outcome = _run(rows, summariser)

    everything = "".join(summariser.requests)
    missing = [index for index in range(40) if f"row-{index}-key" not in everything]
    assert 30 in missing
    assert outcome.dropped_messages == len(missing)


class _WindowEnforcingSummariser(_Summariser):
    def __call__(self, request: list[dict[str, str]]) -> str:
        tokens = estimate_messages_tokens([request[1]], CharEstimationBackend())
        limit = _limit(_budget(), CharEstimationBackend())
        assert tokens <= limit, f"Summary row part exceeds input limit: {tokens} > {limit}"
        return super().__call__(request)


def _newest_giant(limit: int) -> tuple[str, list[str]]:
    markers = [f"piece-{i}-key" for i in range(100)]
    numbered = " ".join(markers) + " "
    content = (numbered * (limit * 8 // len(numbered) + 1))[:limit * 8]
    return content, markers


def test_an_oversized_newest_row_is_split_so_every_request_fits() -> None:
    backend = CharEstimationBackend()
    limit = _limit(_budget(), backend)
    content, markers = _newest_giant(limit)
    newest = {"role": "user", "content": content, "name": "author", "metadata": {"id": 42}}
    summariser = _WindowEnforcingSummariser()
    pieces: list[dict[str, Any]] = []

    def build_request(rows: list[dict[str, Any]]) -> list[dict[str, str]]:
        pieces.extend(row for row in rows if row.get("name") == "author")
        return build_full_compaction_messages(rows)

    outcome = summarize_source_in_passes(
        [newest],
        _budget(),
        backend,
        build_request=build_request,
        summarize=summariser,
        summary_row=_summary_row,
        pin_first=False,
    )

    assert outcome.dropped_messages == 0
    assert len(summariser.requests) > 1
    assert all(any(marker in request for request in summariser.requests) for marker in markers)
    assert "".join(piece["content"] for piece in pieces) == content
    assert all(piece["content"] for piece in pieces)
    assert all(estimate_messages_tokens((piece,), backend) <= limit // 2 for piece in pieces)
    assert all({**piece, "content": content} == newest for piece in pieces)
    assert newest["content"] == content


def test_a_newest_tool_call_row_without_text_is_sent_whole() -> None:
    backend = CharEstimationBackend()
    limit = _limit(_budget(), backend)
    newest = {
        "role": "assistant",
        "content": "",
        "tool_calls": [{"name": "read_file", "arguments": "a" * (limit * 3)}],
    }
    size = estimate_messages_tokens((newest,), backend)
    assert limit // 2 < size <= limit
    summariser = _Summariser()

    outcome = _run([*_rows(2, chars=40), newest], summariser)

    assert outcome.dropped_messages == 0
    assert newest["content"] == ""
    assert len(summariser.requests) >= 1


def test_an_older_giant_is_omitted_and_the_newest_giant_is_split() -> None:
    backend = CharEstimationBackend()
    limit = _limit(_budget(), backend)
    content, markers = _newest_giant(limit)
    summariser = _WindowEnforcingSummariser()

    outcome = _run(
        [
            {"role": "user", "content": "older-giant-key " + "g" * (limit * 8)},
            {"role": "assistant", "content": content},
        ],
        summariser,
    )

    assert outcome.dropped_messages == 1
    assert len(summariser.requests) > 1
    everything = "".join(summariser.requests)
    assert "older-giant-key" not in everything
    assert "too large for this summary input" in everything
    assert all(any(marker in request for request in summariser.requests) for marker in markers)


def test_one_row_larger_than_the_limit_is_omitted_and_the_rest_is_folded() -> None:
    backend = CharEstimationBackend()
    limit = _limit(_budget(), backend)
    rows = _rows(9)
    rows[2] = {"role": "user", "content": "giant-paste-key " + "g" * (limit * 8)}
    summariser = _Summariser()

    outcome = _run(rows, summariser)

    assert outcome.dropped_messages == 1
    assert outcome.truncated is True
    everything = "".join(summariser.requests)
    assert "giant-paste-key" not in everything
    assert "too large for this summary input" in everything
    assert all(f"row-{index}-key" in everything for index in range(9) if index != 2)


def _conversation(count: int) -> list[dict[str, Any]]:
    return [*_rows(count), {"role": "user", "content": "Continue."}]


def test_compact_context_reports_no_dropped_source_for_an_over_limit_chat() -> None:
    calls: list[str] = []

    def generate(request: list[dict[str, str]]) -> str:
        calls.append(request[1]["content"])
        return _canned_summary(f"fold-{len(calls)}")

    result = compact_context(
        _conversation(9),
        _budget(),
        generate_fn=generate,
        circuit_breaker=CompactionCircuitBreaker(),
        force=True,
    )

    assert (result.strategy, result.summary_status) == ("full", "created")
    assert len(calls) >= 2
    assert result.summary_input_dropped_messages == 0
    assert result.summary_input_truncated is False
    assert all(f"row-{index}-key" in "".join(calls) for index in range(9))
    assert f"fold-{len(calls)}" in str(result.summary_message)
    # The pass before the last was re-folded as derived data, heading intact.
    assert COMPACTED_SUMMARY_HEADING in calls[-1]
    assert f"fold-{len(calls) - 1}" in calls[-1]


def test_a_failed_later_pass_falls_back_to_microcompaction_with_one_breaker_failure() -> None:
    breaker = CompactionCircuitBreaker()
    calls = {"count": 0}

    def generate(_request: list[dict[str, str]]) -> str:
        calls["count"] += 1
        if calls["count"] == 2:
            raise RuntimeError("engine went away")
        return _canned_summary("ok")

    result = compact_context(
        _conversation(9),
        _budget(),
        generate_fn=generate,
        circuit_breaker=breaker,
        force=True,
    )

    assert calls["count"] == 2
    assert result.strategy == "micro"
    assert (result.summary_status, result.summary_failure_code) == (
        "failed",
        "summary_generation_failed",
    )
    assert breaker.failure_count == 1
