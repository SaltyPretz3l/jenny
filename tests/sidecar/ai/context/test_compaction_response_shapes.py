"""F12: compaction replies from small local models that miss the canonical tags.

Each fixture is a literal reply shape a small model plausibly produces instead
of ``<summary>...</summary>`` (1.2.0 gate ledger, B5 attempt 2 / B1 attempt 5,
``summary_malformed``). The parser accepts a shape only when it still carries
the minimum number of mandated sections; short or sectionless replies stay
rejected and get one bounded re-ask inside ``compact_context``.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest

from sidecar.ai.context.compaction import (
    COMPACTION_SUMMARY_RETRY_REMINDER,
    CompactionCircuitBreaker,
    compact_context,
    parse_compaction_response,
)
from sidecar.ai.context.token_budget import TokenBudget

# -- (a) <summary> opened, never closed (output cap hit mid-summary) ---------

UNCLOSED_BOLD = (
    "<analysis>\nThe user is fixing a parser.\n</analysis>\n\n"
    "<summary>\n"
    "1. **Intent Summary** — Fix the compaction parser.\n"
    "2. **Key Technical Concepts** — Regex, fallbacks.\n"
    "3. **Relevant Files & Code** — sidecar/ai/context/compaction.py\n"
    "4. **Errors & Debugging** — KeyError in the pars"
)

UNCLOSED_MARKDOWN = (
    "<analysis>\nThe user discussed testing.\n</analysis>\n\n"
    "<summary>\n"
    "## 1. Intent Summary\nUser is building tests.\n"
    "## 2. Key Technical Concepts\nPytest, mocking.\n"
    "## 3. Relevant Files & Code\ntest_foo.py\n"
    "## 4. Errors & Debugging\n(none)\n"
    "## 5. Problem-Solving Approaches\nInline stu"
)

# -- (b) headings without the prompt's bold markup ---------------------------

MARKDOWN_HEADINGS = (
    "## Intent Summary\nUser is building tests.\n\n"
    "## Key Technical Concepts\nPytest.\n\n"
    "## Relevant Files and Code\ntest_foo.py\n\n"
    "## Next Step\nRun the suite.\n"
)

NUMBERED_PLAIN_HEADINGS = (
    "1. Intent Summary: User is building tests.\n"
    "2. Key Technical Concepts: Pytest.\n"
    "3. Relevant Files & Code: test_foo.py\n"
    "4. Errors & Debugging: (none)\n"
)

BOLD_COLON_LOWERCASE = (
    "**Intent summary:** User is building tests.\n"
    "**Key technical concepts:** Pytest.\n"
    "**Pending tasks:** Finish compaction tests.\n"
    "**Current work:** Writing compaction.py.\n"
)

# -- (c) fenced replies -------------------------------------------------------

WHOLE_REPLY_FENCED = (
    "```markdown\n"
    "1. **Intent Summary** — User is building tests.\n"
    "2. **Key Technical Concepts** — Pytest.\n"
    "3. **Relevant Files & Code** — test_foo.py\n"
    "```"
)

FENCED_MARKDOWN_HEADINGS = (
    "```\n"
    "### Intent Summary\nUser is building tests.\n"
    "### Pending Tasks\nFinish compaction tests.\n"
    "### Current Work\nWriting compaction.py.\n"
    "```"
)

SUMMARY_INSIDE_FENCE = (
    "```xml\n"
    "<summary>\n"
    "1. **Intent Summary** — User is building tests.\n"
    "</summary>\n"
    "```"
)

UNCLOSED_SUMMARY_INSIDE_FENCE = (
    "```\n"
    "<summary>\n"
    "## Intent Summary\nUser is building tests.\n"
    "## Pending Tasks\nFinish compaction tests.\n"
    "## Current Work\nWriting compaction.py.\n"
    "```"
)

# -- (d) analysis only, or a bare acknowledgement ----------------------------

ANALYSIS_ONLY = (
    "<analysis>\nThe user asked for nine codewords; six are collected so far.\n"
    "</analysis>"
)
ACKNOWLEDGEMENT = "Here is the summary:"
READY_REPLY = "Understood. Please share the conversation you want me to summarise."

# A draft summary written while thinking: analysis, never the reply
# (Astra review of the sweep's waves 2-3, P2).
_DRAFT_SECTIONS = (
    "**Intent Summary**\nPrivate draft.\n"
    "**Key Technical Concepts**\nPrivate draft.\n"
    "**Relevant Files & Code**\nPrivate draft.\n"
)
DRAFT_IN_ANALYSIS_UPPER = "<analysis><SUMMARY>" + _DRAFT_SECTIONS + "</SUMMARY></analysis>"
DRAFT_IN_ANALYSIS_LOWER = "<analysis><summary>" + _DRAFT_SECTIONS + "</summary></analysis>"
DRAFT_IN_UNCLOSED_ANALYSIS = "<analysis>\nThinking.\n<summary>" + _DRAFT_SECTIONS

# The same draft, then the real summary after the analysis closes.
DRAFT_THEN_REAL = (
    DRAFT_IN_ANALYSIS_LOWER
    + "\n<summary>\n"
    + "1. **Intent Summary** — Fix the compaction parser.\n"
    + "2. **Key Technical Concepts** — Regex.\n"
    + "3. **Relevant Files & Code** — compaction.py\n"
    + "</summary>"
)

# -- (e) tag variants ---------------------------------------------------------

UPPERCASE_TAGS = (
    "<SUMMARY>\n"
    "## Intent Summary\nUser is building tests.\n"
    "## Key Technical Concepts\nPytest.\n"
    "## Relevant Files & Code\ntest_foo.py\n"
    "</SUMMARY>"
)

SPACED_CLOSE_TAG = (
    "<summary>\n"
    "1. **Intent Summary** — User is building tests.\n"
    "2. **Key Technical Concepts** — Pytest.\n"
    "3. **Relevant Files & Code** — test_foo.py\n"
    "</ summary>"
)

SELF_CLOSING_AS_CLOSE = (
    "<summary>\n"
    "1. **Intent Summary** — User is building tests.\n"
    "2. **Key Technical Concepts** — Pytest.\n"
    "3. **Relevant Files & Code** — test_foo.py\n"
    "<summary/>"
)


_ACCEPTED_SHAPES = {
    "a_unclosed_bold": (UNCLOSED_BOLD, "Fix the compaction parser."),
    "a_unclosed_markdown": (UNCLOSED_MARKDOWN, "User is building tests."),
    "b_markdown_headings": (MARKDOWN_HEADINGS, "Run the suite."),
    "b_numbered_plain": (NUMBERED_PLAIN_HEADINGS, "test_foo.py"),
    "b_bold_colon_lowercase": (BOLD_COLON_LOWERCASE, "Writing compaction.py."),
    "c_whole_reply_fenced": (WHOLE_REPLY_FENCED, "Pytest."),
    "c_fenced_markdown": (FENCED_MARKDOWN_HEADINGS, "Writing compaction.py."),
    "c_summary_inside_fence": (SUMMARY_INSIDE_FENCE, "User is building tests."),
    "c_unclosed_summary_in_fence": (UNCLOSED_SUMMARY_INSIDE_FENCE, "Finish compaction"),
    "e_uppercase_tags": (UPPERCASE_TAGS, "test_foo.py"),
    "e_spaced_close_tag": (SPACED_CLOSE_TAG, "Pytest."),
    "e_self_closing_as_close": (SELF_CLOSING_AS_CLOSE, "test_foo.py"),
}


@pytest.mark.parametrize("shape", sorted(_ACCEPTED_SHAPES))
def test_structured_reply_without_canonical_tags_is_accepted_cleanly(shape: str) -> None:
    reply, expected_fragment = _ACCEPTED_SHAPES[shape]

    summary = parse_compaction_response(reply)

    assert expected_fragment in summary
    lowered = summary.lower()
    assert "summary>" not in lowered and "<summary" not in lowered
    assert "<analysis" not in lowered
    assert not summary.startswith("```") and not summary.endswith("```")


@pytest.mark.parametrize(
    "reply",
    [ANALYSIS_ONLY, ACKNOWLEDGEMENT, READY_REPLY],
    ids=["d_analysis_only", "d_acknowledgement", "d_ready_reply"],
)
def test_short_or_sectionless_reply_is_still_rejected(reply: str) -> None:
    with pytest.raises(ValueError, match="Missing <summary>"):
        parse_compaction_response(reply)


@pytest.mark.parametrize(
    "reply",
    [
        # Unclosed, two sections: below the minimum.
        "<summary>\n## Intent Summary\nx\n## Key Technical Concepts\ny",
        # Heading names used in prose, not as headings.
        "The intent summary is that the user wants tests. Key technical concepts "
        "include pytest. Relevant files & code: none. Pending tasks: none.",
        # Uppercase-tagged but sectionless.
        "<SUMMARY>Short note.</SUMMARY>",
        # Sections that exist only inside an unterminated analysis block.
        "<analysis>\n## Intent Summary\nx\n## Pending Tasks\ny\n## Current Work\nz",
    ],
    ids=["unclosed_two_sections", "prose_mentions", "upper_sectionless", "in_analysis"],
)
def test_lenient_paths_keep_the_section_minimum(reply: str) -> None:
    with pytest.raises(ValueError, match="Missing <summary>"):
        parse_compaction_response(reply)


@pytest.mark.parametrize(
    "reply",
    [DRAFT_IN_ANALYSIS_UPPER, DRAFT_IN_ANALYSIS_LOWER],
    ids=["draft_upper_tags", "draft_lower_tags"],
)
def test_draft_summary_inside_analysis_is_not_the_summary(reply: str) -> None:
    with pytest.raises(ValueError, match="Missing <summary>"):
        parse_compaction_response(reply)


def test_unclosed_analysis_still_yields_the_summary_that_follows() -> None:
    # The opener after an unterminated <analysis> is the reply, not thinking.
    summary = parse_compaction_response(DRAFT_IN_UNCLOSED_ANALYSIS)

    assert summary.startswith("**Intent Summary**")
    assert "Thinking." not in summary
    assert "<analysis" not in summary.lower()


def test_real_summary_after_a_drafted_analysis_wins() -> None:
    summary = parse_compaction_response(DRAFT_THEN_REAL)

    assert "Fix the compaction parser." in summary
    assert "Private draft." not in summary


# -- (d) bounded retry inside compact_context ---------------------------------

_GOOD_REPLY = (
    "<summary>\n"
    "1. **Intent Summary** — User is building tests.\n"
    "2. **Key Technical Concepts** — Pytest.\n"
    "3. **Relevant Files & Code** — test_foo.py\n"
    "</summary>"
)


def _messages() -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = [{"role": "user", "content": "Do something."}]
    for index in range(10):
        messages.append(
            {
                "role": "assistant",
                "content": f"Calling tool_{index}.",
                "tool_calls": [{"name": f"tool_{index}", "arguments": {}}],
            }
        )
        messages.append(
            {"role": "tool", "tool_call_id": f"call_{index}", "content": "x" * 800}
        )
    messages.append({"role": "assistant", "content": "Done."})
    messages.append({"role": "user", "content": "Continue."})
    return messages


def _budget() -> TokenBudget:
    return TokenBudget(context_window=2_000, max_output_tokens=200, reserved_for_summary=200)


class _ScriptedGenerator:
    def __init__(self, *replies: str) -> None:
        self._replies = list(replies)
        self.calls: list[list[dict[str, str]]] = []

    def __call__(self, messages: list[dict[str, str]]) -> str:
        self.calls.append([dict(message) for message in messages])
        return self._replies[min(len(self.calls), len(self._replies)) - 1]


def test_sectionless_reply_is_re_asked_once_with_a_terse_reminder(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger="sidecar.ai.context.compaction")
    generator = _ScriptedGenerator(READY_REPLY, _GOOD_REPLY)
    breaker = CompactionCircuitBreaker(max_failures=3)

    result = compact_context(
        _messages(), _budget(), generate_fn=generator, circuit_breaker=breaker
    )

    assert result.strategy == "full"
    assert result.summary_status == "created"
    assert len(generator.calls) == 2
    first, second = generator.calls
    assert second[:-1] == first
    assert second[-1] == {"role": "system", "content": COMPACTION_SUMMARY_RETRY_REMINDER}
    assert breaker.failure_count == 0
    retry_records = [
        record
        for record in caplog.records
        if getattr(record, "event", None) == "ai.context.compaction_summary_retry"
    ]
    assert len(retry_records) == 1
    assert READY_REPLY not in str(retry_records[0].__dict__)


def test_second_sectionless_reply_falls_back_with_one_breaker_failure(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger="sidecar.ai.context.compaction")
    generator = _ScriptedGenerator(ACKNOWLEDGEMENT, ANALYSIS_ONLY)
    breaker = CompactionCircuitBreaker(max_failures=2)

    result = compact_context(
        _messages(), _budget(), generate_fn=generator, circuit_breaker=breaker
    )

    assert result.strategy == "micro"
    assert result.summary_status == "failed"
    assert result.summary_failure_code == "summary_malformed"
    assert len(generator.calls) == 2
    assert breaker.failure_count == 1
    assert not breaker.is_open()

    failure = next(
        record
        for record in caplog.records
        if "Full compaction failed" in record.getMessage()
    )
    data = failure.data
    assert data["error_message"] == "Missing <summary> block in compaction response"
    assert data["response_chars"] == len(ANALYSIS_ONLY)
    assert data["has_analysis_open"] is True
    assert data["has_summary_open"] is False
    assert data["has_summary_close"] is False
    assert data["section_count"] == 0
    assert data["fenced"] is False
    assert data["retried"] is True
    for value in data.values():
        assert isinstance(value, (int, bool, type(None))) or value in {
            "summary_malformed",
            "ValueError",
            "Missing <summary> block in compaction response",
        }

    # A second double-failing attempt opens the breaker (one failure per
    # attempt, not per call); a third attempt makes no generate call.
    compact_context(_messages(), _budget(), generate_fn=generator, circuit_breaker=breaker)
    assert len(generator.calls) == 4
    assert breaker.is_open()
    third = compact_context(
        _messages(), _budget(), generate_fn=generator, circuit_breaker=breaker
    )
    assert len(generator.calls) == 4
    assert third.summary_failure_code == "summary_circuit_open"


def test_mid_turn_compaction_retries_once_too() -> None:
    messages: list[dict[str, Any]] = [{"role": "user", "content": "Read every file."}]
    for index in range(1, 11):
        call = {"id": f"call_{index}", "name": "read_file", "arguments": {"path": "f"}}
        messages.append({"role": "assistant", "content": "", "tool_calls": [call]})
        messages.append({"role": "tool", "tool_call_id": call["id"], "content": "x" * 800})
    generator = _ScriptedGenerator(ACKNOWLEDGEMENT, _GOOD_REPLY)

    result = compact_context(
        messages,
        _budget(),
        generate_fn=generator,
        circuit_breaker=CompactionCircuitBreaker(),
        mode="mid_turn",
    )

    assert result.strategy == "full"
    assert len(generator.calls) == 2
    assert generator.calls[1][-1]["content"] == COMPACTION_SUMMARY_RETRY_REMINDER


@pytest.mark.parametrize(
    ("reply", "expected_code"),
    [
        ("", "summary_malformed"),
        ("<summary>" + "z" * (257 * 1024) + "</summary>", "summary_oversized"),
    ],
    ids=["empty", "oversized"],
)
def test_empty_or_oversized_reply_is_not_retried(reply: str, expected_code: str) -> None:
    generator = _ScriptedGenerator(reply, _GOOD_REPLY)

    result = compact_context(
        _messages(), _budget(), generate_fn=generator, circuit_breaker=CompactionCircuitBreaker()
    )

    assert result.strategy == "micro"
    assert result.summary_failure_code == expected_code
    assert len(generator.calls) == 1


def test_generator_error_is_not_retried() -> None:
    calls: list[int] = []

    def failing(_messages: list[dict[str, str]]) -> str:
        calls.append(1)
        raise RuntimeError("provider down")

    breaker = CompactionCircuitBreaker()
    result = compact_context(
        _messages(), _budget(), generate_fn=failing, circuit_breaker=breaker
    )

    assert result.summary_failure_code == "summary_generation_failed"
    assert calls == [1]
    assert breaker.failure_count == 1
