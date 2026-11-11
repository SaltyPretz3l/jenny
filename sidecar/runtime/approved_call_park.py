"""Park a call the person approved when its resource turns out to be busy.

The checkpoint this publishes holds no consent. Electron, which owns consent,
keeps a one-use record of the answer in memory and hands it to the resumed
attempt, so the wait does not raise a second card. An app restart loses that
record and the resume asks again.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Callable, Sequence

from sidecar.ai.routing.tool_resource_deferral import ToolResourceDeferred
from sidecar.ai.routing.tool_resource_progress import resource_deferral_callback


def approved_call_deferral_callback(  # noqa: PLR0913 - one resumed request's owners, spelled out.
    plan: Any,
    *,
    runtime: Any,
    kernel: Any,
    request_context: Any,
    tool_contract: Any,
    outcomes: list[Any],
    change_set_id: str,
) -> Callable[[ToolResourceDeferred, Sequence[Any]], None]:
    """Build the dispatcher hook; only the approved call itself may park."""

    approved_call_id = str(plan.approved_call_id or plan.call_id or "").strip()
    loop = SimpleNamespace(
        runtime=runtime, kernel=kernel, request_context=request_context,
        tool_contract=tool_contract, outcomes=outcomes,
        iteration_total=int(runtime.iteration_base) + int(runtime.max_iterations),
        approvals_pre_granted=False, _jenny_change_set_id=change_set_id,
    )
    park = resource_deferral_callback(loop, runtime.current_iteration, allow_no_effects=True)

    def on_deferral(deferred: ToolResourceDeferred, calls: Sequence[Any]) -> None:
        if approved_call_id and str(calls[0].call_id or "").strip() == approved_call_id:
            park(deferred, tuple(calls))

    return on_deferral


__all__ = ["approved_call_deferral_callback"]
