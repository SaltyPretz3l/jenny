"""Multi-pass summariser input: an over-limit summary source is folded, not dropped.

A summary source that does not fit one summariser request is folded oldest
first: each pass summarises the running summary plus the next rows that fit,
and the result becomes the running summary of the next pass. Every row reaches
the summariser, so the saved summary stands in for nothing it never read.

Passes are capped by count and by a wall-clock budget. Past either cap the
rows after the running summary are dropped oldest first until the rest fits,
and the dropped count is reported as before. A single row too large to sit
beside the running summary is replaced by a marker and counted as dropped;
the newest row is never omitted or dropped (as before), whatever its size.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any, Callable

from sidecar.ai.context.compaction_prompts import COMPACTION_SUMMARY_RETRY_REMINDER
from sidecar.ai.context.compaction_window import (
    drop_oldest_rows,
    strip_summary_source,
    summary_input_limit,
)
from sidecar.ai.context.token_budget import (
    TokenBudget,
    TokenizerBackend,
    estimate_messages_tokens,
)

logger = logging.getLogger(__name__)

# Summariser calls per compaction, the final one included.
MAX_SUMMARY_PASSES = 4
# A further fold starts only while it and the final pass are projected to end
# inside this. The first fold has no pace to project from and always starts, so
# a compaction can take two passes however slow they are: manual "Compact now"
# (one RPC) carries a 300 s Electron timeout for that reason.
SUMMARY_PASS_TIME_BUDGET_SECONDS = 90.0
OVERSIZED_ROW_MARKER = "[1 message too large for this summary input omitted]"


@dataclass(frozen=True)
class SummaryPassOutcome:
    summary_text: str
    truncated: bool
    stripped_messages: int
    dropped_messages: int
    passes: int


def _request_row_limit(
    budget: TokenBudget,
    backend: TokenizerBackend,
    build_request: Callable[[list[dict[str, Any]]], list[dict[str, str]]],
) -> int:
    """Token limit for the rows of one request; the prompt and one retry reminder are reserved."""
    prompt_tokens = estimate_messages_tokens(
        [*build_request([]), {"role": "system", "content": COMPACTION_SUMMARY_RETRY_REMINDER}],
        backend,
    )
    return summary_input_limit(budget, prompt_tokens=prompt_tokens, backend=backend)


def _omit_row(
    rows: list[dict[str, Any]], counts: list[int], index: int, backend: TokenizerBackend
) -> None:
    rows[index] = {"role": "system", "content": OVERSIZED_ROW_MARKER}
    counts[index] = estimate_messages_tokens((rows[index],), backend)


def summarize_source_in_passes(  # noqa: PLR0913  # the three callables are the seam
    summary_source: list[dict[str, Any]],
    budget: TokenBudget,
    backend: TokenizerBackend,
    *,
    build_request: Callable[[list[dict[str, Any]]], list[dict[str, str]]],
    summarize: Callable[[list[dict[str, str]]], str],
    summary_row: Callable[[str], dict[str, Any]],
    pin_first: bool,
    clock: Callable[[], float] = time.monotonic,
) -> SummaryPassOutcome:
    """Summarise ``summary_source`` in as many passes as its size needs.

    ``build_request`` renders rows into a summariser request, ``summarize``
    runs one request (it raises on failure; the caller owns the breaker), and
    ``summary_row`` wraps a pass's text as the derived summary row the next
    pass re-folds. ``pin_first`` marks a leading prior summary, which seeds the
    running summary unless it alone exceeds half the limit.

    Raises ``ValueError`` when a pass's summary cannot be re-folded (larger
    than the input limit).
    """
    limit = _request_row_limit(budget, backend, build_request)
    source = strip_summary_source(summary_source, limit, backend)
    rows, counts = list(source.rows), list(source.token_counts)

    carry: dict[str, Any] | None = None
    carry_tokens = 0
    cursor = 0
    if pin_first and rows and counts[0] <= limit // 2:
        carry, carry_tokens, cursor = rows[0], counts[0], 1
    newest = len(rows) - 1

    # A row over the whole limit fits no request, with or without a summary.
    oversized = {index for index in range(cursor, newest) if counts[index] > limit}
    for index in oversized:
        _omit_row(rows, counts, index, backend)

    started = clock()
    dropped = 0
    folds = 0
    while True:
        end, used = cursor, carry_tokens
        while end < len(rows) and used + counts[end] <= limit:
            used += counts[end]
            end += 1
        head = [carry] if carry is not None else []
        if end == len(rows):
            final_rows = [*head, *rows[cursor:]]
            break
        if end == cursor and cursor < newest and counts[cursor] > limit // 2:
            # Too large to sit beside the running summary.
            _omit_row(rows, counts, cursor, backend)
            oversized.add(cursor)
            continue
        # One more fold needs its own pass and the final one, at the pace so far.
        elapsed = clock() - started
        projected = elapsed + 2 * (elapsed / folds) if folds else 0.0
        out_of_time = projected > SUMMARY_PASS_TIME_BUDGET_SECONDS
        # Folding markers alone would spend a pass on nothing.
        real_rows = end - cursor - len(oversized.intersection(range(cursor, end)))
        if real_rows == 0 or folds + 2 > MAX_SUMMARY_PASSES or out_of_time:
            # The running summary stays; the rows after it go oldest first.
            final_rows, cut = drop_oldest_rows(
                [*head, *rows[cursor:]],
                [*([carry_tokens] if head else []), *counts[cursor:]],
                limit,
                backend,
                keep=len(head),
            )
            # An omitted row that is cut here is counted once, below.
            dropped += cut - len(oversized.intersection(range(cursor, cursor + cut)))
            break
        carry = summary_row(summarize(build_request([*head, *rows[cursor:end]])))
        carry_tokens = estimate_messages_tokens((carry,), backend)
        if carry_tokens > limit:
            raise ValueError("Compaction summary exceeded size limit")
        cursor = end
        folds += 1

    dropped += len(oversized)
    if source.stripped_messages or dropped or folds:
        logger.info(
            "Summariser input admitted under the window limit.",
            extra={
                "data": {
                    "stripped_messages": source.stripped_messages,
                    "dropped_messages": dropped,
                    "passes": folds + 1,
                },
            },
        )
    return SummaryPassOutcome(
        summary_text=summarize(build_request(final_rows)),
        truncated=source.stripped_messages > 0 or dropped > 0,
        stripped_messages=source.stripped_messages,
        dropped_messages=dropped,
        passes=folds + 1,
    )
