"""Which calls of a frozen approval plan run when the approval resumes."""

from __future__ import annotations

from typing import Any

from sidecar.ai.tools.tool_actions import effective_side_effecting
from sidecar.runtime.approval_plan import ApprovalPlan
from sidecar.runtime.turn_retry import InnerRetryableTurnError


def _approval_resume_descriptor(
    *,
    kernel: Any,
    tool_contract: Any | None,
    call: Any,
) -> Any | None:
    entry_lookup = getattr(tool_contract, "entry", None)
    entry = entry_lookup(call.tool_id) if callable(entry_lookup) else None
    if entry is not None:
        return entry.descriptor
    mcp_client = getattr(kernel, "_mcp_client", None)
    descriptor_lookup = getattr(mcp_client, "tool_descriptor", None)
    if callable(descriptor_lookup):
        return descriptor_lookup(call.tool_id)
    return None


def _read_only_call(descriptor: Any | None, call: Any) -> bool:
    return descriptor is not None and not bool(
        effective_side_effecting(descriptor, getattr(call, "arguments", {}) or {})
    )


def _runs_without_approval(
    plan: ApprovalPlan,
    call: Any,
    *,
    kernel: Any,
    tool_contract: Any | None,
) -> bool:
    """True when the turn's full approval policy would run *call* unprompted.

    The same gate the paused iteration used: route mode, tool policy rules
    (deny and ASK), paranoid mode, auto-run and the live run mode. Anything it
    cannot evaluate keeps the call out of the window.
    """
    from sidecar.ai.mode_policy import policy_for_mode

    context = plan.request_context
    mode_policy = policy_for_mode(context.mode)
    execution = getattr(context, "execution_context", None)
    try:
        gate = {
            "mode": mode_policy.mode,
            "mode_allows_side_effecting": mode_policy.allow_side_effecting_tools,
            "resolution_context": plan.tool_resolution_context,
            "tool_contract": tool_contract,
            "plan_mode": context.plan_mode,
            "read_only": context.read_only,
            "request_disabled_tools": kernel._request_tool_set(
                context.tool_preferences, "disabled_tools"
            ),
        }
        policy = kernel._filter_tool_calls_by_policy(
            (call,),
            policy_snapshot=getattr(execution, "tool_policy_snapshot", None),
            **gate,
        )
        if policy.denied or tuple(policy.allowed) != (call,):
            return False
        approval = kernel._approval_if_needed(
            (call,),
            require_approval=mode_policy.require_approval_for_side_effecting,
            approvals_pre_granted=False,
            policy_decisions_by_call=policy.decisions_by_call,
            approval_mode=str(getattr(context, "approval_mode", "prompt")),
            **gate,
        )
    except Exception:  # noqa: BLE001 - fail closed: the call is re-issued instead.
        return False
    return approval is None


def _approval_resume_call_window(
    plan: ApprovalPlan,
    *,
    kernel: Any,
    tool_contract: Any | None,
    recheck_trailing: bool = False,
) -> tuple[tuple[Any, ...], tuple[Any, ...]]:
    """Return ``(selected, dropped)`` calls for the approved execution window.

    The window is every earlier read-only call plus the approved call. With
    ``recheck_trailing`` it also takes the read-only calls straight after the
    approved one that the turn's full approval policy would run without a
    prompt, stopping at the first that needs anything (approval, a side
    effect, a policy decision). The live-context check leaves it off: the
    gate counts auto-run approvals, so it runs once, at execution.

    ``dropped`` carries every plan call that this resume will NOT execute even
    though the whole batch was already reserved against the turn tool budget:
    earlier side-effecting calls, earlier calls with no descriptor, and the
    calls after the window. Callers must settle them explicitly -- a silent
    discard leaves the budget debited for work that never ran.
    """

    approved_call_id = str(plan.approved_call_id or plan.call_id or "").strip()
    selected: list[Any] = []
    dropped: list[Any] = []
    for index, call in enumerate(plan.tool_calls):
        call_id = str(getattr(call, "call_id", "") or "").strip()
        if approved_call_id and call_id == approved_call_id:
            selected.append(call)
            trailing = list(plan.tool_calls[index + 1 :])
            while recheck_trailing and trailing:
                descriptor = _approval_resume_descriptor(
                    kernel=kernel, tool_contract=tool_contract, call=trailing[0]
                )
                if not _read_only_call(descriptor, trailing[0]) or not _runs_without_approval(
                    plan, trailing[0], kernel=kernel, tool_contract=tool_contract
                ):
                    break
                selected.append(trailing.pop(0))
            dropped.extend(trailing)
            return tuple(selected), tuple(dropped)
        descriptor = _approval_resume_descriptor(
            kernel=kernel,
            tool_contract=tool_contract,
            call=call,
        )
        if _read_only_call(descriptor, call):
            selected.append(call)
        else:
            dropped.append(call)

    raise InnerRetryableTurnError(
        reason="Approved tool call is missing from the cached approval plan.",
        retry_prompt=(
            "The approved tool call is no longer present in the frozen tool plan. "
            "Re-evaluate the request and emit a fresh tool plan."
        ),
        terminal_subcode="approval_plan_drift",
        diagnostic_components=("approved_call",),
    )


def approved_call(plan: ApprovalPlan, selected: tuple[Any, ...]) -> Any | None:
    """The approved call among *selected* (no longer always the last one)."""

    approved_call_id = str(plan.approved_call_id or plan.call_id or "").strip()
    return next(
        (
            call
            for call in selected
            if str(getattr(call, "call_id", "") or "").strip() == approved_call_id
        ),
        None,
    )
