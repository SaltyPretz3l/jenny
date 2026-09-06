"""Policy checks that gate tool execution."""

from __future__ import annotations

import hashlib
import json
import ntpath
import posixpath
import re
from dataclasses import dataclass, replace
from typing import Any

from sidecar.ai.config import (
    ToolPolicyRule,
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
from sidecar.ai.tools.builtins.shell_security import (
    CommandVerdict,
    classify_command,
    shell_command_for_tool,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure, canonicalize_tool_arguments
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.plan_artifact_policy import is_plan_artifact_write_eligible
from sidecar.ai.tools.sanitization import sanitize_tool_output, scan_tool_arguments
from sidecar.ai.tools.tool_actions import declared_action, effective_side_effecting

POLICY_DECISION_AUTO = "auto"
POLICY_DECISION_ASK = "ask"
POLICY_DECISION_DENY = "deny"
_VALID_POLICY_DECISIONS = frozenset(
    {POLICY_DECISION_AUTO, POLICY_DECISION_ASK, POLICY_DECISION_DENY}
)
_LEGACY_POLICY_DECISION_PRIORITY = {
    POLICY_DECISION_AUTO: 1,
    POLICY_DECISION_ASK: 2,
    POLICY_DECISION_DENY: 3,
}
_DELEGATE_COMPATIBILITY_TOOL_IDS = (
    "delegate",
    "subagent_run",
    "subagent_batch",
)
_RULE_HIT_STAGE = {
    POLICY_DECISION_DENY: "user_deny",
    POLICY_DECISION_AUTO: "user_allow",
    POLICY_DECISION_ASK: "user_ask",
}
_DEFAULT_TOOL_DEFAULTS = {
    "read_file": POLICY_DECISION_AUTO,
    "glob_files": POLICY_DECISION_AUTO,
    "grep_search": POLICY_DECISION_AUTO,
    "write_file": POLICY_DECISION_ASK,
    "edit_file": POLICY_DECISION_ASK,
    "run_command": POLICY_DECISION_ASK,
    "run_temp_script": POLICY_DECISION_ASK,
    "monitor": POLICY_DECISION_ASK,
    "check_monitor": POLICY_DECISION_AUTO,
    "create_artifact": POLICY_DECISION_ASK,
    "exit_plan_mode": POLICY_DECISION_ASK,
    # `verify` runs one of the user's own saved Workspace Test Runner
    # configurations. Its descriptor is honestly side-effecting (tests write
    # snapshots and coverage), but the model chooses only WHICH saved config to
    # run and can never author the command, so it defaults to auto rather than
    # prompting on every verification. User policy rules still override.
    "verify": POLICY_DECISION_AUTO,
    # Durable task-board writes have the same bounded, user-owned Open Loops
    # safety posture as the Electron-side Home actions.
    "task_board": POLICY_DECISION_AUTO,
}
_MAX_POLICY_REASON_CHARS = 240
_MAX_POLICY_ID_CHARS = 80
_WINDOWS_DRIVE_PATH_RE = re.compile(r"^[A-Za-z]:($|[\\/])")
_UNC_PATH_RE = re.compile(r"^[\\/]{2}[^\\/]+[\\/][^\\/]+")
MAX_APPROVAL_POLICY_TEXT_CHARS = 120
NEUTRAL_APPROVAL_POLICY_TEXT = "Review requested input"
_APPROVAL_WORKSPACE_FAMILIES = frozenset({"filesystem", "git", "workspace", "code_intelligence"})
_APPROVAL_WEB_FAMILIES = frozenset({"browser", "web"})
_APPROVAL_CONTENT_FAMILIES = frozenset({"artifact", "diagram", "knowledge", "rich_files"})


@dataclass(frozen=True)
class ApprovalPresentation:
    policy_scope: str
    policy_consequence: str


def approval_presentation_for_call(
    descriptor: Any,
    arguments: dict[str, Any],
) -> ApprovalPresentation:
    """Map stable descriptor metadata to bounded, non-assuring approval copy."""

    name = str(getattr(descriptor, "name", "") or "").strip().lower()
    family = str(getattr(descriptor, "tool_family", "") or "").strip().lower()
    side_effecting = effective_side_effecting(descriptor, arguments)
    if name in {"run_command", "run_temp_script"}:
        scope = "Local command execution"
        consequence = "May run a local command and change local state."
    else:
        workspace_names = {"read_file", "write_file", "edit_file", "glob_files"}
        if family in _APPROVAL_WORKSPACE_FAMILIES or name in workspace_names:
            scope = "Workspace files"
        elif family in _APPROVAL_WEB_FAMILIES:
            scope = "Web and browser session"
        elif family == "todo":
            scope = "Jenny work items"
        elif family in _APPROVAL_CONTENT_FAMILIES:
            scope = "Jenny content"
        elif family in {"python", "runtime", "shell"}:
            scope = "Local computer"
        else:
            scope = "Requested tool"
        if side_effecting is True:
            consequence = "May change data in this scope."
        elif side_effecting is False:
            consequence = "May read data in this scope."
        else:
            consequence = NEUTRAL_APPROVAL_POLICY_TEXT
    return ApprovalPresentation(
        policy_scope=scope[:MAX_APPROVAL_POLICY_TEXT_CHARS],
        policy_consequence=consequence[:MAX_APPROVAL_POLICY_TEXT_CHARS],
    )


def approval_presentation_for_descriptor(descriptor: Any) -> ApprovalPresentation:
    return approval_presentation_for_call(descriptor, {})


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


def _descriptor_name(descriptor: Any) -> str:
    return str(getattr(descriptor, "name", "") or "").strip()


def _policy_tool_ids_for_descriptor(descriptor_name: str) -> tuple[str, ...]:
    if descriptor_name == "delegate":
        return _DELEGATE_COMPATIBILITY_TOOL_IDS
    return (descriptor_name,)


def _legacy_policy_for_descriptor(
    snapshot: ToolPolicySnapshot,
    descriptor_name: str,
    action: str = "",
) -> tuple[str, str] | None:
    selected: tuple[str, str] | None = None
    if action and ":" not in descriptor_name:
        for tool_name in _policy_tool_ids_for_descriptor(descriptor_name):
            composite_name = f"{tool_name}:{action}"
            decision = snapshot.legacy_decision_for(composite_name)
            if decision not in _VALID_POLICY_DECISIONS:
                continue
            if selected is None or (
                _LEGACY_POLICY_DECISION_PRIORITY[decision]
                > _LEGACY_POLICY_DECISION_PRIORITY[selected[1]]
            ):
                selected = (composite_name, decision)
        if selected is not None:
            return selected
    for tool_name in _policy_tool_ids_for_descriptor(descriptor_name):
        decision = snapshot.legacy_decision_for(tool_name)
        if decision not in _VALID_POLICY_DECISIONS:
            continue
        if selected is None or (
            _LEGACY_POLICY_DECISION_PRIORITY[decision]
            > _LEGACY_POLICY_DECISION_PRIORITY[selected[1]]
        ):
            selected = (tool_name, decision)
    return selected


def _descriptor_family(descriptor: Any) -> str:
    return str(getattr(descriptor, "tool_family", "") or "").strip()


def _descriptor_source_kind(descriptor: Any) -> str:
    return str(getattr(descriptor, "source_kind", "") or "").strip()


def _descriptor_server_name(descriptor: Any) -> str:
    return str(getattr(descriptor, "server_name", "") or "").strip()


def _path_argument(arguments: dict[str, Any]) -> str:
    value = arguments.get("path")
    if value is None:
        value = arguments.get("file_path")
    return str(value or "").strip()


def _is_windows_like_policy_path(value: str) -> bool:
    return (
        "\\" in value
        or _WINDOWS_DRIVE_PATH_RE.match(value) is not None
        or _UNC_PATH_RE.match(value) is not None
    )


def _strip_trailing_policy_separators(value: str) -> str:
    out = value
    while len(out) > 1 and out.endswith("/") and re.match(r"^[a-z]:/$", out, re.IGNORECASE) is None:
        out = out[:-1]
    return out


def _normalize_policy_path_for_match(value: str, *, windows_like: bool) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    normalizer = ntpath.normpath if windows_like else posixpath.normpath
    normalized = normalizer(raw).replace("\\", "/")
    if windows_like:
        normalized = normalized.casefold()
        if re.match(r"^[a-z]:\.?$", normalized, re.IGNORECASE):
            return f"{normalized[0]}:/"
    return _strip_trailing_policy_separators(normalized)


def _is_root_policy_prefix(value: str) -> bool:
    return value == "/" or re.match(r"^[a-z]:/$", value, re.IGNORECASE) is not None


def _path_prefix_matches(path_value: str, prefix_value: str) -> bool:
    raw_path = str(path_value or "").strip()
    raw_prefix = str(prefix_value or "").strip()
    if not raw_path or not raw_prefix:
        return False
    windows_like = _is_windows_like_policy_path(raw_path) or _is_windows_like_policy_path(
        raw_prefix
    )
    normalized_path = _normalize_policy_path_for_match(
        raw_path,
        windows_like=windows_like,
    )
    normalized_prefix = _normalize_policy_path_for_match(
        raw_prefix,
        windows_like=windows_like,
    )
    if not normalized_path or not normalized_prefix:
        return False
    return (
        normalized_path == normalized_prefix
        or (
            _is_root_policy_prefix(normalized_prefix)
            and normalized_path.startswith(normalized_prefix)
        )
        or normalized_path.startswith(f"{normalized_prefix}/")
    )


def _rule_matches(
    rule: ToolPolicyRule,
    *,
    descriptor: Any,
    arguments: dict[str, Any],
    mode: str,
) -> bool:
    match = rule.match
    return all(
        (
            not match.tool_id
            or match.tool_id in _policy_tool_ids_for_descriptor(_descriptor_name(descriptor)),
            # Electron-authored rules are scoped by tool_id; matching uses the raw call argument.
            not match.action or match.action == str(arguments.get("action") or ""),
            not match.tool_family or match.tool_family == _descriptor_family(descriptor),
            not match.source_kind or match.source_kind == _descriptor_source_kind(descriptor),
            not match.mcp_server or match.mcp_server == _descriptor_server_name(descriptor),
            not match.mode or str(mode or "") in match.mode,
            not match.path_prefix
            or _path_prefix_matches(_path_argument(arguments), match.path_prefix),
        )
    )


def _first_rule_hit(
    rules: tuple[ToolPolicyRule, ...],
    *,
    descriptor: Any,
    arguments: dict[str, Any],
    mode: str,
) -> ToolPolicyRule | None:
    first_auto: ToolPolicyRule | None = None
    first_ask: ToolPolicyRule | None = None
    for rule in rules:
        if not _rule_matches(rule, descriptor=descriptor, arguments=arguments, mode=mode):
            continue
        if rule.decision == POLICY_DECISION_DENY:
            return rule
        if rule.decision == POLICY_DECISION_AUTO and first_auto is None:
            first_auto = rule
        elif rule.decision == POLICY_DECISION_ASK and first_ask is None:
            first_ask = rule
    return first_auto or first_ask


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
                reason=(f"legacy per-tool policy: {legacy_tool_name}={legacy_decision}"),
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


def _assert_valid_tool_call(call: ToolCallRequest) -> None:
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
    _assert_valid_tool_call(call)
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
        snapshot=getattr(kernel._config, "tool_policy_snapshot", None),
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
    snapshot = _coerce_snapshot(getattr(kernel._config, "tool_policy_snapshot", None))
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
