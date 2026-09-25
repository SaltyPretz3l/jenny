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
from sidecar.ai.routing.tool_call_canonicalization import canonical_model_tool_id
from sidecar.ai.tools.contracts import ToolExecutionFailure, canonicalize_tool_arguments
from sidecar.ai.tools.models import ensure_tool_call_id
from sidecar.ai.tools.plan_artifact_policy import strip_plan_artifact_write_arg


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
    the renderer. The tool name and arguments are canonicalized as dispatch
    canonicalizes them (aliases, sidecar-only keys) but never healed, which
    carries diagnostic side effects; the later
    ``tool.executing`` for the same call carries the authoritative input.
    Returns ``None`` when the kill switch is set.
    """
    if not _early_announce_enabled():
        return None
    raw_function = tool_call.get("function")
    function = raw_function if isinstance(raw_function, dict) else {}
    tool_name = str(function.get("name", ""))
    raw_arguments = function.get("arguments")
    arguments = raw_arguments if isinstance(raw_arguments, dict) else {}
    # A pause at an approval proves the pending call against this event's
    # tool_input, so announce the call as dispatch will run it (gate A4 F6).
    canonical_name = canonical_model_tool_id(tool_name.strip())
    try:
        arguments, _aliases = canonicalize_tool_arguments(
            tool_name=canonical_name,
            arguments=strip_plan_artifact_write_arg(arguments),
        )
    except ToolExecutionFailure:
        pass  # conflicting aliases are rejected before any approval
    return EngineEvent(
        kind=ENGINE_EVENT_TOOL_CALL_COMPLETED,
        tool_call_id=ensure_tool_call_id(
            tool_call.get("id"),
            provider="ollama",
            tool_name=tool_name,
            request_id=request_id,
            position=position,
        ),
        tool_name=canonical_name,
        arguments=arguments,
        sequence=position,
    )
