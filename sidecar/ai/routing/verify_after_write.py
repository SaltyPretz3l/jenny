"""The first ``verify`` run after a workspace write asks once (security review item 7).

``verify`` defaults to auto because the model only picks WHICH saved Workspace Test
Runner configuration runs. After a workspace write in the same turn, though, that run
executes code the model just wrote with no ``run_command``-level approval. So the
tool loop escalates the untouched built-in default to ask for the first ``verify``
run after each write; once that run has executed, later runs stay auto until the
next write re-arms it.

The state is derived from the turn's own outcomes (request-local: an approval
resume carries them in its plan), so the router stays stateless. A pending call
earlier in the same batch that may write arms the check too, before it has run.
Writes use the undo set's mutation vocabulary (``verification_gate``), not a new
list. Only the policy layer's untouched default escalates
(:func:`sidecar.ai.tools.policy.escalate_verify_after_write`): a user rule, a
stored per-tool policy or a one-send auto-run grant keeps its precedence.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import replace
from typing import Any

from sidecar.ai.routing.mutation_change_set_lifecycle import (
    SCRIPTED_MUTATION_TOOLS,
    TYPED_MUTATION_TOOLS,
)
from sidecar.ai.routing.verification_gate import GATE_TOOL_NAME, workspace_was_mutated
from sidecar.ai.tools.policy import (
    ToolPolicyFilterResult,
    escalate_verify_after_write,
    tool_policy_call_key,
)
from sidecar.ai.tools.tool_actions import effective_side_effecting

__all__ = ("armed_by_outcomes", "escalate_after_writes")

# Before it runs, a command or script may write: it arms the check (fail closed).
_PENDING_WRITE_TOOLS = TYPED_MUTATION_TOOLS | SCRIPTED_MUTATION_TOOLS


def _descriptor(tool_contract: Any | None, tool_name: str) -> Any | None:
    entry_lookup = getattr(tool_contract, "entry", None)
    entry = entry_lookup(tool_name) if callable(entry_lookup) else None
    return getattr(entry, "descriptor", None)


def _is_verify_run(descriptor: Any | None, tool_name: str, arguments: object) -> bool:
    """A ``verify`` call whose action can run tests (``list`` is read-only)."""
    name = str(getattr(descriptor, "name", "") or tool_name)
    if name != GATE_TOOL_NAME:
        return False
    args = arguments if isinstance(arguments, dict) else {}
    return effective_side_effecting(descriptor, args) is not False


def armed_by_outcomes(outcomes: Iterable[Any], *, tool_contract: Any | None) -> bool:
    """True when a workspace write is newer than the turn's last executed ``verify`` run."""
    armed = False
    for outcome in outcomes:
        name = str(getattr(outcome, "tool_name", "") or "")
        if workspace_was_mutated((outcome,)):
            armed = True
        elif (
            armed
            and getattr(outcome, "success", False) is True
            and _is_verify_run(
                _descriptor(tool_contract, name), name, getattr(outcome, "tool_input", None)
            )
        ):
            # The approved run executed; a denied or refused run left no success.
            armed = False
    return armed


def escalate_after_writes(
    policy_filter: ToolPolicyFilterResult,
    *,
    outcomes: Iterable[Any],
    tool_contract: Any | None,
) -> ToolPolicyFilterResult:
    """Escalate the allowed ``verify`` runs that follow a write in this turn."""
    armed = armed_by_outcomes(outcomes, tool_contract=tool_contract)
    decisions = dict(policy_filter.decisions_by_call)
    audit = dict(policy_filter.audit_metadata_by_call)
    changed = False
    for call in policy_filter.allowed:
        tool_name = str(call.tool_id or "")
        descriptor = _descriptor(tool_contract, tool_name)
        key = tool_policy_call_key(call)
        decision = decisions.get(key)
        if armed and decision is not None and _is_verify_run(descriptor, tool_name, call.arguments):
            escalated = escalate_verify_after_write(decision)
            if escalated is not decision:
                decisions[key] = escalated
                audit[key] = {**audit.get(key, {}), "policy_decision": escalated.to_metadata()}
                changed = True
        if str(getattr(descriptor, "name", "") or tool_name) in _PENDING_WRITE_TOOLS:
            armed = True
    if not changed:
        return policy_filter
    return replace(policy_filter, decisions_by_call=decisions, audit_metadata_by_call=audit)
