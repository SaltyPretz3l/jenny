"""Request-scoped tool assembly over canonical tool descriptors."""

from __future__ import annotations

import logging
import sys
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path
from typing import Any, Iterable

# Imported from the shared leaf rather than sidecar.ai.context.builder (which
# re-exports it) so tool assembly does not drag the whole context builder into
# the builtin-tools subprocess just to construct this dataclass.
from sidecar.ai.context.builder_shared import RuntimeToolStatus
from sidecar.ai.error_codes import (
    CMP_MODE_TOOL_BLOCKED,
    CMP_TOOL_DISABLED,
    CMP_TSRCH_DEFERRED_TOOL,
)
from sidecar.ai.mode_policy import policy_for_mode
from sidecar.ai.tools import (
    config_utils as _config_utils,
)
from sidecar.ai.tools import (
    plan_artifact_policy as _plan_artifact_policy,
)
from sidecar.ai.tools.catalog import (
    CanonicalToolDescriptor,
    ProbeContext,
    has_any_non_side_effecting_action,
    run_probe,
    tool_display_name,
)
from sidecar.ai.tools.tool_search import (
    TOOL_SEARCH_TOOL_NAME,
    build_deferred_tool_entry,
    hidden_unexposed_tool_names,
)
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

_DEFAULT_OFF_CONFIG_FLAGS: frozenset[str] = frozenset()
_CONFIG_FLAG_PREREQUISITES: dict[str, tuple[str, ...]] = {}

RUNTIME_UNAVAILABLE_REASON = "runtime/backend unavailable"
CONFIG_DISABLED_REASON = "config disabled"
PLATFORM_UNSUPPORTED_REASON = "platform unsupported"
WORKSPACE_REQUIRED_REASON = "workspace requirement missing"
ENGINE_UNSUPPORTED_REASON = "model/runtime does not support tool calling"
MODE_DISABLED_REASON = "mode blocks tool use"
MODE_SIDE_EFFECTING_REASON = "mode blocks side-effecting tools"
READ_ONLY_UNAVAILABLE_REASON = "read-only mode blocks side-effecting tools"
REQUEST_DISABLED_REASON = "request preference disabled"
REQUEST_NOT_ENABLED_REASON = "request preference not enabled"
SAFETY_MODE_STRICT_REASON = "strict safety mode blocks network tools"
TOOL_NOT_EXPOSED_REASON = "model/runtime does not expose this turn"
PLAN_MODE_ONLY_REASON = "tool is available only in plan mode"


def current_info_remediation(reason: str | None) -> str:
    """Map a tool-unavailability *reason* to a one-line, user-actionable remedy.

    Returned text is model-facing: it tells the assistant what concrete next
    step to offer the user so a "can't fetch live info" turn becomes
    actionable (switch model / enable web tools) instead of a vague apology.
    Returns ``""`` for reasons that have no user-fixable remedy.
    """
    token = str(reason or "").strip()
    if token == ENGINE_UNSUPPORTED_REASON:
        return (
            "The active model can't use tools this session, so a live lookup isn't "
            "possible — offer to switch to a tool-capable model to fetch live info."
        )
    if token == CONFIG_DISABLED_REASON:
        return (
            "Web tools are turned off — tell the user they can enable them in "
            "Settings > Tools > Web tools to allow live web lookups."
        )
    if token == SAFETY_MODE_STRICT_REASON:
        return (
            "Strict safety mode is blocking network tools — tell the user they can "
            "relax the safety mode to allow web lookups."
        )
    return ""


def tool_preference_set(
    tool_preferences: dict[str, tuple[str, ...]] | None,
    key: str,
) -> frozenset[str]:
    if not isinstance(tool_preferences, dict):
        return frozenset()
    value = tool_preferences.get(key)
    if isinstance(value, tuple):
        return frozenset(str(item).strip() for item in value if str(item).strip())
    if isinstance(value, list):
        return frozenset(str(item).strip() for item in value if str(item).strip())
    return frozenset()


@dataclass(frozen=True)
class ToolAssemblyContext:
    surface: str
    config: Any | None = None
    engine_supports_tool_calling: bool = True
    engine_supports_inband_tool_calling: bool = False
    mode: str | None = None
    plan_mode: bool = False
    read_only: bool = False
    tool_preferences: dict[str, tuple[str, ...]] | None = None
    resolution_context: Any | None = None
    workspace_root_present: bool | None = None
    enforce_mode_policy: bool = True
    enforce_request_preferences: bool = True
    include_deferred_tools: bool = True


@dataclass(frozen=True)
class AssembledToolEntry:
    descriptor: CanonicalToolDescriptor
    available: bool
    reason: str | None = None
    deferred: bool = False
    prompt_schema: dict[str, Any] | None = None
    applicable: bool = True
    unmet_preconditions: tuple[str, ...] = ()

    def runtime_status(self) -> RuntimeToolStatus:
        return RuntimeToolStatus(
            name=self.descriptor.name,
            display_name=tool_display_name(self.descriptor.name),
            available=self.available,
            reason=self.reason,
            description=self.descriptor.description,
            source_kind=self.descriptor.source_kind,
            tool_family=self.descriptor.tool_family,
            server_name=self.descriptor.server_name,
            input_schema=self.descriptor.input_schema,
            applicable=self.applicable,
            unmet_preconditions=self.unmet_preconditions,
        )


@dataclass(frozen=True)
class AssembledToolContract:
    entries: tuple[AssembledToolEntry, ...]

    @cached_property
    def _entry_map(self) -> dict[str, AssembledToolEntry]:
        return {entry.descriptor.name: entry for entry in self.entries if entry.descriptor.name}

    def entry(self, tool_name: str) -> AssembledToolEntry | None:
        return self._entry_map.get(str(tool_name or "").strip())

    def descriptor(self, tool_name: str) -> CanonicalToolDescriptor | None:
        entry = self.entry(tool_name)
        return entry.descriptor if entry is not None else None

    def executable_descriptor(self, tool_name: str) -> CanonicalToolDescriptor | None:
        entry = self.entry(tool_name)
        if entry is None or not entry.available:
            return None
        return entry.descriptor

    @property
    def prompt_schemas(self) -> tuple[dict[str, Any], ...]:
        return tuple(
            entry.prompt_schema for entry in self.entries if isinstance(entry.prompt_schema, dict)
        )

    @property
    def status_entries(self) -> tuple[RuntimeToolStatus, ...]:
        return tuple(entry.runtime_status() for entry in self.entries)

    @property
    def full_schema_map(self) -> dict[str, dict[str, Any]]:
        return {
            entry.descriptor.name: schema_from_descriptor(entry.descriptor)
            for entry in self.entries
        }

    @property
    def available_names(self) -> tuple[str, ...]:
        return tuple(entry.descriptor.name for entry in self.entries if entry.available)

    @property
    def filtered_descriptors(self) -> tuple[CanonicalToolDescriptor, ...]:
        return tuple(entry.descriptor for entry in self.entries)


def schema_from_descriptor(descriptor: CanonicalToolDescriptor) -> dict[str, Any]:
    return {
        "name": descriptor.name,
        "description": descriptor.description,
        "parameters": descriptor.input_schema,
        "side_effecting": descriptor.side_effecting,
    }


def blocked_tool_error_code(reason: str | None) -> str:
    if reason in {
        MODE_DISABLED_REASON,
        MODE_SIDE_EFFECTING_REASON,
        READ_ONLY_UNAVAILABLE_REASON,
        PLAN_MODE_ONLY_REASON,
    }:
        return CMP_MODE_TOOL_BLOCKED
    if reason == TOOL_NOT_EXPOSED_REASON:
        return CMP_TSRCH_DEFERRED_TOOL
    return CMP_TOOL_DISABLED


def blocked_tool_message(tool_name: str, reason: str | None) -> str:
    normalized_name = str(tool_name or "").strip() or "tool"
    if reason == READ_ONLY_UNAVAILABLE_REASON:
        return f"Tool '{normalized_name}' is unavailable because this request is read-only."
    if reason == PLAN_MODE_ONLY_REASON:
        return f"Tool '{normalized_name}' is available only in Plan Mode."
    if reason == MODE_DISABLED_REASON:
        return f"Tool '{normalized_name}' is unavailable because the active mode blocks tool use."
    if reason == MODE_SIDE_EFFECTING_REASON:
        return f"Tool '{normalized_name}' is unavailable because the active mode blocks side-effecting tools."
    if reason == REQUEST_DISABLED_REASON:
        return f"Tool '{normalized_name}' is disabled for this request by tool preferences."
    if reason == REQUEST_NOT_ENABLED_REASON:
        return f"Tool '{normalized_name}' is not enabled for this request by tool preferences."
    if reason == SAFETY_MODE_STRICT_REASON:
        return f"Tool '{normalized_name}' is unavailable because strict safety mode blocks network tools."
    if reason == WORKSPACE_REQUIRED_REASON:
        return f"Tool '{normalized_name}' is unavailable because a tools workspace root is not configured."
    if reason == CONFIG_DISABLED_REASON:
        return f"Tool '{normalized_name}' is disabled by configuration."
    if reason == ENGINE_UNSUPPORTED_REASON:
        return f"Tool '{normalized_name}' is unavailable because the current model/runtime does not support tool calling."
    if reason == TOOL_NOT_EXPOSED_REASON:
        return (
            f"Tool '{normalized_name}' is not exposed in this turn. "
            "Call tool_search first to discover it, then retry the tool call."
        )
    return f"Tool '{normalized_name}' is unavailable: {reason or RUNTIME_UNAVAILABLE_REASON}."


def blocked_tool_metadata(reason: str | None) -> dict[str, Any]:
    if reason == READ_ONLY_UNAVAILABLE_REASON:
        return {"read_only_blocked": True}
    if reason == PLAN_MODE_ONLY_REASON:
        return {"plan_mode_only": True}
    if reason == REQUEST_DISABLED_REASON:
        return {"request_preference_disabled": True}
    if reason == REQUEST_NOT_ENABLED_REASON:
        return {"request_preference_not_enabled": True}
    if reason == SAFETY_MODE_STRICT_REASON:
        return {"safety_mode_blocked": True, "safety_mode": "strict"}
    if reason == WORKSPACE_REQUIRED_REASON:
        return {"workspace_required": True}
    if reason == CONFIG_DISABLED_REASON:
        return {"config_disabled": True}
    if reason == ENGINE_UNSUPPORTED_REASON:
        return {"tool_calling_unsupported": True}
    if reason == TOOL_NOT_EXPOSED_REASON:
        return {"deferred": True, "tool_search_required": True}
    return {}


def _bool_config_gate(config: Any | None, key: str, *, default: bool) -> bool:
    value = _config_utils.config_value(config, key, default)
    if isinstance(value, bool):
        return value
    log_event(
        logger,
        logging.WARNING,
        component="ai.tools",
        event="ai.tools.config_gate_invalid",
        message=f"Tool config gate '{key}' has non-bool value; failing closed.",
        status="failure",
        data={"key": key, "value_type": type(value).__name__},
    )
    return False


def _tools_enabled(config: Any | None) -> bool:
    return _bool_config_gate(config, "tools_enabled", default=True)


def _config_flag_enabled(config: Any | None, key: str | None) -> bool:
    if not key:
        return True
    if not _bool_config_gate(config, key, default=key not in _DEFAULT_OFF_CONFIG_FLAGS):
        return False
    return all(
        _bool_config_gate(config, prerequisite, default=False)
        for prerequisite in _CONFIG_FLAG_PREREQUISITES.get(key, ())
    )


def _workspace_root_present(context: ToolAssemblyContext) -> bool:
    if isinstance(context.workspace_root_present, bool):
        return context.workspace_root_present
    raw_workspace_root = _config_utils.config_value(
        context.config, "tools_workspace_root", None
    )
    if isinstance(raw_workspace_root, str) and raw_workspace_root.strip():
        return True
    raw_agent_workspace_root = _config_utils.config_value(
        context.config, "agent_workspace_root", None
    )
    return isinstance(raw_agent_workspace_root, str) and raw_agent_workspace_root.strip() != ""


def _precondition_workspace_root(context: ToolAssemblyContext) -> Path | None:
    for key in ("tools_workspace_root", "agent_workspace_root"):
        raw_workspace_root = _config_utils.config_value(context.config, key, None)
        if isinstance(raw_workspace_root, Path):
            return raw_workspace_root
        if isinstance(raw_workspace_root, str) and raw_workspace_root.strip():
            return Path(raw_workspace_root.strip())
    return None


def _evaluate_applicability(
    descriptor: CanonicalToolDescriptor,
    *,
    available: bool,
    probe_context: ProbeContext,
    probe_results: dict[str, bool],
) -> tuple[bool, tuple[str, ...]]:
    if not available or not descriptor.preconditions:
        return True, ()
    unmet: list[str] = []
    for precondition in descriptor.preconditions:
        if precondition.probe not in probe_results:
            probe_results[precondition.probe] = run_probe(
                precondition.probe,
                probe_context,
            )
        if not probe_results[precondition.probe]:
            unmet.append(precondition.id)
    return not unmet, tuple(unmet)


def _safety_mode(config: Any | None) -> str:
    value = _config_utils.config_value(config, "safety_mode", "normal")
    if isinstance(value, str) and value.strip().lower() in {"normal", "strict", "paranoid"}:
        return value.strip().lower()
    return "normal"


def _strict_safety_mode_blocks(
    descriptor: CanonicalToolDescriptor,
    context: ToolAssemblyContext,
) -> bool:
    return _safety_mode(context.config) == "strict" and descriptor.tool_family == "web"


def _base_unavailable_reason(
    descriptor: CanonicalToolDescriptor,
    context: ToolAssemblyContext,
    *,
    disabled_tools: frozenset[str],
    disabled_tool_families: frozenset[str],
    enabled_tools: frozenset[str],
) -> str | None:
    if descriptor.availability.plan_mode_only and not context.plan_mode:
        return PLAN_MODE_ONLY_REASON
    if descriptor.availability.always_available:
        return None if descriptor.runtime_registered else RUNTIME_UNAVAILABLE_REASON
    if not (
        context.engine_supports_tool_calling
        or context.engine_supports_inband_tool_calling
    ):
        return ENGINE_UNSUPPORTED_REASON
    if not _tools_enabled(context.config):
        return RUNTIME_UNAVAILABLE_REASON
    if not _config_flag_enabled(context.config, descriptor.availability.config_flag):
        return CONFIG_DISABLED_REASON
    if _strict_safety_mode_blocks(descriptor, context):
        return SAFETY_MODE_STRICT_REASON
    if descriptor.availability.platforms and sys.platform not in descriptor.availability.platforms:
        return PLATFORM_UNSUPPORTED_REASON
    if descriptor.availability.workspace_required and not _workspace_root_present(context):
        return WORKSPACE_REQUIRED_REASON
    if not descriptor.runtime_registered:
        return RUNTIME_UNAVAILABLE_REASON
    if context.enforce_mode_policy:
        mode_policy = policy_for_mode(context.mode)
        if not mode_policy.allow_tools:
            return MODE_DISABLED_REASON
        if (
            descriptor.side_effecting
            and not mode_policy.allow_side_effecting_tools
            and not _plan_artifact_policy.plan_artifact_mode_exemption(
                descriptor,
                plan_mode=context.plan_mode,
                read_only=context.read_only,
            )
        ):
            return MODE_SIDE_EFFECTING_REASON
    # Declared actions are the finer-grained read-only listing authority. Without
    # actions, preserve the scalar plus explicit read_only=False owner override.
    if context.read_only and not _plan_artifact_policy.plan_artifact_mode_exemption(
        descriptor,
        plan_mode=context.plan_mode,
        read_only=context.read_only,
    ):
        actions = getattr(descriptor, "actions", None)
        if isinstance(actions, dict) and actions:
            if not has_any_non_side_effecting_action(descriptor):
                return READ_ONLY_UNAVAILABLE_REASON
        elif descriptor.side_effecting or getattr(descriptor, "read_only", None) is False:
            return READ_ONLY_UNAVAILABLE_REASON
    if context.enforce_request_preferences:
        if descriptor.name in disabled_tools:
            return REQUEST_DISABLED_REASON
        if descriptor.tool_family in disabled_tool_families:
            return REQUEST_DISABLED_REASON
        if (
            enabled_tools
            and descriptor.name not in enabled_tools
            and descriptor.source_kind != "plugin_native_mcp"
        ):
            return REQUEST_NOT_ENABLED_REASON
    return None


def assemble_tool_contract(
    descriptors: Iterable[CanonicalToolDescriptor],
    context: ToolAssemblyContext,
) -> AssembledToolContract:
    ordered_descriptors = sorted(
        (descriptor for descriptor in descriptors if context.surface in descriptor.surfaces),
        key=lambda descriptor: descriptor.name,
    )
    resolution_context = context.resolution_context
    remaining_deferred = hidden_unexposed_tool_names(resolution_context)
    budget_filtered_names: frozenset[str] = frozenset()
    if resolution_context is not None:
        budget_filtered_names = getattr(
            resolution_context,
            "budget_filtered_names",
            frozenset(),
        )
    disabled_tools: frozenset[str] = frozenset()
    disabled_tool_families: frozenset[str] = frozenset()
    enabled_tools: frozenset[str] = frozenset()
    if context.enforce_request_preferences:
        disabled_tools = tool_preference_set(
            context.tool_preferences,
            "disabled_tools",
        )
        disabled_tool_families = tool_preference_set(
            context.tool_preferences,
            "disabled_tool_families",
        )
        enabled_tools = tool_preference_set(
            context.tool_preferences,
            "enabled_tools",
        )

    tool_search_descriptor: CanonicalToolDescriptor | None = None
    entries: list[AssembledToolEntry] = []
    visible_deferred_names: set[str] = set()
    probe_context = ProbeContext(
        workspace_root=_precondition_workspace_root(context),
        config=context.config,
    )
    probe_results: dict[str, bool] = {}

    for descriptor in ordered_descriptors:
        if descriptor.name == TOOL_SEARCH_TOOL_NAME:
            tool_search_descriptor = descriptor
            continue
        reason = _base_unavailable_reason(
            descriptor,
            context,
            disabled_tools=disabled_tools,
            disabled_tool_families=disabled_tool_families,
            enabled_tools=enabled_tools,
        )
        deferred = (
            reason is None
            and context.include_deferred_tools
            and descriptor.name in remaining_deferred
            and (
                descriptor.availability.defer_eligible
                or descriptor.name in budget_filtered_names
            )
        )
        prompt_schema = None
        available = reason is None and not deferred
        effective_reason = reason
        if deferred:
            effective_reason = TOOL_NOT_EXPOSED_REASON
            prompt_schema = build_deferred_tool_entry(
                descriptor.name,
                descriptor.description,
            )
            visible_deferred_names.add(descriptor.name)
        elif available:
            prompt_schema = _plan_artifact_policy.prompt_schema_for_context(
                descriptor,
                plan_mode=context.plan_mode,
                read_only=context.read_only,
            )
        applicable, unmet_preconditions = _evaluate_applicability(
            descriptor,
            available=available,
            probe_context=probe_context,
            probe_results=probe_results,
        )
        entries.append(
            AssembledToolEntry(
                descriptor=descriptor,
                available=available,
                reason=effective_reason,
                deferred=deferred,
                prompt_schema=prompt_schema,
                applicable=applicable,
                unmet_preconditions=unmet_preconditions,
            )
        )

    if tool_search_descriptor is not None:
        reason = _base_unavailable_reason(
            tool_search_descriptor,
            context,
            disabled_tools=disabled_tools,
            disabled_tool_families=disabled_tool_families,
            enabled_tools=enabled_tools,
        )
        search_index = getattr(resolution_context, "search_index", None)
        available = reason is None and bool(visible_deferred_names) and search_index is not None
        applicable, unmet_preconditions = _evaluate_applicability(
            tool_search_descriptor,
            available=available,
            probe_context=probe_context,
            probe_results=probe_results,
        )
        entries.append(
            AssembledToolEntry(
                descriptor=tool_search_descriptor,
                available=available,
                reason=None if available else (reason or TOOL_NOT_EXPOSED_REASON),
                deferred=False,
                prompt_schema=schema_from_descriptor(tool_search_descriptor) if available else None,
                applicable=applicable,
                unmet_preconditions=unmet_preconditions,
            )
        )

    return AssembledToolContract(
        entries=tuple(sorted(entries, key=lambda entry: entry.descriptor.name))
    )
