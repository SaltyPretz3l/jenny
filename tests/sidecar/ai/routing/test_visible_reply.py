"""The user-visible final reply is bounded by its own ceiling, not the tool-output cap.

Live gate 2026-10-05: a 22,830-character essay was cut to 16,000 characters with
a bare " [truncated]" marker because the final reply shared the bound meant for
tool output. The streamed tokens had already reached Electron whole, so the cut
was a pure display loss.
"""

from __future__ import annotations

import logging

from sidecar.ai.routing.harness_helpers import MAX_RESPONSE_CHARS
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.visible_reply import MAX_VISIBLE_REPLY_CHARS, finalize_visible_reply
from sidecar.ai.tools.models import GenerationResult
from sidecar.ai.tools.sanitization import VISIBLE_REPLY_CUT_FOOTER

from .test_tool_loop import _build_router, _ToolLoopEngine, _ToolPlan

_EVENT = "ai.router.response_truncated"


def _truncation_records(caplog) -> list[logging.LogRecord]:
    return [record for record in caplog.records if getattr(record, "event", None) == _EVENT]


def _run_final(content: str):
    engine = _ToolLoopEngine(
        plans=[_ToolPlan(result=GenerationResult(content=content, finish_reason="stop"))]
    )
    router = _build_router(engine=engine)
    return router.build_chat_decision(
        request_id="req_visible_reply",
        messages=[{"role": "user", "content": "Write the essay."}],
        latest_user_content="Write the essay.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(request_id="req_visible_reply", max_iterations=2),
    )


def test_visible_reply_ceiling_sits_far_above_the_tool_output_bound() -> None:
    assert MAX_VISIBLE_REPLY_CHARS == 262_144
    assert MAX_RESPONSE_CHARS == 16_000
    assert MAX_VISIBLE_REPLY_CHARS > MAX_RESPONSE_CHARS


def test_live_gate_reply_of_22830_chars_reaches_the_decision_intact(caplog) -> None:
    caplog.set_level(logging.INFO)
    paragraph = ("The quick brown fox jumps over the lazy dog. " * 10).strip()
    essay = "\n\n".join([paragraph] * 60)[:22_830].rstrip()
    assert len(essay) > MAX_RESPONSE_CHARS

    decision = _run_final(essay)

    assert decision.response_text == essay
    assert "[truncated]" not in decision.response_text
    assert decision.completion_source == "model"
    assert _truncation_records(caplog) == []


def test_reply_past_the_ceiling_is_cut_at_a_paragraph_with_honest_copy(caplog) -> None:
    caplog.set_level(logging.INFO)
    paragraph = ("Sentence number one is here. " * 8).strip()
    essay = "\n\n".join([paragraph] * (MAX_VISIBLE_REPLY_CHARS // len(paragraph) + 2))
    assert len(essay) > MAX_VISIBLE_REPLY_CHARS

    decision = _run_final(essay)

    text = decision.response_text
    assert text.endswith(VISIBLE_REPLY_CUT_FOOTER)
    body = text[: -len(VISIBLE_REPLY_CUT_FOOTER)]
    assert body.endswith(paragraph), "the cut lands on a paragraph break"
    assert len(body) <= MAX_VISIBLE_REPLY_CHARS
    assert "[truncated]" not in text
    (record,) = _truncation_records(caplog)
    assert record.data == {
        "original_length": len(essay),
        "truncated_to": MAX_VISIBLE_REPLY_CHARS,
        "kept_length": len(text),
    }


def test_finalize_visible_reply_logs_only_when_it_cuts(caplog) -> None:
    caplog.set_level(logging.INFO)

    kept = finalize_visible_reply("Fine.<|im_end|>junk", request_id="req_a", session_id="s_a")
    assert kept == "Fine."
    assert _truncation_records(caplog) == []

    cut = finalize_visible_reply("Alpha. " * 40, request_id="req_b", session_id="s_b", max_chars=100)
    assert cut.endswith(VISIBLE_REPLY_CUT_FOOTER)
    assert "[truncated]" not in cut
    (record,) = _truncation_records(caplog)
    assert record.request_id == "req_b"
    assert record.session_id == "s_b"
    assert record.data["truncated_to"] == 100
