"""Mid-stream tool-call announcement for the Ollama native tool stream.

While the model generates tool-call arguments the provider is silent; once a
call is fully parsed the stream announces it immediately (EngineEvent
``tool_call_completed``) instead of holding everything until ``done``, so the
timeline can name the tool early. The routing layer serializes it as the
canonical ``tool_call_requested`` turn event, and main dedupes it against the
later ``tool.executing`` for the same call id.
"""

from __future__ import annotations

from typing import Any

from sidecar.ai.config import read_environment_value
from sidecar.ai.engines.engine_events import (
    ENGINE_EVENT_TOOL_CALL_COMPLETED,
    EngineEvent,
)
from sidecar.ai.tools.models import ensure_tool_call_id


def _early_announce_enabled() -> bool:
    """Kill switch for the mid-stream announcement (default ON)."""
    return read_environment_value("JENNY_ENABLE_TOOL_CALL_EARLY_ANNOUNCE", "1") != "0"


def build_tool_call_announcement(
    tool_call: dict[str, Any],
    *,
    position: int,
    request_id: str | None,
) -> EngineEvent | None:
    """Build the announcement for one fully-parsed mid-stream tool call.

    The announced call id MUST equal the id the final ``GenerationResult``
    derives for the same call (identical provider/request_id/position
    derivation) — a mismatch would strand an orphaned "requested" tool row in
    the renderer. Arguments are surfaced display-only via plain dict coercion
    (no healing, which carries diagnostic side effects); the later
    ``tool.executing`` for the same call carries the authoritative input.
    Returns ``None`` when the kill switch is set.
    """
    if not _early_announce_enabled():
        return None
    raw_function = tool_call.get("function")
    function = raw_function if isinstance(raw_function, dict) else {}
    tool_name = str(function.get("name", ""))
    raw_arguments = function.get("arguments")
    return EngineEvent(
        kind=ENGINE_EVENT_TOOL_CALL_COMPLETED,
        tool_call_id=ensure_tool_call_id(
            tool_call.get("id"),
            provider="ollama",
            tool_name=tool_name,
            request_id=request_id,
            position=position,
        ),
        tool_name=tool_name,
        arguments=raw_arguments if isinstance(raw_arguments, dict) else {},
        sequence=position,
    )
