from __future__ import annotations

from sidecar.ai.routing.subagent_finalization import (
    SUB_AGENT_REPORT_MODE_PLAIN_TEXT,
    SUB_AGENT_REPORT_MODE_STRUCTURED,
    append_finalization_message,
    parse_structured_report,
    response_format,
    valid_response,
)
from sidecar.runtime.chat_models import ChatRequestContext


def _context(mode: str) -> ChatRequestContext:
    return ChatRequestContext(
        request_id="child",
        trace_id=None,
        session_id=None,
        mode="assist",
        approvals_pre_granted=False,
        agent_surface="sub_agent",
        sub_agent_report_mode=mode,
    )


def test_plain_text_finalization_accepts_nonblank_text_without_json_constraint() -> None:
    context = _context(SUB_AGENT_REPORT_MODE_PLAIN_TEXT)
    messages: list[dict[str, object]] = []

    append_finalization_message(messages, context)

    assert "plain-text" in str(messages[0]["content"])
    assert response_format(context) is None
    assert valid_response(context, "A concise answer.") is True
    assert valid_response(context, "   ") is False


def test_legacy_structured_finalization_contract_is_unchanged() -> None:
    context = _context(SUB_AGENT_REPORT_MODE_STRUCTURED)
    payload = '{"status":"completed","summary":"done","evidence":[],"uncertainties":[]}'

    assert response_format(context).type == "json_object"
    assert valid_response(context, payload) is True
    assert parse_structured_report(payload)["summary"] == "done"
    assert valid_response(context, "plain text") is False
