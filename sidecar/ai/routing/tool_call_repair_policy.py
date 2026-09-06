"""Structural tool-argument repair policy (Wave 8 of the python_execute program).

The healing net (``sidecar.ai.tools.tool_call_healing``) can close an
unterminated string or an unclosed object the model never finished, and the
healed dict used to be dispatched as if the model had sent it. For a read-only
tool a truncated argument fails harmlessly; for a tool that changes files or
runs commands it silently executes something the model did not compose -- a
cut path, a shortened shell argument. This module decides, per call, which of
those two cases a structurally healed batch member is in.

Only ``closed_string`` / ``closed_brace`` count: they append structure and can
change the payload's meaning. Every other repair tag (stripped fences, smart
quotes, trailing commas, ...) changes spelling only and is left alone. The vLLM
path never heals, so nothing here loosens its strict rejection.
"""

from __future__ import annotations

import logging
from typing import Any

from sidecar.ai.error_codes import CMP_LOOP_INVALID_TOOL_CALL
from sidecar.ai.routing.tool_loop_recovery import record_failed_tool_calls
from sidecar.ai.tools.tool_actions import effective_side_effecting
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger("sidecar.ai.routing.tool_loop")

STRUCTURAL_ARGUMENT_REPAIRS = frozenset({"closed_string", "closed_brace"})


def _provably_read_only(loop: Any, call: Any) -> bool:
    """True only when the descriptor declares the call's action non-side-effecting.

    An unknown descriptor (``None``) is not provably read-only: fail closed.
    """
    descriptor = loop.kernel._mcp_client.tool_descriptor(call.tool_id)
    return effective_side_effecting(descriptor, call.arguments) is False


def partition_structurally_repaired_calls(
    loop: Any,
    calls: tuple[Any, ...],
) -> tuple[tuple[Any, ...], tuple[Any, ...]]:
    """Split ``calls`` into (dispatchable, repair-rejected), order preserved."""
    rejected = tuple(
        call
        for call in calls
        if set(getattr(call, "argument_repairs", ())) & STRUCTURAL_ARGUMENT_REPAIRS
        and not _provably_read_only(loop, call)
    )
    if not rejected:
        return calls, ()
    return tuple(call for call in calls if call not in rejected), rejected


def reject_structurally_repaired_calls(
    loop: Any,
    result: Any,
    calls: tuple[Any, ...],
) -> None:
    """Record each repair-rejected call as a per-call ``CMP-LOOP-0002`` failure.

    Same seam and same code as ``reject_malformed_argument_calls`` so the model
    sees "that one call was invalid, retry it" while its siblings still run.
    No-op on an empty tuple so the caller needs no branch.
    """
    if not calls:
        return
    log_event(
        logger,
        logging.WARNING,
        component="ai.router",
        event="ai.router.tool_call_structural_repair_rejected",
        message="Rejected tool calls whose truncated arguments were auto-closed.",
        status="blocked",
        data={
            "blocked_count": len(calls),
            "tools": [call.tool_id for call in calls],
            "repairs": {call.tool_id: list(call.argument_repairs) for call in calls},
        },
        request_id=loop.request_id,
        session_id=loop.session_id,
    )
    for call in calls:
        record_failed_tool_calls(
            loop,
            result,
            (call,),
            error_code=CMP_LOOP_INVALID_TOOL_CALL,
            output_for_call=lambda blocked_call: (
                f"Tool '{blocked_call.tool_id}' was not executed: its arguments arrived "
                "truncated (an unterminated string or unclosed object had to be auto-closed) "
                "and this tool can change files or run commands, so the repaired version was "
                "not run. Re-send the call with complete, valid JSON arguments."
            ),
            metadata={
                "malformed_arguments": True,
                "structural_repair_rejected": True,
                "argument_repairs": list(call.argument_repairs),
            },
        )
