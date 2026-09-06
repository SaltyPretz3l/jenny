"""Container wiring for sidecar AI subsystems."""

from __future__ import annotations

import logging
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable, Iterator, cast

from sidecar.ai.config import (
    RuntimeConfig,
    parse_runtime_config,
    resolve_background_runtime_root,
    resolve_memory_db_path,
)
from sidecar.ai.container_lifecycle import StackGenerationOwner
from sidecar.ai.container_mcp_servers import (  # noqa: F401 - _argv_safe_url is a stable test re-export.
    _argv_safe_url,
    _default_mcp_servers,
)
from sidecar.ai.context.builder import ContextBuilder, SkillScope
from sidecar.ai.engines.base import BaseEngine
from sidecar.ai.engines.factory import create_engine
from sidecar.ai.feature_flags import (
    FEATURE_SKILLS_SYSTEM,
    is_feature_flag_enabled,
)
from sidecar.ai.mcp.client import MCPClient
from sidecar.ai.memory.service import MemoryService
from sidecar.ai.memory.store import MemoryStore
from sidecar.ai.memory.unavailable import UnavailableMemoryStore, open_memory_store
from sidecar.ai.personality import normalize_personality_base_prompt
from sidecar.ai.routing.iteration_limits import (
    effective_sub_agent_concurrency_budget,
    effective_tools_execution_timeout_seconds,
    loop_profile_name,
)
from sidecar.ai.routing.router import ChatRouter
from sidecar.ai.routing.tool_observation import ToolObservationStore
from sidecar.ai.tools.tool_call_healing import (
    configure_tool_call_healing,
    default_tool_call_healing_enabled,
    restore_tool_call_healing_default,
)
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.harness_snapshot import HarnessSnapshotBuilder
from sidecar.runtime.monitor_manager import MonitorManager
from sidecar.runtime.provider_capability_profile import ProviderCapabilityProfileStore
from sidecar.runtime.subagent_slots import SubAgentSlotAllocator
from sidecar.runtime.subprocess_manager import SubprocessManager
from sidecar.runtime.turn_diagnostics import TurnDiagnosticsStore
from sidecar.runtime.worker_secrets import merge_config_secrets, split_config_secrets

logger = logging.getLogger(__name__)


def _append_system_prompt_addendum(base_prompt: str, addendum: str) -> str:
    normalized_base = str(base_prompt or "").rstrip()
    normalized_addendum = str(addendum or "").strip()
    if not normalized_addendum:
        return normalized_base
    if not normalized_base:
        return normalized_addendum
    return f"{normalized_base}\n\n{normalized_addendum}"


@dataclass(frozen=True)
class BrainStack:
    # ``raw_config`` is SECRET-FREE by construction (see
    # ``_build_candidate_stack``): it is copied wholesale into background-worker
    # payload files, which are plaintext on disk. Credentials live in
    # ``secrets`` and travel out-of-band over the worker's stdin pipe.
    raw_config: dict[str, Any]
    config: RuntimeConfig
    engine: BaseEngine
    router: ChatRouter
    memory_store: MemoryStore | UnavailableMemoryStore
    memory_service: MemoryService
    context_builder: ContextBuilder
    mcp_client: MCPClient
    harness_snapshot_builder: HarnessSnapshotBuilder
    turn_diagnostics: TurnDiagnosticsStore
    provider_capability_profiles: ProviderCapabilityProfileStore
    tool_observations: ToolObservationStore
    monitor_manager: MonitorManager
    sub_agent_slot_allocator: SubAgentSlotAllocator
    engine_fallback_from: str | None = None
    engine_fallback_reason: str | None = None
    secrets: dict[str, Any] = field(default_factory=dict)


def _close_replaced_stack(previous_stack: BrainStack | None) -> None:
    if previous_stack is None:
        return
    _close_stack_resource("monitor_manager", previous_stack.monitor_manager.close)
    _close_stack_resource("mcp_client", previous_stack.mcp_client.close)
    _close_stack_resource("memory_store", previous_stack.memory_store.close)
    try:
        previous_stack.engine.unload_model()
    except Exception as error:  # noqa: BLE001
        log_event(
            logger,
            logging.WARNING,
            component="ai.container",
            event="ai.container.engine_unload_failed",
            message=f"Engine unload failed during reconfigure: {type(error).__name__}",
            status="failure",
            data={"error_type": type(error).__name__},
        )
    _close_stack_resource("engine", previous_stack.engine.close)


def _close_candidate_engine(engine: BaseEngine) -> None:
    try:
        engine.unload_model()
    except Exception as error:  # noqa: BLE001
        log_event(
            logger,
            logging.WARNING,
            component="ai.container",
            event="ai.container.engine_unload_failed",
            message=f"Engine unload failed during candidate cleanup: {type(error).__name__}",
            status="failure",
            data={"error_type": type(error).__name__},
        )
    _close_stack_resource("engine", engine.close)


def _close_stack_resource(resource_name: str, close_func: Callable[[], object] | None) -> None:
    if not callable(close_func):
        return
    try:
        close_func()
    except Exception as error:  # noqa: BLE001
        log_event(
            logger,
            logging.WARNING,
            component="ai.container",
            event="ai.container.resource_close_failed",
            message=f"{resource_name} close failed: {type(error).__name__}",
            status="failure",
            data={
                "resource": resource_name,
                "error_type": type(error).__name__,
            },
        )


def _open_memory_service(
    config: RuntimeConfig,
    staged: ExitStack,
) -> tuple[MemoryStore | UnavailableMemoryStore, MemoryService]:
    store = open_memory_store(
        resolve_memory_db_path(config),
        store_factory=MemoryStore,
    )
    staged.callback(_close_stack_resource, "memory_store", store.close)
    return store, MemoryService(store)


def _resolve_workspace_root(config: RuntimeConfig) -> Path | None:
    """Resolve an explicitly configured workspace root for tool execution."""
    raw_workspace = config.tools_workspace_root or config.agent_workspace_root
    if raw_workspace is None:
        return None
    return Path(raw_workspace).expanduser()


def _sub_agent_slot_allocator_for_config(config: RuntimeConfig) -> SubAgentSlotAllocator:
    cloud_subagents = loop_profile_name(config) == "cloud"
    capacity = effective_sub_agent_concurrency_budget(config)
    return SubAgentSlotAllocator(
        max_active_sub_agents=capacity,
        max_sub_agents_per_parent=capacity if cloud_subagents else 1,
    )


def _resolve_skill_scopes(config: RuntimeConfig) -> tuple[SkillScope, ...]:
    scopes: list[SkillScope] = []
    candidates = (
        ("bundled", config.skills_bundled_root, config.skills_bundled_enabled),
        ("user", config.skills_user_root, config.skills_user_enabled),
        ("project", config.skills_project_root, config.skills_project_enabled),
    )
    for scope_name, raw_root, enabled in candidates:
        if raw_root is None:
            continue
        scopes.append(
            SkillScope(
                scope=scope_name,
                root=Path(raw_root).expanduser(),
                enabled=enabled,
            )
        )
    return tuple(scopes)


def _apply_context_length_override(
    config: RuntimeConfig,
    *,
    selected_engine_type: str,
    selected_model: str,
) -> RuntimeConfig:
    override = config.context_length_override
    applies = (
        override is not None
        and selected_engine_type == "ollama"
        and selected_model.strip() == config.model.strip()
    )
    return replace(config, context_length=override) if applies else config


def _canonical_model_id(value: str) -> str:
    normalized = str(value or "").strip().lower()
    if not normalized:
        return ""
    last_segment = normalized.rsplit("/", 1)[-1]
    return normalized if ":" in last_segment else f"{normalized}:latest"


def _generation_profile_model_key(value: str, *, engine_type: str) -> str:
    normalized = str(value or "").strip()
    return _canonical_model_id(normalized) if engine_type == "ollama" else normalized


def _merge_sampler_overrides(
    preset: dict[str, float | int] | None,
    overrides: dict[str, float | int],
) -> dict[str, float | int] | None:
    if not isinstance(preset, dict) or not overrides:
        return preset
    return {**preset, **overrides}


def _apply_generation_profile(
    config: RuntimeConfig,
    *,
    selected_engine_type: str,
    selected_model: str,
) -> RuntimeConfig:
    if selected_engine_type not in {"ollama", "vllm", "openai-compatible"}:
        return config
    profiles = config.generation_profiles_by_model or {}
    selected_key = _generation_profile_model_key(
        selected_model,
        engine_type=selected_engine_type,
    )
    profile = next(
        (
            entry
            for model_id, entry in profiles.items()
            if _generation_profile_model_key(
                model_id,
                engine_type=selected_engine_type,
            )
            == selected_key
        ),
        None,
    )
    if not isinstance(profile, dict):
        return config
    sampler_overrides = {
        target_name: profile[source_name]
        for source_name, target_name in {
            "temperature": "temperature",
            "topK": "top_k",
            "topP": "top_p",
            "minP": "min_p",
            "presencePenalty": "presence_penalty",
            "repetitionPenalty": "repeat_penalty",
        }.items()
        if source_name in profile
    }
    return replace(
        config,
        resolved_app_profile_temperature=(
            float(profile["temperature"])
            if "temperature" in profile
            else config.resolved_app_profile_temperature
        ),
        resolved_app_profile_top_k=(
            int(profile["topK"])
            if "topK" in profile
            else config.resolved_app_profile_top_k
        ),
        resolved_app_profile_top_p=(
            float(profile["topP"])
            if "topP" in profile
            else config.resolved_app_profile_top_p
        ),
        resolved_app_profile_min_p=(
            float(profile["minP"])
            if "minP" in profile
            else config.resolved_app_profile_min_p
        ),
        resolved_app_profile_presence_penalty=(
            float(profile["presencePenalty"])
            if "presencePenalty" in profile
            else config.resolved_app_profile_presence_penalty
        ),
        resolved_app_profile_repeat_penalty=(
            float(profile["repetitionPenalty"])
            if "repetitionPenalty" in profile
            else config.resolved_app_profile_repeat_penalty
        ),
        resolved_user_max_output_tokens=(
            int(profile["maxOutputTokens"])
            if "maxOutputTokens" in profile
            else config.resolved_user_max_output_tokens
        ),
        resolved_app_profile_thinking_sampler=_merge_sampler_overrides(
            config.resolved_app_profile_thinking_sampler,
            sampler_overrides,
        ),
        resolved_app_profile_instruct_sampler=_merge_sampler_overrides(
            config.resolved_app_profile_instruct_sampler,
            sampler_overrides,
        ),
    )



_BRAIN_CONTAINER_REQUEST_BOUNDARY_ALLOWED_ATTRS: frozenset[str] = frozenset(
    {
        "_plugin_runtime_apply_stage8",
        "_plugin_runtime_registry",
        "_stack",
        "_stack_generations",
        "_subprocess_manager",
    }
)


class _CorePluginRuntimeAdmission:
    mode = "core_only"

    @contextmanager
    def bind(self) -> Iterator[None]:
        yield None

    @staticmethod
    def release() -> None:
        return None


class BrainContainer:
    def __init__(self, *, subprocess_manager: SubprocessManager | None = None) -> None:
        self._stack: BrainStack | None = None
        self._stack_generations = StackGenerationOwner(_close_replaced_stack)
        self._subprocess_manager = subprocess_manager
        # Deliberately untyped and lazy: ordinary startup/full initialize never
        # imports sidecar.ai.plugins. The explicit Stage-4 plugin-only initialize
        # or a plugin-authority chat is the only path that constructs it.
        self._plugin_runtime_registry: Any | None = None
        self._plugin_runtime_apply_stage8: Any | None = None
        # The stack remains lazy so initialize builds heavy resources exactly once.

    def _plugin_registry(self) -> Any:
        registry = self._plugin_runtime_registry
        if registry is None:
            from sidecar.ai.plugins.runtime_registry import PluginRuntimeRegistry

            registry = PluginRuntimeRegistry(event_sink=self._emit_plugin_runtime_event)
            self._plugin_runtime_registry = registry
        return registry

    @staticmethod
    def _emit_plugin_runtime_event(event: str, data: dict[str, object]) -> None:
        log_event(
            logger,
            logging.INFO,
            component="ai.container",
            event=event,
            message="Plugin runtime state changed",
            status="ok",
            data=data,
        )

    def _plugin_resource_objects(self) -> dict[str, object]:
        stack = self.stack
        return {
            "engine": stack.engine,
            # RuntimeConfig is the immutable model-selection owner for this
            # BrainStack; proving its identity complements the engine proof.
            "model": stack.config,
            "memory": stack.memory_store,
            "mcp": stack.mcp_client,
            "monitor": stack.monitor_manager,
            "tool": stack.router,
        }

    def apply_plugin_runtime(
        self,
        *,
        snapshot: object,
        declarative_content: object,
        operation: str = "apply",
    ) -> dict[str, object]:
        from sidecar.ai.plugins.runtime_apply import apply_plugin_runtime, build_plugin_runtime

        runtime_version = snapshot.get("runtime_schema_version", 1) \
            if isinstance(snapshot, dict) else 1
        if runtime_version == 6:  # noqa: PLR2004 - persisted runtime schema dispatch.
            from sidecar.ai.plugins.runtime_apply_stage8 import PluginRuntimeApplyStage8

            stage8 = self._plugin_runtime_apply_stage8
            if stage8 is None:
                stage8 = PluginRuntimeApplyStage8(self._plugin_registry())
                self._plugin_runtime_apply_stage8 = stage8
            generation = build_plugin_runtime(
                snapshot=snapshot,
                declarative_content=declarative_content,
                resource_provider=self._plugin_resource_objects,
            )
            generation_id = generation.authority.active_generation_id
            if operation == "prepare":
                prepared = stage8.prepare(generation)
                return cast(dict[str, object], prepared["attestation"])
            if operation == "commit":
                outcome = stage8.commit(generation_id)
            elif operation == "abort":
                outcome = stage8.abort(generation_id)
                return {"status": "aborted", "active_generation_id": generation_id}
            elif operation == "reconcile":
                outcome = stage8.reconcile(generation)
            else:
                raise ValueError("runtime_v6_operation_invalid")
            if outcome.get("ok") is not True:
                raise ValueError(str(outcome.get("reason") or "runtime_apply_failed"))
            return cast(dict[str, object], outcome["attestation"])

        publication = apply_plugin_runtime(
            self._plugin_registry(),
            snapshot=snapshot,
            declarative_content=declarative_content,
            resource_provider=self._plugin_resource_objects,
        )
        return publication.attestation

    def admit_plugin_runtime(self, raw_authority: object | None) -> Any:
        if raw_authority is None or raw_authority == {"mode": "core_only"}:
            return _CorePluginRuntimeAdmission()
        from sidecar.ai.plugins.runtime_registry import admit_plugin_runtime

        return admit_plugin_runtime(self._plugin_registry(), raw_authority)

    def _plugin_runtime_overlay_provider(self) -> tuple[str, ...]:
        registry = self._plugin_runtime_registry
        if registry is None:
            return ()
        return tuple(registry.build_turn_overlays())

    def _plugin_runtime_tool_provider(self) -> tuple[object, ...]:
        registry = self._plugin_runtime_registry
        if registry is None:
            return ()
        return (
            *registry.build_turn_tool_descriptors(),
            *registry.build_turn_native_tool_descriptors(),
        )

    def _plugin_engine_model_ids(self) -> tuple[str, ...]:
        registry = self._plugin_runtime_registry
        return registry.current_engine_ids() if registry is not None else ()

    def assert_request_boundary(
        self,
        *,
        marker: str,
        request_id: str | None = None,
        session_id: str | None = None,
    ) -> None:
        # BrainContainer is a process-global singleton; this tripwire catches
        # accidental per-request state that would leak across turns.
        unexpected = sorted(
            set(vars(self).keys()) - _BRAIN_CONTAINER_REQUEST_BOUNDARY_ALLOWED_ATTRS
        )
        if not unexpected:
            return
        log_event(
            logger,
            logging.ERROR,
            component="ai.container",
            event="ai.container.request_boundary_violation",
            message=(
                f"BrainContainer has unexpected attributes at {marker!r} boundary: "
                f"{unexpected}. Update the boundary allowlist or remove "
                f"the request-local state."
            ),
            status="failure",
            data={
                "marker": marker,
                "unexpected_attrs": unexpected,
            },
            request_id=request_id,
            session_id=session_id,
        )

    @contextmanager
    def request_boundary(
        self,
        marker: str,
        *,
        request_id: str | None = None,
        session_id: str | None = None,
    ) -> Iterator[None]:
        self.assert_request_boundary(
            marker=f"{marker}.enter",
            request_id=request_id,
            session_id=session_id,
        )
        try:
            yield
        finally:
            self.assert_request_boundary(
                marker=f"{marker}.exit",
                request_id=request_id,
                session_id=session_id,
            )

    def _build_candidate_stack(
        self,
        raw_config: Any,
        staged: ExitStack,
        *,
        secrets: dict[str, Any] | None = None,
        progress_callback: Callable[[dict[str, Any]], None] | None = None,
    ) -> BrainStack:
        # Split HERE, not only at the initialize seam: headless
        # (`runtime/headless.py`) hands `configure` a config a user may have
        # legitimately inlined a token into. That path must keep working -- the
        # token is lifted, merged back for parsing, and kept out of raw_config.
        scrubbed, embedded = split_config_secrets(raw_config)
        effective_secrets = {**embedded, **(dict(secrets) if secrets else {})}
        config = parse_runtime_config(merge_config_secrets(scrubbed, effective_secrets))
        # Built BEFORE create_engine and threaded in: create_engine runs
        # `load_model`, which is the SOLE writer of capability profiles. When
        # this store was constructed afterwards and attached to an
        # already-loaded engine, every profile the load recorded was discarded
        # and `provider_capability_profiles_payload` -- exposed through the
        # `initialize` response and `harness.inspect` -- always returned [].
        provider_capability_profiles = ProviderCapabilityProfileStore()
        plugin_registry = self._plugin_registry()
        provider_binding = plugin_registry.current_provider_binding("chatgpt")
        provider_descriptor = provider_binding.descriptor if provider_binding else None
        provider_authority_check = (
            (lambda: plugin_registry.is_provider_binding_current(provider_binding))
            if provider_binding is not None else None
        )
        engine_binding = plugin_registry.current_engine_binding(config.model)
        plugin_host_binding = ({
            **engine_binding.descriptor,
            "authority": {
                "registry_revision": engine_binding.authority.registry_revision,
                "dependency_graph_hash": engine_binding.authority.dependency_graph_hash,
                "commit_epoch": engine_binding.authority.commit_epoch,
                "active_generation_id": engine_binding.authority.active_generation_id,
            },
        } if engine_binding else None)
        plugin_host_authority_check = (
            (lambda: plugin_registry.is_engine_binding_current(engine_binding))
            if engine_binding is not None else None
        )
        engine_selection = (
            create_engine(
                config,
                capability_profile_store=provider_capability_profiles,
                provider_descriptor=provider_descriptor,
                provider_authority_check=provider_authority_check,
                plugin_host_binding=plugin_host_binding,
                plugin_host_authority_check=plugin_host_authority_check,
            )
            if progress_callback is None
            else create_engine(
                config,
                progress_callback=progress_callback,
                capability_profile_store=provider_capability_profiles,
                provider_descriptor=provider_descriptor,
                provider_authority_check=provider_authority_check,
                plugin_host_binding=plugin_host_binding,
                plugin_host_authority_check=plugin_host_authority_check,
            )
        )
        staged.callback(_close_candidate_engine, engine_selection.engine)
        turn_diagnostics = TurnDiagnosticsStore()
        if hasattr(engine_selection.engine, "set_turn_diagnostics_store"):
            engine_selection.engine.set_turn_diagnostics_store(turn_diagnostics)
        tool_observations = ToolObservationStore()
        if hasattr(engine_selection.engine, "set_tool_observation_store"):
            engine_selection.engine.set_tool_observation_store(tool_observations)
        # Phase 6 — expose the audit store on the engine via attribute access so
        # ``LoopRuntime`` construction sites in ``chat_decision`` /
        # ``runtime.chat`` can pass ``observation_store=``. The setter above
        # remains the canonical hook when an engine wants to react to it.
        engine_selection.engine._tool_observation_store = tool_observations  # type: ignore[attr-defined]

        from sidecar.ai.app_profiles import (
            apply_behavior,
            apply_overrides,
            resolve_profile,
            resolve_variant,
        )

        profile = resolve_profile(engine_selection.model, config.app_profile or None)
        if profile is not None:
            variant = resolve_variant(profile, engine_selection.model)
            config = apply_overrides(config, profile, variant)
            config = apply_behavior(config, profile, variant)
            log_event(
                logger,
                logging.INFO,
                component="ai.container",
                event="ai.container.app_profile_resolved",
                message=(
                    f"Resolved app profile {profile.family!r} variant {variant.name!r} "
                    f"for engine {engine_selection.engine_type!r}."
                ),
                status="success",
                data={
                    "family": profile.family,
                    "variant": variant.name,
                    "engine": engine_selection.engine_type,
                    "model": engine_selection.model,
                    "parser_start": config.resolved_app_profile_reasoning_parser_start or None,
                    "parser_end": config.resolved_app_profile_reasoning_parser_end or None,
                },
            )

        # A persisted per-model user choice is the final authority over the
        # conservative app-profile/default clamp. It remains bounded at parse.
        config = _apply_context_length_override(
            config,
            selected_engine_type=engine_selection.engine_type,
            selected_model=engine_selection.model,
        )
        config = _apply_generation_profile(
            config,
            selected_engine_type=engine_selection.engine_type,
            selected_model=engine_selection.model,
        )

        system_prompt = normalize_personality_base_prompt(config.system_prompt)
        system_prompt = _append_system_prompt_addendum(
            system_prompt,
            config.resolved_app_profile_prompt_addendum,
        )
        effective_config = replace(
            config,
            engine_type=engine_selection.engine_type,
            model=engine_selection.model,
            system_prompt=system_prompt,
        )
        set_engine_context_length = getattr(
            engine_selection.engine,
            "set_configured_context_length",
            None,
        )
        if callable(set_engine_context_length):
            set_engine_context_length(effective_config.context_length)
        memory_store, memory_service = _open_memory_service(
            effective_config,
            staged,
        )
        monitor_manager = MonitorManager(
            runtime_root=resolve_background_runtime_root(effective_config)
        )
        staged.callback(_close_stack_resource, "monitor_manager", monitor_manager.close)
        monitor_manager.recover_stale_monitors()
        sub_agent_slot_allocator = _sub_agent_slot_allocator_for_config(effective_config)
        workspace_root = _resolve_workspace_root(effective_config)
        context_builder = ContextBuilder(
            workspace_root,
            skill_scopes=_resolve_skill_scopes(effective_config),
            disabled_skill_ids=effective_config.skills_disabled_ids,
            skills_system_enabled=is_feature_flag_enabled(
                effective_config.feature_flags or {},
                FEATURE_SKILLS_SYSTEM,
            ),
            runtime_overlay_provider=self._plugin_runtime_overlay_provider,
        )

        mcp_client = MCPClient(
            # Must follow the loop profile: an MCP call that outlives this
            # deadline is killed by the client regardless of the loop budget.
            request_timeout_seconds=effective_tools_execution_timeout_seconds(effective_config),
        )
        staged.callback(_close_stack_resource, "mcp_client", mcp_client.close)
        mcp_servers = _default_mcp_servers(effective_config, workspace_root)
        mcp_client.configure(
            mcp_servers,
            sse_enabled=effective_config.mcp_sse_enabled,
            resources_enabled=effective_config.tools_mcp_resources_enabled,
            allow_private_addresses=effective_config.tools_web_allow_private_addresses,
        )
        effective_config = replace(
            effective_config,
            mcp_servers=mcp_servers,
            agent_workspace_root=str(workspace_root) if workspace_root is not None else None,
        )

        # Enable the tool-call reliability net in THIS (main router) process. Its
        # is_healing_enabled() gate is read here — in-band tool-call parsing,
        # reflexive retry, and the per-turn ai.router.tool_call_reliability emit —
        # but the only other configurator call lives in build_tool_bindings, which
        # in live chat runs solely in the builtin-tools subprocess. Without this
        # the net (and its telemetry) stays inert in live chat regardless of config.
        router = ChatRouter(
            config=effective_config,
            engine=engine_selection.engine,
            mcp_client=mcp_client,
            context_builder=context_builder,
            memory_store=memory_service,
            harness_snapshot_provider=None,
            monitor_manager=monitor_manager,
            plugin_runtime_tool_provider=self._plugin_runtime_tool_provider,
        )
        harness_snapshot_builder = HarnessSnapshotBuilder(
            config=effective_config,
            router=router,
            engine=engine_selection.engine,
            mcp_client=mcp_client,
            memory_store=memory_store,
            context_builder=context_builder,
            turn_diagnostics=turn_diagnostics,
            provider_capability_profiles=provider_capability_profiles,
            tool_observations=tool_observations,
        )
        router.set_harness_snapshot_provider(harness_snapshot_builder.inspect)

        return BrainStack(
            raw_config=scrubbed,
            secrets=effective_secrets,
            config=effective_config,
            engine=engine_selection.engine,
            router=router,
            memory_store=memory_store,
            memory_service=memory_service,
            context_builder=context_builder,
            mcp_client=mcp_client,
            harness_snapshot_builder=harness_snapshot_builder,
            turn_diagnostics=turn_diagnostics,
            provider_capability_profiles=provider_capability_profiles,
            tool_observations=tool_observations,
            monitor_manager=monitor_manager,
            sub_agent_slot_allocator=sub_agent_slot_allocator,
            engine_fallback_from=engine_selection.fallback_from,
            engine_fallback_reason=engine_selection.fallback_reason,
        )

    def configure(
        self,
        raw_config: Any,
        *,
        secrets: dict[str, Any] | None = None,
        progress_callback: Callable[[dict[str, Any]], None] | None = None,
    ) -> BrainStack:
        """Build and publish a new stack.

        ABSENT MEANS CLEAR. A secret key missing from both ``raw_config`` and
        ``secrets`` is cleared on the new stack -- it is never carried over from
        the previous generation. This is what makes sign-out work:
        ``buildManagedSidecarSecrets`` (services/backend/managed-sidecar-config.js)
        omits each engine's brokered credential for other engines, so absence
        IS the revocation signal.
        """
        with ExitStack() as staged:
            candidate = self._build_candidate_stack(
                raw_config,
                staged,
                secrets=secrets,
                progress_callback=progress_callback,
            )
            # Publish process defaults only after every candidate resource and
            # dependency has initialized successfully. Active leased turns bind
            # their own request setting, so this does not rewrite old generations.
            previous_healing_default = default_tool_call_healing_enabled()
            try:
                configure_tool_call_healing(candidate.config)
                self._stack_generation_owner().publish(candidate)
            except BaseException:
                restore_tool_call_healing_default(previous_healing_default)
                raise
            self._stack = candidate
            staged.pop_all()
            return candidate

    def _stack_generation_owner(self) -> StackGenerationOwner:
        return self._stack_generations

    @contextmanager
    def stack_lease(self) -> Iterator[BrainStack]:
        if self._stack is None:
            self.configure({})
        with self._stack_generation_owner().lease() as stack:
            yield stack

    @property
    def subprocess_manager(self) -> SubprocessManager | None:
        return self._subprocess_manager

    @property
    def stack(self) -> BrainStack:
        owned_stack = self._stack_generations.current_stack
        if owned_stack is not None:
            return owned_stack
        stack = self._stack
        if stack is None:
            stack = self.configure({})
        return stack

    def close(self) -> None:
        if self._stack is None:
            return
        owner = self._stack_generation_owner()
        self._stack = None
        owner.retire_all()
