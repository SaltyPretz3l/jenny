"""Output-limit rejection and bounded retries for compaction replies."""

import logging
from unittest.mock import Mock

import pytest

from sidecar.ai.context.compaction import _SummaryAttempt, parse_compaction_response
from sidecar.ai.context.compaction_prompts import (
    COMPACTION_SUMMARY_SECTION_HEADINGS,
    CompactionReply,
)

_BODY = "\n".join(f"{heading}\n(none)" for heading in COMPACTION_SUMMARY_SECTION_HEADINGS)
_COMPLETE = f"<summary>\n{_BODY}\n</summary>"
_PARTIAL = "<summary>\n" + "\n".join(
    f"{heading}\n(none)" for heading in COMPACTION_SUMMARY_SECTION_HEADINGS[:4]
)
_REMINDER = (
    "Your previous summary was cut off. Reply again with the complete <summary> block, "
    "keeping every section but at most half as long."
)


@pytest.mark.parametrize(
    "first,reason",
    [(_COMPLETE, "length"), (_PARTIAL, "stop"), (_PARTIAL + "\n</summary>", "stop")],
    ids=["closed-length", "unclosed-stop", "closed-missing-final-section"],
)
def test_truncated_reply_retries_with_shorter_complete_summary(
    first: str, reason: str, caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger="sidecar.ai.context.compaction")
    generate = Mock(side_effect=[
        CompactionReply(first, finish_reason=reason), CompactionReply(_COMPLETE, finish_reason="stop"),
    ])
    messages = [{"role": "user", "content": "Summarize this conversation."}]

    assert _SummaryAttempt().summarize(generate, messages) == _BODY

    assert generate.call_count == 2
    assert generate.call_args_list[0].args[0] == messages
    assert generate.call_args_list[1].args[0] == [
        *messages, {"role": "user", "content": _REMINDER},
    ]
    retry = [
        record for record in caplog.records
        if getattr(record, "event", None) == "ai.context.compaction_summary_retry"
    ]
    assert len(retry) == 1
    assert retry[0].data["reason"] == "truncated"


def test_plain_string_preserves_partial_summary_recovery() -> None:
    generate = Mock(return_value=_PARTIAL)
    assert _SummaryAttempt().summarize(generate, []) == _PARTIAL.removeprefix("<summary>\n")
    generate.assert_called_once_with([])


@pytest.mark.parametrize("heading", ["**Next Step**", "## next step", "9. Next-Step:"])
def test_unclosed_complete_reply_accepts_final_section_heading_variants(heading: str) -> None:
    reply = CompactionReply(
        "<summary>\n" + _BODY.replace("**Next Step**", heading), finish_reason="stop",
    )
    assert parse_compaction_response(reply) == _BODY.replace("**Next Step**", heading)


@pytest.mark.parametrize(
    "text,reason,error",
    [
        (_COMPLETE, "length", "Compaction summary was cut off by the output limit"),
        (_PARTIAL, "length", "Compaction summary was cut off by the output limit"),
        (_PARTIAL, "stop", "Compaction summary is missing its final section"),
    ],
    ids=["closed-length", "unclosed-length", "unclosed-stop"],
)
def test_two_rejected_replies_propagate_value_error(text: str, reason: str, error: str) -> None:
    generate = Mock(return_value=CompactionReply(text, finish_reason=reason))
    with pytest.raises(ValueError, match=f"^{error}$"):
        _SummaryAttempt().summarize(generate, [])
    assert generate.call_count == 2


@pytest.mark.parametrize("finish_reason", ["stop", None])
def test_next_step_mentioned_in_prose_does_not_count_as_final_heading(
    finish_reason: str | None,
) -> None:
    reply = CompactionReply(
        _PARTIAL + "\nThe Next Step is still to run tests.", finish_reason=finish_reason,
    )
    with pytest.raises(ValueError, match="^Compaction summary is missing its final section$"):
        parse_compaction_response(reply)
