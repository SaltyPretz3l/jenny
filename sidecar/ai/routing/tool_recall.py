"""Read-only recall of original tool results retained for this request."""

from __future__ import annotations

from typing import Any

from sidecar.ai.context.compaction_micro import is_tool_placeholder
from sidecar.ai.error_codes import CMP_LOOP_INVALID_TOOL_CALL, CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.feature_flags import recall_tool_enabled

# More than the 1,024-row semantic history ceiling; retain the newest records.
MAX_RECALL_RESULTS = 4_096


def build_recall_history(
    canonical_session_messages: list[dict[str, object]] | None,
    messages: list[dict[str, object]] | None = None,
) -> dict[str, tuple[str, str, bool]]:
    """Index this request's original tool text, never a compacted stub.

    Desktop strips ``call_id``/``output_text`` from the canonical wire copy, so the
    request's own ``role: tool`` rows (full text until this request compacts them)
    fill the index; canonical text wins where both carry the same call.
    """
    history: dict[str, tuple[str, str, bool]] = {}
    for message in reversed(canonical_session_messages or []):
        result = message.get("tool_result") if isinstance(message, dict) else None
        if isinstance(result, dict):
            _remember(history, result.get("call_id"), result.get("output_text"), result)
    for message in reversed(messages or []):
        if isinstance(message, dict) and message.get("role") == "tool":
            content = message.get("content")
            if isinstance(content, str) and not is_tool_placeholder(content):
                _remember(history, message.get("tool_call_id"), content, message, "name")
    return history


def _remember(
    history: dict[str, tuple[str, str, bool]],
    call_id: object,
    output: object,
    row: dict[str, object],
    name_key: str = "tool_name",
) -> None:
    if len(history) >= MAX_RECALL_RESULTS or not isinstance(call_id, str) or not call_id:
        return
    if isinstance(output, str) and call_id not in history:
        history[call_id] = (output, str(row.get(name_key) or ""), row.get("is_error") is True)


def execute_recall_tool(  # noqa: PLR0913 -- uniform synthetic-handler dispatch
    *,
    kernel: Any,
    call: Any,
    tool_arguments: dict[str, object],
    visible_tool_arguments: dict[str, object],
    runtime: Any | None,
    outcome_type: Any,
    request_outcomes: tuple[Any, ...] | None = None,
    audit_metadata: dict[str, object] | None = None,
    **_unused: Any,
) -> Any:
    from sidecar.ai.routing import tool_execution as hub
    from sidecar.ai.routing import tool_execution_tool_handlers as handlers

    if not recall_tool_enabled(getattr(kernel, "_config", None)):
        reason = hub._tools_assembly.CONFIG_DISABLED_REASON
        return outcome_type(
            tool_name=call.tool_id,
            call_id=call.call_id,
            tool_input=visible_tool_arguments,
            success=False,
            output=hub.blocked_tool_message(call.tool_id, reason),
            error_code=hub.blocked_tool_error_code(reason),
            metadata=hub.blocked_tool_metadata(reason),
        )
    raw_id = tool_arguments.get("call_id")
    call_id = raw_id if isinstance(raw_id, str) else ""
    original = None
    source = "history"
    for outcome in reversed(request_outcomes or ()):
        if call_id and outcome.call_id == call_id:
            original = (outcome.output, outcome.tool_name, not outcome.success)
            source = "current_turn"
            break
    if original is None:
        original = getattr(runtime, "recall_history", {}).get(call_id)
    # Read-only either way; the derived-effects fallback cannot see this tool.
    metadata: dict[str, object] = {"effects": "none"}
    if original is None:
        output = (
            f"Cannot recall tool output {call_id!r}; "
            "only outputs from this conversation can be recalled."
        )
        error_code = (
            CMP_LOOP_INVALID_TOOL_CALL if not call_id.strip() else CMP_TOOL_EXECUTION_FAILED
        )
    else:
        output, tool_name, is_error = original
        metadata.update(
            {"recalled_call_id": call_id, "source": source, "original_tool": tool_name}
        )
        if is_error:
            metadata["original_is_error"] = True
        output, _truncated = hub.bounded_tool_output(output, tool_name=call.tool_id)
        error_code = None
    handlers.audit_settled(
        runtime, call, call.tool_id, succeeded=original is not None, error_code=error_code,
        summary=f"tool_recall {'found' if original is not None else 'missing'}",
    )
    return outcome_type(
        tool_name=call.tool_id,
        call_id=call.call_id,
        tool_input=visible_tool_arguments,
        output=output,
        success=original is not None,
        error_code=error_code,
        metadata=hub._merge_result_metadata(metadata, audit_metadata),
    )
