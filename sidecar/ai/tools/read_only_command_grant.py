"""Row 102: the sidecar half of "read-only commands run without asking".

A ``run_command`` call is a *read-only command* when the ``read_only_commands`` flag is on,
the tool is the sidecar builtin ``run_command`` (never the Electron bridge or a hosted
worker), and the shell classifier verdict -- after the out-of-root escalation, for the
request's bound root -- is ``ALLOWED``.  The approval gate passes its classification in, so
this module duplicates no classifier logic.

The approval gate skips the card for such a call unless the safety mode is ``paranoid`` or a
user rule or stored per-tool policy matched (:func:`approval_grant_applies`).  Electron makes
the same decision from the ``grant`` key on the runtime.operation check; its trust basis is
the one the Auto run grant already has: the sidecar applies the classifier and the mandatory
gates, Electron owns the consent posture (flag, user rules, stored policies).
"""

from __future__ import annotations

import re
from typing import Any

from sidecar.ai.execution_policy import BUILTIN_MCP_SERVER_NAME
from sidecar.ai.feature_flags import read_only_commands_enabled
from sidecar.ai.tools.builtins.shell_security import CommandVerdict
from sidecar.ai.tools.policy import (
    LEGACY_POLICY_REASON_PREFIX,
    POLICY_DECISION_ASK,
    POLICY_DECISION_AUTO,
)
from sidecar.protocol import RUNTIME_OPERATION_READ_ONLY_COMMAND_GRANT as READ_ONLY_COMMAND_GRANT

# What command_proposal_request refuses: characters that render invisibly or reorder displayed
# text. A command carrying one always reaches the card, which shows them as visible markers.
_DISGUISING_CHARS_RE = re.compile(
    "[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e"
    "\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]"
)

READ_ONLY_COMMAND_REFUSAL = (
    "Only read-only commands run in this mode (such as git log, git diff, rg, dir or ls "
    "inside the project). This command can change files or run programs, so it needs Ask "
    "or Auto mode."
)


def is_candidate(config: Any, descriptor: Any) -> bool:
    """The builtin ``run_command`` (not the Electron bridge's twin) while the feature is on."""
    return (
        getattr(descriptor, "name", None) == "run_command"
        and getattr(descriptor, "server_name", None) == BUILTIN_MCP_SERVER_NAME
        and read_only_commands_enabled(config)
    )


def is_read_only_command(config: Any, descriptor: Any, classification: Any) -> bool:
    """Whether this call qualifies; ``classification`` is the root-scoped shell verdict."""
    return (
        getattr(classification, "verdict", None) is CommandVerdict.ALLOWED
        and not _is_disguised(classification)
        and is_candidate(config, descriptor)
    )


def _is_disguised(classification: Any) -> bool:
    return bool(_DISGUISING_CHARS_RE.search(str(getattr(classification, "raw_command", "") or "")))


def candidate_classification(
    kernel: Any, call: Any, descriptor: Any, execution_context: Any | None
) -> Any | None:
    """The root-scoped shell classification of a candidate call, else ``None`` (not classified).

    The classifier lives in the routing hub (tests patch its seams there), which imports this
    module, so it is resolved lazily.
    """
    if not is_candidate(getattr(kernel, "_config", None), descriptor):
        return None
    from sidecar.ai.routing.tool_execution import classify_run_command_for_approval

    return classify_run_command_for_approval(
        kernel, call, descriptor_name=descriptor.name, execution_context=execution_context
    )


def read_only_command_verdict(
    kernel: Any, call: Any, descriptor: Any, runtime: Any
) -> CommandVerdict | None:
    """:func:`candidate_classification`'s verdict for the runtime's request root."""
    context = getattr(getattr(runtime, "request_context", None), "execution_context", None)
    classification = candidate_classification(kernel, call, descriptor, context)
    if _is_disguised(classification):
        return CommandVerdict.NEEDS_APPROVAL
    return getattr(classification, "verdict", None)


def is_allowed_verdict(verdict: CommandVerdict | None) -> bool:
    return verdict is CommandVerdict.ALLOWED


def read_only_grant(kernel: Any, call: Any, descriptor: Any, runtime: Any) -> str | None:
    """The ``grant`` value for the runtime.operation check, or ``None`` to omit the key."""
    if is_allowed_verdict(read_only_command_verdict(kernel, call, descriptor, runtime)):
        return READ_ONLY_COMMAND_GRANT
    return None


def read_only_command_refusal(verdict: CommandVerdict | None) -> str | None:
    """The read-only-mode refusal for a candidate the classifier sent to approval."""
    return READ_ONLY_COMMAND_REFUSAL if verdict is CommandVerdict.NEEDS_APPROVAL else None


def approval_grant_applies(policy_decision: Any, *, paranoid: bool) -> bool:
    """Whether the policy leaves room for the grant: none, AUTO, or the untouched tool default.

    A user rule (``user_ask``/``user_deny``), a stored per-tool policy, a hard safety deny and
    paranoid mode always win.
    """
    if paranoid:
        return False
    if policy_decision is None:
        return True
    decision = getattr(policy_decision, "decision", None)
    if decision == POLICY_DECISION_AUTO:
        return True
    return (
        decision == POLICY_DECISION_ASK
        and getattr(policy_decision, "stage", None) == "tool_default"
        and getattr(policy_decision, "matched_rule_id", None) is None
        and not str(getattr(policy_decision, "reason", "")).startswith(LEGACY_POLICY_REASON_PREFIX)
    )


__all__ = [
    "READ_ONLY_COMMAND_GRANT",
    "READ_ONLY_COMMAND_REFUSAL",
    "approval_grant_applies",
    "candidate_classification",
    "is_allowed_verdict",
    "is_candidate",
    "is_read_only_command",
    "read_only_command_refusal",
    "read_only_command_verdict",
    "read_only_grant",
]
