"""Model-facing preparation of historical tool-result rows (W1 §1.6).

Runs ONCE per lane, BEFORE semantic admission, so both lanes budget the same
representation they will actually send (framing counts when it renders, and
never counts when it does not):

- Flag OFF: strip the W1 wire fields Electron now always forwards
  (`tool_envelope`, and the `name` it never sent pre-W1) so the model-facing
  bytes, the engine request, and the admission byte-costs stay identical to
  pre-W1 behavior.
- Flag ON: replace each tool row's content with the shared envelope rendering
  built from the forwarded fields. Never sniffs content to decide (a forgery
  vector); embedded framing is neutralized by the renderer instead.
"""

from __future__ import annotations

from typing import Any

from sidecar.ai.context.message_utils import admit_tool_envelope
from sidecar.ai.tools.result_envelope import render_tool_result_envelope


_W1_WIRE_FIELDS = ("tool_envelope", "name", "is_error", "error_code")


def _string_field(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def reframe_tool_history_messages(
    messages: list[dict[str, object]],
    *,
    config: Any,
) -> list[dict[str, object]]:
    """Prepare tool rows for the model; pure, order-preserving, never raises per-row surprises."""
    enabled = getattr(config, "tool_result_envelope_enabled", False) is True

    prepared: list[dict[str, object]] = []
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "tool":
            prepared.append(message)
            continue

        if not enabled:
            # Pre-W1 the converter sent none of these four keys; the live lane
            # serializes rows verbatim onto the engine wire, so every one must
            # go for flag-off byte parity (`is_error`/`error_code` acceptance
            # existed pre-W1 but no real client exercised it).
            if any(key in message for key in _W1_WIRE_FIELDS):
                stripped = dict(message)
                for key in _W1_WIRE_FIELDS:
                    stripped.pop(key, None)
                prepared.append(stripped)
            else:
                prepared.append(message)
            continue

        envelope = admit_tool_envelope(message.get("tool_envelope")) or {}
        row = dict(message)
        # Post-framing the wire fields are redundant (the content carries the
        # envelope) and the live lane would serialize them verbatim to the
        # engine HTTP body; drop all but `name`, which engines accept.
        for key in ("tool_envelope", "is_error", "error_code"):
            row.pop(key, None)
        row["content"] = render_tool_result_envelope(
            tool_id=str(message.get("name") or ""),
            call_id=str(message.get("tool_call_id") or ""),
            ok=message.get("is_error") is not True,
            output_text=message.get("content") or "",
            failure_class=_string_field(envelope.get("failure_class")),
            error_code=_string_field(message.get("error_code")),
            effects=_string_field(envelope.get("effects")),
            failed_phase=_string_field(envelope.get("failed_phase")),
            elapsed_ms=envelope.get("elapsed_ms"),  # type: ignore[arg-type]
            trace=_string_field(envelope.get("trace_id")),
            detail=_string_field(envelope.get("detail")),
            remediation=_string_field(envelope.get("remediation")),
        )
        prepared.append(row)
    return prepared
