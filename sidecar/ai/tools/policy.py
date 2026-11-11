"""Policy checks that gate tool execution."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, replace
from typing import Any

from sidecar.ai.config import (
    ToolPolicySnapshot,
    _normalize_tool_policy_snapshot,
)
from sidecar.ai.error_codes import (
    CMP_LOOP_INVALID_TOOL_CALL,
    CMP_MODE_TOOL_BLOCKED,
    CMP_TOOL_COMMAND_BLOCKED,
    CMP_TOOL_DISABLED,
    CMP_TOOL_POLICY_DENIED,
)
from sidecar.ai.feature_flags import FEATURE_SHELL_SECURITY, is_feature_flag_enabled
from sidecar.ai.tools.approval_presentation import (  # noqa: F401  (re-export: fan-out cap)
    approval_presentation_for_call,  # route_policy_runtime calls it through this module
)
from sidecar.ai.tools.builtins.shell_security import (
    CommandVerdict,
    classify_command,
    shell_command_for_tool,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure, canonicalize_tool_arguments
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.plan_artifact_policy import (
    is_plan_artifact_write_eligible,
    is_safe_plan_document,
)
from sidecar.ai.tools.policy_rules import (
    _DEFAULT_TOOL_DEFAULTS,
    _RULE_HIT_STAGE,
    POLICY_DECISION_ASK,
    POLICY_DECISION_AUTO,
    POLICY_DECISION_DENY,
    _descriptor_family,
    _descriptor_name,
    _descriptor_source_kind,
    _first_rule_hit,
    _legacy_policy_for_descriptor,
)
from sidecar.ai.tools.sanitization import sanitize_tool_output, scan_tool_arguments
from sidecar.ai.tools.tool_actions import declared_action, effective_side_effecting

_MAX_POLICY_REASON_CHARS = 240
# A stored v1 per-tool policy reads as a tool default; row 102 must tell it apart.
LEGACY_POLICY_REASON_PREFIX = "legacy per-tool policy:"
_MAX_POLICY_ID_CHARS = 80


@dataclass(frozen=True)
class ToolPolicyDecision:
    decision: str
    stage: str
    matched_rule_id: str | None
    reason: str
    snapshot_version: int
    tool_name: str
    tool_family: str
    source_kind: str
    mode: str
    action: str = ""

    @property
    def id(self) -> str:
        parts = [
            str(self.snapshot_version),
            self.tool_name,
            self.tool_family,
            self.source_kind,
            self.mode,
            self.decision,
            self.stage,
            self.matched_rule_id or "",
            self.reason,
        ]
        if self.action:
            parts.append(self.action)
        payload = "|".join(parts)
        return "policy_" + hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]

    def to_metadata(self) -> dict[str, object]:
        metadata: dict[str, object] = {
            "id": self.id,
            "decision": self.decision,
            "stage": self.stage,
            "matched_rule_id": _bounded_policy_text(
                self.matched_rule_id,
                limit=_MAX_POLICY_ID_CHARS,
                fallback="",
            )
            or None,
            "reason": _bounded_reason(self.reason),
            "snapshot_version": self.snapshot_version,
            "tool_name": self.tool_name,
            "tool_family": self.tool_family,
            "source_kind": self.source_kind,
            "mode": self.mode,
        }
        if self.action:
            metadata["action"] = self.action
        return metadata


@dataclass(frozen=True)
class PolicyDeniedToolCall:
    call: ToolCallRequest
    decision: ToolPolicyDecision
    metadata: dict[str, object]
    # Accurate failure code for the recorded outcome. User policy denies keep
    # the default; hard blocks (shell disabled, mode gate, security
    # classifier, argument-scan rejections) carry their own code so the model
    # and the logs see the real reason instead of a generic policy denial.
    error_code: str = CMP_TOOL_POLICY_DENIED


@dataclass(frozen=True)
class ToolPolicyFilterResult:
    allowed: tuple[ToolCallRequest, ...]
    denied: tuple[PolicyDeniedToolCall, ...]
    decisions_by_call: dict[str, ToolPolicyDecision]
    audit_metadata_by_call: dict[str, dict[str, object]]


@dataclass(frozen=True)
class ToolPolicyFilterContext:
    mode: str
    mode_allows_side_effecting: bool
    resolution_context: Any | None
    tool_contract: Any | None = None
    plan_mode: bool = False
    read_only: bool = False
    request_disabled_tools: frozenset[str] = frozenset()
    policy_snapshot: Any | None = None


@dataclass(frozen=True)
class _DecisionDetails:
    decision: str
    stage: str
    matched_rule_id: str | None
    reason: str
    mode: str


def _bounded_reason(reason: str) -> str:
    return _bounded_policy_text(
        reason,
        limit=_MAX_POLICY_REASON_CHARS,
        fallback="Tool policy matched",
    )


def _bounded_policy_text(value: str | None, *, limit: int, fallback: str) -> str:
    sanitized = sanitize_tool_output(
        value or fallback,
        max_chars=limit,
        tool_name="tool_policy",
    ).strip()
    return sanitized or fallback


def _coerce_snapshot(snapshot: ToolPolicySnapshot | dict[str, Any] | None) -> ToolPolicySnapshot:
    if isinstance(snapshot, ToolPolicySnapshot):
        return snapshot
    if isinstance(snapshot, dict):
        normalized = _normalize_tool_policy_snapshot(snapshot)
        if normalized is not None:
            return normalized
    return ToolPolicySnapshot.empty()


def _decision(
    descriptor: Any,
    snapshot: ToolPolicySnapshot,
    details: _DecisionDetails,
    *,
    action: str = "",
) -> ToolPolicyDecision:
    return ToolPolicyDecision(
        decision=details.decision,
        stage=details.stage,
        matched_rule_id=details.matched_rule_id,
        reason=_bounded_reason(details.reason),
        snapshot_version=snapshot.version,
        tool_name=_descriptor_name(descriptor),
        tool_family=_descriptor_family(descriptor),
        source_kind=_descriptor_source_kind(descriptor),
        mode=str(details.mode or ""),
        action=action,
    )


def evaluate_tool_policy(  # noqa: PLR0911 - explicit ordered policy precedence.
    *,
    descriptor: Any,
    arguments: dict[str, Any],
    mode: str,
    snapshot: ToolPolicySnapshot | dict[str, Any] | None,
) -> ToolPolicyDecision:
    normalized = _coerce_snapshot(snapshot)
    action = declared_action(descriptor, arguments)
    has_actions = bool(getattr(descriptor, "actions", None))
    unresolvable = has_actions and not action
    if not _descriptor_name(descriptor):
        return _decision(
            descriptor=descriptor,
            snapshot=normalized,
            details=_DecisionDetails(
                decision=POLICY_DECISION_ASK,
                stage="hard_safety_deny",
                matched_rule_id=None,
                reason="descriptor missing name; refusing without explicit consent",
                mode=mode,
            ),
            action=action,
        )

    rule_hit = _first_rule_hit(
        normalized.rules,
        descriptor=descriptor,
        arguments=arguments,
        mode=mode,
    )
    if rule_hit is not None and (
        not unresolvable or rule_hit.decision == POLICY_DECISION_DENY
    ):
        return _decision(
            descriptor=descriptor,
            snapshot=normalized,
            details=_DecisionDetails(
                decision=rule_hit.decision,
                stage=_RULE_HIT_STAGE[rule_hit.decision],
                matched_rule_id=rule_hit.id,
                reason=rule_hit.reason,
                mode=mode,
            ),
            action=action,
        )

    legacy_policy = _legacy_policy_for_descriptor(
        normalized,
        _descriptor_name(descriptor),
        "" if unresolvable else action,
    )
    if legacy_policy is not None and (
        not unresolvable or legacy_policy[1] == POLICY_DECISION_DENY
    ):
        legacy_tool_name, legacy_decision = legacy_policy
        return _decision(
            descriptor=descriptor,
            snapshot=normalized,
            details=_DecisionDetails(
                decision=legacy_decision,
                stage="tool_default",
                matched_rule_id=None,
                reason=f"{LEGACY_POLICY_REASON_PREFIX} {legacy_tool_name}={legacy_decision}",
                mode=mode,
            ),
            action=action,
        )

    descriptor_name = _descriptor_name(descriptor)
    side_effecting: bool | None = None
    if not unresolvable:
        action_default_name = f"{descriptor_name}:{action}" if action else ""
        action_default = _DEFAULT_TOOL_DEFAULTS.get(action_default_name)
        if action_default:
            return _decision(
                descriptor=descriptor,
                snapshot=normalized,
                details=_DecisionDetails(
                    decision=action_default,
                    stage="tool_default",
                    matched_rule_id=None,
                    reason=f"built-in default for {action_default_name}",
                    mode=mode,
                ),
                action=action,
            )

        side_effecting = effective_side_effecting(descriptor, arguments)
        if action and side_effecting is False:
            return _decision(
                descriptor=descriptor,
                snapshot=normalized,
                details=_DecisionDetails(
                    decision=POLICY_DECISION_AUTO,
                    stage="tool_default",
                    matched_rule_id=None,
                    reason="read-only action defaults to auto",
                    mode=mode,
                ),
                action=action,
            )

        # An inert create_artifact document is scratch the model writes for its
        # own reasoning; scripts and executable types keep the ask default.
        if descriptor_name == "create_artifact" and is_safe_plan_document(arguments):
            return _decision(
                descriptor=descriptor,
                snapshot=normalized,
                details=_DecisionDetails(
                    decision=POLICY_DECISION_AUTO,
                    stage="tool_default",
                    matched_rule_id=None,
                    reason="built-in default for inert create_artifact documents",
                    mode=mode,
                ),
                action=action,
            )

        default_decision = _DEFAULT_TOOL_DEFAULTS.get(descriptor_name)
        if default_decision:
            return _decision(
                descriptor=descriptor,
                snapshot=normalized,
                details=_DecisionDetails(
                    decision=default_decision,
                    stage="tool_default",
                    matched_rule_id=None,
                    reason=f"built-in default for {descriptor_name}",
                    mode=mode,
                ),
                action=action,
            )

        if not action and getattr(descriptor, "read_only", False) is True:
            return _decision(
                descriptor=descriptor,
                snapshot=normalized,
                details=_DecisionDetails(
                    decision=POLICY_DECISION_AUTO,
                    stage="tool_default",
                    matched_rule_id=None,
                    reason="read-only tool defaults to auto",
                    mode=mode,
                ),
                action=action,
            )

    return _decision(
        descriptor=descriptor,
        snapshot=normalized,
        details=_DecisionDetails(
            decision=POLICY_DECISION_ASK,
            stage="tool_default",
            matched_rule_id=None,
            reason=(
                "action not declared by tool; failing closed to ask"
                if unresolvable
                else (
                    "side-effecting tool defaults to ask"
                    if side_effecting is True
                    else "no policy rule matched and no descriptor default; defaulting to ask"
                )
            ),
            mode=mode,
        ),
        action=action,
    )


def tool_policy_call_key(call: ToolCallRequest) -> str:
    call_id = str(call.call_id or "").strip()
    if call_id:
        return call_id
    try:
        payload = json.dumps(
            {"tool_id": call.tool_id, "arguments": call.arguments},
            ensure_ascii=True,
            sort_keys=True,
            default=str,
        )
    except (TypeError, ValueError):
        payload = f"{call.tool_id}|{type(call.arguments).__name__}"
    return "fallback_" + hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


VERIFY_AFTER_WRITE_STAGE = "verify_after_write"
VERIFY_AFTER_WRITE_REASON = (
    "files changed in this turn; verify would run that code, so the first run asks"
)


def escalate_verify_after_write(decision: ToolPolicyDecision) -> ToolPolicyDecision:
    """Ask for a ``verify`` run after a workspace write (security review item 7).

    Only the untouched built-in AUTO default escalates. A user rule or a stored
    per-tool policy keeps its precedence, as it does over the shell classifier's
    NEEDS_APPROVAL escalation (H1); a one-send auto-run grant still covers the
    resulting ASK in the approval gate, as for every ordinary ask.
    """
    if (
        decision.decision != POLICY_DECISION_AUTO
        or decision.stage != "tool_default"
        or decision.matched_rule_id is not None
        or decision.reason.startswith(LEGACY_POLICY_REASON_PREFIX)
    ):
        return decision
    return replace(
        decision,
        decision=POLICY_DECISION_ASK,
        stage=VERIFY_AFTER_WRITE_STAGE,
        reason=VERIFY_AFTER_WRITE_REASON,
    )


def assert_valid_tool_call(call: ToolCallRequest) -> None:
    if not call.tool_id.strip():
        raise ToolExecutionFailure(
            code=CMP_LOOP_INVALID_TOOL_CALL,
            message="model returned a tool call without a tool_id",
            retryable=False,
        )
    if not isinstance(call.arguments, dict):
        raise ToolExecutionFailure(
            code=CMP_LOOP_INVALID_TOOL_CALL,
            message=f"tool '{call.tool_id}' arguments must be an object",
            retryable=False,
        )


def _classify_shell_command(kernel: Any, call: ToolCallRequest, descriptor: Any) -> Any | None:
    descriptor_name = _descriptor_name(descriptor)
    if not is_feature_flag_enabled(
        getattr(getattr(kernel, "_config", None), "feature_flags", {}) or {},
        FEATURE_SHELL_SECURITY,
    ):
        return None
    raw_command = shell_command_for_tool(descriptor_name, call.arguments)
    if raw_command is None:
        return None
    return classify_command(raw_command)


def _descriptor_for_call(
    kernel: Any,
    call: ToolCallRequest,
    *,
    tool_contract: Any | None,
) -> Any | None:
    entry = tool_contract.entry(call.tool_id) if tool_contract is not None else None
    if entry is not None and not entry.available:
        return None
    if entry is not None:
        return entry.descriptor
    return kernel._mcp_client.tool_descriptor(call.tool_id)


def _skip_policy_call(
    kernel: Any,
    call: ToolCallRequest,
    *,
    resolution_context: Any | None,
    request_disabled_tools: frozenset[str],
) -> bool:
    if call.tool_id == "tool_search":
        return True
    if kernel._is_direct_deferred_tool_call(call, resolution_context):
        return True
    if call.tool_id in request_disabled_tools:
        return True
    return False


def _filter_single_call(
    kernel: Any,
    call: ToolCallRequest,
    context: ToolPolicyFilterContext,
) -> ToolPolicyDecision | None:
    """Classify one call. ``None`` means allowed without a policy decision.

    Raises ``ToolExecutionFailure`` for hard blocks (invalid call, argument
    scan, shell disabled, mode gate, security classifier); the caller converts
    those into per-call denials so one blocked call never poisons the batch or
    kills the turn.
    """
    assert_valid_tool_call(call)
    if _skip_policy_call(
        kernel,
        call,
        resolution_context=context.resolution_context,
        request_disabled_tools=context.request_disabled_tools,
    ):
        return None

    scan_tool_arguments(call.arguments, tool_name=call.tool_id)
    descriptor = _descriptor_for_call(kernel, call, tool_contract=context.tool_contract)
    shell_tool_name = (
        _descriptor_name(descriptor) if descriptor is not None else str(call.tool_id or "")
    )
    if (
        shell_tool_name in {"run_command", "run_temp_script", "monitor"}
        and not kernel._config.tools_shell_enabled
    ):
        raise ToolExecutionFailure(
            code=CMP_TOOL_DISABLED,
            message="shell tool is disabled by configuration",
            retryable=False,
        )
    if descriptor is None:
        return None
    plan_artifact_write = is_plan_artifact_write_eligible(
        descriptor,
        call.tool_id,
        call.arguments,
        plan_mode=context.plan_mode,
        read_only=context.read_only,
    )
    if (
        context.read_only
        and getattr(descriptor, "side_effecting", False)
        and not plan_artifact_write
    ):
        return None
    if (
        getattr(descriptor, "side_effecting", False)
        and not context.mode_allows_side_effecting
        and not plan_artifact_write
    ):
        raise ToolExecutionFailure(
            code=CMP_MODE_TOOL_BLOCKED,
            message=f"side-effecting tools are disabled in '{context.mode}' mode",
            retryable=False,
        )
    shell_classification = _classify_shell_command(kernel, call, descriptor)
    if shell_classification is not None and (
        shell_classification.verdict is CommandVerdict.BLOCKED
    ):
        raise ToolExecutionFailure(
            code=CMP_TOOL_COMMAND_BLOCKED,
            message=(f"command blocked by security classifier: {shell_classification.reason}"),
            retryable=False,
        )

    decision = evaluate_tool_policy(
        descriptor=descriptor,
        arguments=dict(call.arguments),
        mode=context.mode,
        snapshot=(
            context.policy_snapshot
            if context.policy_snapshot is not None
            else getattr(kernel._config, "tool_policy_snapshot", None)
        ),
    )
    if (
        plan_artifact_write
        and decision.decision == POLICY_DECISION_ASK
        and decision.stage == "tool_default"
        and decision.matched_rule_id is None
    ):
        return replace(
            decision,
            decision=POLICY_DECISION_AUTO,
            stage="plan_mode_artifact_default",
            reason="bounded Plan Mode artifact write defaults to auto",
        )
    return decision


def _hard_block_decision(
    kernel: Any,
    call: ToolCallRequest,
    context: ToolPolicyFilterContext,
    failure: ToolExecutionFailure,
) -> ToolPolicyDecision:
    snapshot = _coerce_snapshot(
        context.policy_snapshot
        if context.policy_snapshot is not None
        else getattr(kernel._config, "tool_policy_snapshot", None)
    )
    return ToolPolicyDecision(
        decision=POLICY_DECISION_DENY,
        stage="hard_safety_deny",
        matched_rule_id=None,
        reason=_bounded_reason(str(failure.message or "harness refused the call")),
        snapshot_version=snapshot.version,
        tool_name=str(call.tool_id or ""),
        tool_family="",
        source_kind="",
        mode=str(context.mode or ""),
    )


def filter_tool_calls_by_policy(
    kernel: Any,
    calls: tuple[ToolCallRequest, ...],
    context: ToolPolicyFilterContext,
) -> ToolPolicyFilterResult:
    allowed: list[ToolCallRequest] = []
    denied: list[PolicyDeniedToolCall] = []
    decisions_by_call: dict[str, ToolPolicyDecision] = {}
    audit_metadata_by_call: dict[str, dict[str, object]] = {}

    for original_call in calls:
        call = original_call
        try:
            if isinstance(call.arguments, dict):
                canonical_arguments, _aliases = canonicalize_tool_arguments(
                    tool_name=str(call.tool_id or "").strip(),
                    arguments=call.arguments,
                )
                if canonical_arguments != call.arguments:
                    call = replace(call, arguments=canonical_arguments)
            decision = _filter_single_call(kernel, call, context)
        except ToolExecutionFailure as failure:
            # A hard block becomes a per-call denial visible to the model and
            # never kills the turn.
            block_decision = _hard_block_decision(kernel, call, context, failure)
            metadata: dict[str, object] = {
                "policy_decision": block_decision.to_metadata(),
                "hard_blocked": True,
            }
            key = tool_policy_call_key(call)
            decisions_by_call[key] = block_decision
            audit_metadata_by_call[key] = metadata
            denied.append(
                PolicyDeniedToolCall(
                    call=call,
                    decision=block_decision,
                    metadata=metadata,
                    error_code=failure.code,
                )
            )
            continue
        if decision is None:
            allowed.append(call)
            continue
        call_metadata: dict[str, object] = {"policy_decision": decision.to_metadata()}
        key = tool_policy_call_key(call)
        decisions_by_call[key] = decision
        audit_metadata_by_call[key] = call_metadata
        if decision.decision == POLICY_DECISION_DENY:
            denied.append(
                PolicyDeniedToolCall(
                    call=call,
                    decision=decision,
                    metadata=call_metadata,
                )
            )
            continue
        allowed.append(call)

    return ToolPolicyFilterResult(
        allowed=tuple(allowed),
        denied=tuple(denied),
        decisions_by_call=decisions_by_call,
        audit_metadata_by_call=audit_metadata_by_call,
    )
