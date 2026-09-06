"""Tool resolution helpers extracted from router.py."""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any

from sidecar.ai.context.builder import looks_like_current_info_request
from sidecar.ai.tools.assembly import (
    ToolAssemblyContext,
    tool_preference_set,
)
from sidecar.ai.tools.assembly import (
    assemble_tool_contract as _assemble_tool_contract,
)
from sidecar.ai.tools.catalog import (
    BUILTIN_MCP_SERVER_NAME,
    MANAGED_SIDECAR_SURFACE,
    build_tool_catalog,
    electron_owned_manifest_entries,
)
from sidecar.ai.tools.tool_search import hidden_unexposed_tool_names
from sidecar.runtime.chat_models import ChatRequestContext
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)
ELECTRON_TOOL_BRIDGE_SERVER_NAME = "electron_tool_bridge"


def _config_bool(config: Any, key: str) -> bool:
    value = getattr(config, key, None)
    if isinstance(value, bool):
        return value
    if isinstance(config, dict):
        raw_value = config.get(key)
        if isinstance(raw_value, bool):
            return raw_value
    return False


def _electron_bridge_runtime_descriptors(config: Any) -> tuple[Any, ...]:
    """Bridge descriptors for every Electron-owned tool the config enables.

    Derived from the manifest instead of a hand-maintained name list. A tool
    without a runtime descriptor keeps ``runtime_registered=False``, and
    assembly refuses that before any other gate -- so an omitted tool is
    invisible to the model even though Electron registers and executes it, with
    no error anywhere. ``ask_user`` fell through exactly that hole while the
    plan-mode prompt was instructing the model to call it.
    """
    if not _config_bool(config, "electron_tool_bridge_enabled"):
        return ()
    descriptors: list[Any] = []
    for entry in electron_owned_manifest_entries():
        name = str(entry.get("name") or "").strip()
        if not name:
            continue
        availability = entry.get("availability")
        config_flag = (
            str(availability.get("config_flag") or "").strip()
            if isinstance(availability, dict)
            else ""
        )
        if config_flag and not _config_bool(config, config_flag):
            continue
        input_schema = entry.get("parameters")
        descriptors.append(
            SimpleNamespace(
                name=name,
                description=str(entry.get("description") or "").strip(),
                input_schema=input_schema
                if isinstance(input_schema, dict)
                else {"type": "object", "properties": {}},
                side_effecting=entry.get("side_effecting") is True,
                # Carried for fidelity, not load-bearing: the merge in
                # build_tool_catalog keeps only server_name/runtime_registered/
                # search_hint from a runtime descriptor, so the effective
                # read_only for a manifest-known tool comes from the manifest
                # descriptor (which is why `home` keeps read_only=False despite
                # side_effecting=False).
                read_only=entry.get("read_only", entry.get("side_effecting") is not True),
                server_name=ELECTRON_TOOL_BRIDGE_SERVER_NAME,
                source_kind="builtin",
                tool_family=str(entry.get("tool_family") or "runtime").strip() or "runtime",
                server_tool_name=name,
            )
        )
    return tuple(descriptors)


def _catalog_for_kernel(kernel: Any) -> tuple[Any, ...]:
    runtime_descriptors = tuple(getattr(kernel._mcp_client, "available_tools", ()) or ())
    plugin_provider = getattr(kernel, "_plugin_runtime_tool_provider", None)
    plugin_descriptors = tuple(plugin_provider() or ()) if callable(plugin_provider) else ()
    return build_tool_catalog(
        config=kernel._config,
        runtime_descriptors=(
            *runtime_descriptors,
            *_electron_bridge_runtime_descriptors(kernel._config),
            *plugin_descriptors,
        ),
    )


def engine_supports_tool_calling(kernel: Any) -> bool:
    value = getattr(kernel._engine, "supports_tool_calling", None)
    if isinstance(value, bool):
        return value
    return True


def engine_supports_inband_tool_calling(kernel: Any) -> bool:
    value = getattr(kernel._engine, "supports_inband_tool_calling", None)
    if isinstance(value, bool):
        return value
    return False


def tool_has_workspace(kernel: Any) -> bool:
    workspace_root = getattr(kernel._config, "tools_workspace_root", None)
    agent_workspace_root = getattr(kernel._config, "agent_workspace_root", None)
    return bool(str(workspace_root or agent_workspace_root or "").strip())


def remaining_unexposed_tool_names(resolution_context: Any | None) -> frozenset[str]:
    return hidden_unexposed_tool_names(resolution_context)


def request_tool_set(
    tool_preferences: dict[str, tuple[str, ...]] | None,
    key: str,
) -> frozenset[str]:
    return tool_preference_set(tool_preferences, key)


def _context_from_request(
    kernel: Any,
    *,
    request_context: ChatRequestContext | None,
    resolution_context: Any | None,
    enforce_mode_policy: bool,
    enforce_request_preferences: bool,
    include_deferred_tools: bool,
    lockdown_disabled_tools: frozenset[str] = frozenset(),
) -> ToolAssemblyContext:
    if request_context is None:
        return ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config=kernel._config,
            engine_supports_tool_calling=engine_supports_tool_calling(kernel),
            engine_supports_inband_tool_calling=engine_supports_inband_tool_calling(kernel),
            mode=getattr(kernel._config, "mode", None),
            plan_mode=False,
            read_only=False,
            tool_preferences=None,
            resolution_context=resolution_context,
            workspace_root_present=tool_has_workspace(kernel),
            enforce_mode_policy=enforce_mode_policy,
            enforce_request_preferences=enforce_request_preferences,
            include_deferred_tools=include_deferred_tools,
        )
    tool_preferences = request_context.tool_preferences
    if request_context.session_offline_lockdown:
        source = tool_preferences if isinstance(tool_preferences, dict) else {}
        tool_preferences = {
            **source,
            "disabled_tools": tuple(sorted(
                tool_preference_set(source, "disabled_tools") | lockdown_disabled_tools
            )),
        }
    return ToolAssemblyContext(
        surface=MANAGED_SIDECAR_SURFACE,
        config=kernel._config,
        engine_supports_tool_calling=engine_supports_tool_calling(kernel),
        engine_supports_inband_tool_calling=engine_supports_inband_tool_calling(kernel),
        mode=request_context.mode,
        plan_mode=request_context.plan_mode,
        read_only=request_context.read_only,
        tool_preferences=tool_preferences,
        resolution_context=resolution_context,
        workspace_root_present=(
            request_context.workspace_root_present
            if isinstance(request_context.workspace_root_present, bool)
            else tool_has_workspace(kernel)
        ),
        enforce_mode_policy=enforce_mode_policy,
        enforce_request_preferences=enforce_request_preferences,
        include_deferred_tools=include_deferred_tools,
    )


def assemble_tool_contract(
    kernel: Any,
    *,
    resolution_context: Any | None = None,
    request_context: ChatRequestContext | None = None,
    enforce_mode_policy: bool = True,
    enforce_request_preferences: bool = True,
    include_deferred_tools: bool = True,
):
    catalog = _catalog_for_kernel(kernel)
    lockdown_disabled_tools = frozenset(
        descriptor.name
        for descriptor in catalog
        if (
            descriptor.server_name not in {
                BUILTIN_MCP_SERVER_NAME,
                ELECTRON_TOOL_BRIDGE_SERVER_NAME,
            }
            or str(descriptor.source_kind or "").startswith("plugin")
        )
    )
    return _assemble_tool_contract(
        catalog,
        _context_from_request(
            kernel,
            request_context=request_context,
            resolution_context=resolution_context,
            enforce_mode_policy=enforce_mode_policy,
            enforce_request_preferences=enforce_request_preferences,
            include_deferred_tools=include_deferred_tools,
            lockdown_disabled_tools=lockdown_disabled_tools,
        ),
    )


def get_tool_schemas(kernel: Any) -> list[dict[str, Any]]:
    contract = assemble_tool_contract(
        kernel,
        enforce_mode_policy=False,
        enforce_request_preferences=False,
        include_deferred_tools=False,
    )
    return [contract.full_schema_map[name] for name in sorted(contract.full_schema_map)]


def build_full_tool_schema_map(kernel: Any) -> dict[str, dict[str, Any]]:
    contract = assemble_tool_contract(
        kernel,
        enforce_mode_policy=False,
        enforce_request_preferences=False,
        include_deferred_tools=False,
    )
    return dict(contract.full_schema_map)


def build_tool_payload(
    kernel: Any,
    resolution_context: Any | None,
    *,
    plan_mode: bool = False,
    tool_preferences: dict[str, tuple[str, ...]] | None = None,
    request_context: ChatRequestContext | None = None,
) -> list[dict[str, Any]]:
    if request_context is None and (plan_mode or tool_preferences is not None):
        request_context = ChatRequestContext(
            request_id="",
            trace_id=None,
            session_id=None,
            mode=kernel._config.mode,
            approvals_pre_granted=True,
            plan_mode=plan_mode,
            read_only=plan_mode,
            tool_preferences=tool_preferences,
            workspace_root_present=tool_has_workspace(kernel),
        )
    contract = assemble_tool_contract(
        kernel,
        resolution_context=resolution_context,
        request_context=request_context,
    )
    return list(contract.prompt_schemas)


def tool_status_entries(
    kernel: Any,
    resolution_context: Any | None = None,
    plan_mode: bool = False,
    tool_preferences: dict[str, tuple[str, ...]] | None = None,
    request_context: ChatRequestContext | None = None,
) -> tuple[Any, ...]:
    if request_context is None and (plan_mode or tool_preferences is not None):
        request_context = ChatRequestContext(
            request_id="",
            trace_id=None,
            session_id=None,
            mode=kernel._config.mode,
            approvals_pre_granted=True,
            plan_mode=plan_mode,
            read_only=plan_mode,
            tool_preferences=tool_preferences,
            workspace_root_present=tool_has_workspace(kernel),
        )
    enforce_request_filters = request_context is not None
    contract = assemble_tool_contract(
        kernel,
        resolution_context=resolution_context,
        request_context=request_context,
        enforce_mode_policy=enforce_request_filters,
        enforce_request_preferences=enforce_request_filters,
        include_deferred_tools=enforce_request_filters,
    )
    return contract.status_entries


def available_tool_names(tool_statuses: tuple[Any, ...]) -> tuple[str, ...]:
    return tuple(status.name for status in tool_statuses if status.available is True)


def log_tool_contract(
    kernel: Any,
    *,
    request_id: str,
    tool_statuses: tuple[Any, ...],
    latest_user_content: str,
) -> None:
    available = [status.name for status in tool_statuses if status.available is True]
    unavailable = {
        status.name: status.reason
        for status in tool_statuses
        if status.available is not True and status.reason
    }
    log_event(
        logger,
        logging.INFO,
        component="ai.router",
        event="ai.router.tool_contract_built",
        message="Built request-scoped executable tool contract.",
        status="success",
        data={
            "available_tools": available,
            "unavailable_tools": unavailable,
            "current_info_request": looks_like_current_info_request(latest_user_content),
        },
        request_id=request_id,
    )


def log_request_tool_preferences(
    kernel: Any,
    *,
    request_id: str,
    session_id: str | None,
    tool_preferences: dict[str, tuple[str, ...]] | None,
) -> None:
    _ = kernel
    enabled_tools = sorted(request_tool_set(tool_preferences, "enabled_tools"))
    disabled_tools = sorted(request_tool_set(tool_preferences, "disabled_tools"))
    disabled_tool_families = sorted(
        request_tool_set(tool_preferences, "disabled_tool_families")
    )
    if not enabled_tools and not disabled_tools and not disabled_tool_families:
        return
    log_event(
        logger,
        logging.INFO,
        component="ai.router",
        event="ai.router.request_tool_preferences_applied",
        message="Applied request-scoped tool preferences.",
        status="success",
        data={
            "enabled_tools": enabled_tools,
            "disabled_tools": disabled_tools,
            "disabled_tool_families": disabled_tool_families,
        },
        request_id=request_id,
        session_id=session_id,
    )
