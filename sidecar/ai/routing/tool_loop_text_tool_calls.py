"""Recover tool calls a model wrote as text on a leg that still offers tools.

Local servers turn Qwen markup into native calls only for the tools a request
offers, so a call to a deferred or budget-filtered tool comes back as content
and the turn used to end on the leaked markup (2026-10-15 resume: grep_search
was budget-filtered out). Recovered calls take the normal dispatch path: the
turn cap, approvals, and the deferred-tool "call tool_search first" outcome
all still apply. Legs with the tool cap spent stay with
``tool_loop_recovery._drop_text_tool_calls``.
"""

from __future__ import annotations

import json
import logging
from dataclasses import replace
from typing import Any
from uuid import uuid4

from sidecar.ai.routing.tool_loop_recovery import _tool_cap_spent

logger = logging.getLogger("sidecar.ai.routing.tool_loop")

_TEXT_CALL_RECOVERY_ENGINES = frozenset({"openai-compatible", "vllm", "ollama"})
_JSON_VALUE_TYPES = frozenset({"integer", "number", "boolean", "array", "object"})


def _typed_text_arguments(loop: Any, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Text values arrive as strings; decode the ones the schema types otherwise."""
    entry = loop.tool_contract.entry(name) if loop.tool_contract is not None else None
    schema = getattr(getattr(entry, "descriptor", None), "input_schema", None) or {}
    properties = schema.get("properties") if isinstance(schema, dict) else None
    typed: dict[str, Any] = {}
    for key, value in arguments.items():
        prop = properties.get(key) if isinstance(properties, dict) else None
        typed[key] = value
        json_typed = isinstance(prop, dict) and prop.get("type") in _JSON_VALUE_TYPES
        if isinstance(value, str) and json_typed:
            try:
                typed[key] = json.loads(value)
            except ValueError:
                pass  # Schema validation reports the bad value to the model.
    return typed


def recover_text_tool_calls(loop: Any, result: Any) -> Any:
    """Promote complete text-written calls to the turn's tools into native calls."""
    import sidecar.ai.routing.tool_loop as _tl_hub

    finish_reason = str(getattr(result, "finish_reason", "") or "").strip().lower()
    engine_type = str(loop.kernel._config.engine_type or "").strip().lower()
    if (
        result.tool_calls
        or finish_reason not in {"", "stop"}
        or engine_type not in _TEXT_CALL_RECOVERY_ENGINES
        or not loop.tool_payload
        or _tool_cap_spent(loop)
    ):
        return result
    names = _tl_hub.text_tool_calls.contract_tool_names(loop.tool_contract)
    prose, calls = _tl_hub.text_tool_calls.strip_text_tool_calls(str(result.content or ""), names)
    if not calls or not all(call.complete for call in calls):
        return result
    tool_calls = tuple(
        _tl_hub.ToolCallRequest(
            tool_id=call.name,
            arguments=_typed_text_arguments(loop, call.name, call.arguments),
            call_id=f"text_{call.name}_{uuid4().hex[:10]}",
        )
        for call in calls
    )
    _tl_hub.log_event(
        logger,
        logging.INFO,
        component="ai.router",
        event="ai.router.text_tool_call_recovered",
        message="Recovered a tool call the model wrote as text.",
        status="recovered",
        data={"tools": [call.name for call in calls], "shape": calls[0].shape},
        request_id=loop.request_id,
        session_id=loop.session_id,
    )
    # The markup already streamed: the live row keeps only the prose.
    _tl_hub.loop_event_emit.emit_stream_reset_for_retry(
        loop.runtime, loop.streamed_event_types, reason="deterministic_replacement"
    )
    if prose:
        _tl_hub._emit_deterministic_response_tokens(
            runtime=loop.runtime, streamed_event_types=loop.streamed_event_types,
            response_text=prose,
        )
    return replace(result, content=prose, tool_calls=tool_calls, finish_reason="tool_calls")
