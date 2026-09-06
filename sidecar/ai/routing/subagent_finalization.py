"""Child-response finalization modes shared by legacy and V2 delegation."""

from __future__ import annotations

import json
from typing import Any

from sidecar.ai.engines.response_format import ResponseFormat
from sidecar.ai.utils.json_text import strip_fenced_json

SUB_AGENT_REPORT_MODE_STRUCTURED = "structured"
SUB_AGENT_REPORT_MODE_PLAIN_TEXT = "plain_text"

_STRUCTURED_FINALIZATION_MESSAGE = (
    "System status: this is the final in-budget sub-agent iteration. Do not call any "
    "more tools. Return exactly one compact JSON object with a nonblank `summary`, "
    "list-shaped `evidence` and `uncertainties`, and `status` set to `completed` or "
    "`partial`. Report only evidence already gathered and make remaining uncertainty explicit."
)
_PLAIN_TEXT_FINALIZATION_MESSAGE = (
    "System status: this is the final in-budget delegated iteration. Do not call any "
    "more tools. Return one concise, nonblank plain-text answer using only the evidence "
    "already gathered. Do not return JSON or another tool call."
)
_STRUCTURED_REPORT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["completed", "partial"]},
        "summary": {"type": "string", "minLength": 1},
        "evidence": {"type": "array"},
        "uncertainties": {"type": "array"},
    },
    "required": ["status", "summary", "evidence", "uncertainties"],
    "additionalProperties": False,
}


def report_mode(request_context: Any | None) -> str:
    value = str(getattr(request_context, "sub_agent_report_mode", "") or "").strip().lower()
    if value == SUB_AGENT_REPORT_MODE_PLAIN_TEXT:
        return SUB_AGENT_REPORT_MODE_PLAIN_TEXT
    return SUB_AGENT_REPORT_MODE_STRUCTURED


def append_finalization_message(
    messages: list[dict[str, object]],
    request_context: Any | None = None,
) -> None:
    message = (
        _PLAIN_TEXT_FINALIZATION_MESSAGE
        if report_mode(request_context) == SUB_AGENT_REPORT_MODE_PLAIN_TEXT
        else _STRUCTURED_FINALIZATION_MESSAGE
    )
    messages.append({"role": "system", "content": message})


def response_format(request_context: Any | None = None) -> ResponseFormat | None:
    if report_mode(request_context) == SUB_AGENT_REPORT_MODE_PLAIN_TEXT:
        return None
    return ResponseFormat(
        type="json_object",
        json_schema={
            **_STRUCTURED_REPORT_SCHEMA,
            "properties": {
                key: dict(value) for key, value in _STRUCTURED_REPORT_SCHEMA["properties"].items()
            },
        },
    )


def valid_response(request_context: Any | None, response_text: str) -> bool:
    if report_mode(request_context) == SUB_AGENT_REPORT_MODE_PLAIN_TEXT:
        return bool(str(response_text or "").strip())
    return bool(parse_structured_report(response_text))


def parse_structured_report(response_text: str) -> dict[str, Any]:
    stripped = strip_fenced_json(response_text)
    if not stripped:
        return {}
    try:
        parsed = json.loads(stripped)
    except (ValueError, RecursionError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    summary = parsed.get("summary")
    reported_status = parsed.get("status")
    valid = (
        isinstance(summary, str)
        and bool(summary.strip())
        and isinstance(parsed.get("evidence"), list)
        and isinstance(parsed.get("uncertainties"), list)
        and isinstance(reported_status, str)
        and reported_status.strip().lower() in {"completed", "partial"}
    )
    return parsed if valid else {}


__all__ = [
    "SUB_AGENT_REPORT_MODE_PLAIN_TEXT",
    "SUB_AGENT_REPORT_MODE_STRUCTURED",
    "append_finalization_message",
    "parse_structured_report",
    "report_mode",
    "response_format",
    "valid_response",
]
