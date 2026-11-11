"""Builtin MCP server ``tools/call`` outcome shaping: trace metadata, output unpacking."""

from __future__ import annotations

from typing import Any

from sidecar.ai.mcp.builtin_server_protocol import _safe_json_dumps
from sidecar.ai.mcp.circuit_breaker import record_breaker_outcome, record_success
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.phase_trace import PHASE_NAMES, PhaseTrace


def _traced_failure_data(
    *, tool_name: str, error: ToolExecutionFailure, trace: PhaseTrace, trace_id: str
) -> dict[str, str]:
    error_data = error.to_error_data()
    failed_phase = error_data.get("failed_phase") or trace.current_phase
    if failed_phase:
        record_breaker_outcome(tool_name, failed_phase, error, error_data)
        error_data.setdefault("failed_phase", failed_phase)
    error_data.setdefault("phase_timings_json", trace.phase_timings_json())
    if trace_id:
        error_data.setdefault("trace_id", trace_id)
    return error_data


def _add_success_trace_metadata(
    *,
    tool_name: str,
    metadata: dict[str, Any],
    trace: PhaseTrace,
    trace_id: str,
) -> None:
    metadata.setdefault("phase_timings_json", trace.phase_timings_json())
    if trace_id:
        metadata.setdefault("trace_id", trace_id)
    # The handler returned: the tool works even when its result reports a
    # failure (a non-zero exit), so the breaker closes either way (HB-015).
    for phase in PHASE_NAMES:
        record_success(tool_name, phase)


def _unpack_tool_output(
    output: object,
) -> tuple[str, bool, tuple[dict[str, Any], ...], str | None, dict[str, Any], tuple]:
    if not isinstance(output, ToolHandlerResult):
        text = _safe_json_dumps(output) if isinstance(output, (dict, list)) else str(output)
        return text, True, (), None, {}, ()
    return (
        output.output,
        output.success,
        output.generated_artifacts,
        output.error_code,
        dict(output.metadata),
        output.trusted_attachments,
    )


def _workspace_changed_evidence(output: object) -> bool | None:
    """A result's ``workspace_changed`` evidence, or ``None`` when it is unavailable."""
    metadata = getattr(output, "metadata", None)
    changed = metadata.get("workspace_changed") if isinstance(metadata, dict) else None
    return changed if isinstance(changed, bool) else None
