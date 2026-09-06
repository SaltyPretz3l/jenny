"""Validated plugin-runtime generations with ContextVar-backed turn leases."""

from __future__ import annotations

import re
from collections import OrderedDict
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from threading import RLock
from typing import Any, Final, Literal, cast

from sidecar.ai.context.builder_plugins import (
    PluginContextItem,
    build_plugin_system_overlays,
)
from sidecar.ai.error_codes import (
    CMP_CHAT_INVALID_PARAMS,
    CMP_PLUGIN_EXPECTED_GENERATION_CONFLICT,
    CMP_PLUGIN_LEASE_BUSY,
)
from sidecar.ai.plugins.generated_plugin_contracts import validate
from sidecar.ai.plugins.runtime_privileged import (
    PluginEngineBinding,
    PluginNativeToolDescriptor,
)

MAX_UNLEASED_GENERATIONS: Final[int] = 4
MAX_SAFE_INTEGER: Final[int] = 9_007_199_254_740_991
_HASH_RE: Final[re.Pattern[str]] = re.compile(r"^[0-9a-f]{64}$")
_GENERATION_ID_RE: Final[re.Pattern[str]] = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_REASON_RE: Final[re.Pattern[str]] = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


@dataclass(frozen=True, slots=True)
class PluginRuntimeAuthority:
    registry_revision: int
    dependency_graph_hash: str
    commit_epoch: int
    active_generation_id: str


@dataclass(frozen=True, slots=True)
class PluginRuntimeGeneration:
    authority: PluginRuntimeAuthority
    sidecar_plugin_generation: str
    contributions: tuple[PluginContextItem, ...]
    declarative: tuple["PluginDeclarativeContribution", ...] = ()
    settings: tuple["PluginSettingsRecord", ...] = ()
    workflow_tool_bindings: tuple["PluginWorkflowToolBinding", ...] = ()
    remote_tools: tuple["PluginRemoteToolDescriptor", ...] = ()
    providers: tuple["PluginProviderDescriptor", ...] = ()
    native_tools: tuple["PluginNativeToolDescriptor", ...] = ()
    engine_bindings: tuple["PluginEngineBinding", ...] = ()
    expected_rejections_digest: str = (
        "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
    )


@dataclass(frozen=True, slots=True)
class PluginDeclarativeContribution:
    publisher_id: str
    plugin_id: str
    contribution_id: str
    kind: str
    content_digest: str
    payload: dict[str, Any]


@dataclass(frozen=True, slots=True)
class PluginSettingsRecord:
    publisher_id: str
    plugin_id: str
    contribution_id: str
    schema_digest: str
    revision: int
    values: tuple[tuple[str, str, object], ...]


@dataclass(frozen=True, slots=True)
class PluginWorkflowToolBinding:
    publisher_id: str
    plugin_id: str
    workflow_id: str
    node_id: str
    tool_id: str
    manifest_version: int
    descriptor_sha256: str


@dataclass(frozen=True, slots=True)
class PluginRemoteToolDescriptor:
    name: str
    description: str
    input_schema: dict[str, Any]
    side_effecting: bool = True
    server_name: str = "electron_tool_bridge"
    source_kind: str = "mcp"
    tool_family: str = "other"
    server_tool_name: str = ""


@dataclass(frozen=True, slots=True)
class PluginProviderDescriptor:
    provider_id: str
    engine_type: str
    descriptor_digest: str
    descriptor: dict[str, Any]


@dataclass(frozen=True, slots=True)
class PluginProviderBinding:
    authority: PluginRuntimeAuthority
    provider_id: str
    descriptor_digest: str
    descriptor: dict[str, Any]


@dataclass(frozen=True, slots=True)
class PluginCommandResolution:
    generation: PluginRuntimeGeneration
    command: PluginDeclarativeContribution
    target: PluginDeclarativeContribution
    inputs: tuple[tuple[str, str, object], ...]


class PluginAuthorityMismatchError(RuntimeError):
    """Raised before turn registration when requested authority is not current."""


class PluginRuntimeFencedError(RuntimeError):
    """Raised when a mutation fence blocks a new plugin-influenced admission."""


class PluginRuntimePublicationError(ValueError):
    def __init__(self, reason_code: str) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code


class PluginRuntimeAdmissionError(ValueError):
    def __init__(self, code: str, reason_code: str, *, retryable: bool) -> None:
        super().__init__(reason_code)
        self.code = code
        self.reason_code = reason_code
        self.retryable = retryable


def _normalize_command_inputs(
    command: PluginDeclarativeContribution,
    supplied_rows: list[dict[str, Any]],
) -> tuple[tuple[str, str, object], ...]:
    supplied = {str(item["key"]): item for item in supplied_rows}
    normalized: list[tuple[str, str, object]] = []
    for field in cast(list[dict[str, Any]], command.payload["inputs"]):
        key = str(field["key"])
        item = supplied.pop(key, None)
        expected = "string" if field["type"] == "enum" else str(field["type"])
        if item is None:
            normalized.append((key, expected, field["default"]))
            continue
        if item["type"] != expected:
            raise PluginAuthorityMismatchError("plugin command input type changed")
        value = item["value"]
        if field["type"] == "integer" and not field["minimum"] <= value <= field["maximum"]:
            raise PluginAuthorityMismatchError("plugin command input is out of range")
        if field["type"] == "string" and len(value.encode("utf-8")) > field["max_length"]:
            raise PluginAuthorityMismatchError("plugin command input is too long")
        if field["type"] == "enum" and value not in field["values"]:
            raise PluginAuthorityMismatchError("plugin command input is not permitted")
        normalized.append((key, expected, value))
    if supplied:
        raise PluginAuthorityMismatchError("plugin command input is unknown")
    return tuple(normalized)


class PluginTurnPin:
    """Thread-transferable immutable generation reference with explicit release."""

    def __init__(
        self,
        registry: PluginRuntimeRegistry,
        generation: PluginRuntimeGeneration,
    ) -> None:
        self._registry = registry
        self.generation = generation
        self._released = False

    @contextmanager
    def bind(self) -> Iterator[PluginRuntimeGeneration]:
        if self._released:
            raise RuntimeError("plugin turn pin was released")
        token = self._registry._active_lease.set(self.generation)
        try:
            yield self.generation
        finally:
            self._registry._active_lease.reset(token)

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        self._registry._release_pin(self.generation.authority)


class PluginRuntimeRegistry:
    """Module-owned registry; publications never mutate a leased generation."""

    def __init__(
        self,
        *,
        event_sink: Callable[[str, dict[str, object]], None] | None = None,
    ) -> None:
        self._lock = RLock()
        self._generations: OrderedDict[
            PluginRuntimeAuthority, PluginRuntimeGeneration
        ] = OrderedDict()
        self._lease_counts: dict[PluginRuntimeAuthority, int] = {}
        self._workflow_cancellations: dict[
            PluginRuntimeAuthority, dict[int, Callable[[], None]]
        ] = {}
        self._workflow_cancellation_sequence = 0
        self._current: PluginRuntimeAuthority | None = None
        self._fence_reason: str | None = None
        self._active_lease: ContextVar[PluginRuntimeGeneration | None] = ContextVar(
            f"plugin_runtime_lease_{id(self)}",
            default=None,
        )
        self._event_sink = event_sink

    def current_provider_binding(self, provider_id: str) -> PluginProviderBinding | None:
        with self._lock:
            generation = self._generations.get(self._current) if self._current else None
            if generation is None:
                return None
            for provider in generation.providers:
                if provider.provider_id == provider_id:
                    return PluginProviderBinding(
                        authority=generation.authority,
                        provider_id=provider.provider_id,
                        descriptor_digest=provider.descriptor_digest,
                        descriptor=dict(provider.descriptor),
                    )
        return None

    def is_provider_binding_current(self, binding: PluginProviderBinding) -> bool:
        with self._lock:
            if self._current != binding.authority:
                return False
            generation = self._generations.get(self._current)
            if generation is None:
                return False
            return any(
                provider.provider_id == binding.provider_id
                and provider.descriptor_digest == binding.descriptor_digest
                for provider in generation.providers
            )

    def _emit(self, event: str, data: dict[str, object]) -> None:
        if self._event_sink is not None:
            try:
                self._event_sink(event, data)
            except Exception:
                # Observability cannot mutate publication/fence authority.
                return

    def fence(self, reason: str) -> None:
        bounded_reason = reason if _REASON_RE.fullmatch(reason or "") else "mutation"
        with self._lock:
            self._fence_reason = bounded_reason
        self._emit("plugin.runtime.fence_start", {"reason_code": bounded_reason})

    def unfence(self) -> None:
        with self._lock:
            prior = self._fence_reason
            self._fence_reason = None
        self._emit("plugin.runtime.fence_end", {"reason_code": prior or "none"})

    def publish(self, generation: PluginRuntimeGeneration) -> PluginRuntimeGeneration:
        cancellations: tuple[Callable[[], None], ...] = ()
        with self._lock:
            current = self._current
            retained = self._generations.get(generation.authority)
            if retained is not None and retained != generation:
                raise PluginRuntimePublicationError("runtime_authority_reused")
            if current is not None:
                if generation.authority == current:
                    if retained is None:
                        raise PluginRuntimePublicationError("current_runtime_unavailable")
                    return retained
                if generation.authority.commit_epoch <= current.commit_epoch:
                    raise PluginRuntimePublicationError("runtime_commit_epoch_regression")
                if generation.authority.registry_revision <= current.registry_revision:
                    raise PluginRuntimePublicationError("runtime_registry_revision_regression")
            if retained is not None:
                self._current = retained.authority
                self._generations.move_to_end(retained.authority)
                self._evict_unleased_locked()
                cancellations = self._take_workflow_cancellations_locked(current)
                published = retained
            else:
                self._generations[generation.authority] = generation
                self._generations.move_to_end(generation.authority)
                self._current = generation.authority
                self._evict_unleased_locked()
                cancellations = self._take_workflow_cancellations_locked(current)
                published = generation
        self._cancel_workflows(cancellations)
        return published

    def _take_workflow_cancellations_locked(
        self, authority: PluginRuntimeAuthority | None
    ) -> tuple[Callable[[], None], ...]:
        if authority is None:
            return ()
        return tuple(self._workflow_cancellations.pop(authority, {}).values())

    def _cancel_workflows(self, callbacks: tuple[Callable[[], None], ...]) -> None:
        for callback in callbacks:
            try:
                callback()
            except Exception:
                self._emit(
                    "plugin.runtime.workflow_cancel_failed",
                    {"reason_code": "generation_withdrawn"},
                )

    def register_workflow_cancellation(
        self,
        authority: PluginRuntimeAuthority,
        callback: Callable[[], None],
    ) -> Callable[[], None]:
        """Cancel only workflow turns when their immutable generation is withdrawn."""
        with self._lock:
            if authority != self._current:
                raise PluginAuthorityMismatchError("plugin workflow authority is stale")
            self._workflow_cancellation_sequence += 1
            token = self._workflow_cancellation_sequence
            self._workflow_cancellations.setdefault(authority, {})[token] = callback

        def unregister() -> None:
            with self._lock:
                callbacks = self._workflow_cancellations.get(authority)
                if callbacks is None:
                    return
                callbacks.pop(token, None)
                if not callbacks:
                    self._workflow_cancellations.pop(authority, None)

        return unregister

    def _evict_unleased_locked(self) -> None:
        candidates = [
            authority
            for authority in self._generations
            if authority != self._current and self._lease_counts.get(authority, 0) == 0
        ]
        while len(candidates) > MAX_UNLEASED_GENERATIONS:
            evicted = candidates.pop(0)
            self._generations.pop(evicted, None)
            self._emit(
                "plugin.runtime.generation_evicted",
                {
                    "registry_revision": evicted.registry_revision,
                    "commit_epoch": evicted.commit_epoch,
                    "active_generation_id": evicted.active_generation_id,
                },
            )

    def acquire_pin(self, authority: PluginRuntimeAuthority) -> PluginTurnPin:
        with self._lock:
            if self._fence_reason is not None:
                raise PluginRuntimeFencedError(self._fence_reason)
            if authority != self._current:
                raise PluginAuthorityMismatchError("plugin runtime authority is stale")
            generation = self._generations.get(authority)
            if generation is None:
                raise PluginAuthorityMismatchError("plugin runtime generation is unavailable")
            self._lease_counts[authority] = self._lease_counts.get(authority, 0) + 1
        return PluginTurnPin(self, generation)

    def _release_pin(self, authority: PluginRuntimeAuthority) -> None:
        with self._lock:
            remaining = self._lease_counts.get(authority, 1) - 1
            if remaining > 0:
                self._lease_counts[authority] = remaining
            else:
                self._lease_counts.pop(authority, None)
            self._evict_unleased_locked()

    @contextmanager
    def lease(self, authority: PluginRuntimeAuthority) -> Iterator[PluginRuntimeGeneration]:
        pin = self.acquire_pin(authority)
        try:
            with pin.bind() as generation:
                yield generation
        finally:
            pin.release()

    def build_turn_overlays(self) -> tuple[str, ...]:
        generation = self._active_lease.get()
        if generation is None:
            return ()
        overlays, _diagnostics = build_plugin_system_overlays(generation.contributions)
        return overlays

    def build_turn_tool_descriptors(self) -> tuple[PluginRemoteToolDescriptor, ...]:
        generation = self._active_lease.get()
        return generation.remote_tools if generation is not None else ()

    def build_turn_native_tool_descriptors(self) -> tuple[PluginNativeToolDescriptor, ...]:
        generation = self._active_lease.get()
        return generation.native_tools if generation is not None else ()

    def current_engine_binding(self, adapter_id: str) -> PluginEngineBinding | None:
        with self._lock:
            generation = self._generations.get(self._current) if self._current else None
            if generation is None:
                return None
            return next(
                (item for item in generation.engine_bindings if item.adapter_id == adapter_id),
                None,
            )

    def current_engine_ids(self) -> tuple[str, ...]:
        with self._lock:
            generation = self._generations.get(self._current) if self._current else None
            if generation is None:
                return ()
            return tuple(item.adapter_id for item in generation.engine_bindings)

    def is_engine_binding_current(self, binding: PluginEngineBinding) -> bool:
        with self._lock:
            generation = self._generations.get(self._current) if self._current else None
            return generation is not None and binding in generation.engine_bindings

    def resolve_command(self, raw_invocation: object) -> PluginCommandResolution:
        generation = self._active_lease.get()
        if generation is None:
            raise PluginAuthorityMismatchError("plugin runtime lease is unavailable")
        verdict = validate("PluginCommandInvocationV2", raw_invocation)
        if verdict.get("ok") is not True or not isinstance(verdict.get("value"), dict):
            raise PluginAuthorityMismatchError("plugin command invocation is invalid")
        value = cast(dict[str, Any], verdict["value"])
        if (
            value["observed_generation_id"] != generation.authority.active_generation_id
            or value["observed_registry_revision"] != generation.authority.registry_revision
        ):
            raise PluginAuthorityMismatchError("plugin command authority is stale")
        identity = (value["publisher_id"], value["plugin_id"], value["command_id"])
        command = next((item for item in generation.declarative if (
            item.publisher_id, item.plugin_id, item.contribution_id
        ) == identity and item.kind == "command"), None)
        if command is None:
            raise PluginAuthorityMismatchError("plugin command is unavailable")
        target_id = str(command.payload["target_contribution_id"])
        target_kind = str(command.payload["target_kind"])
        target = next((item for item in generation.declarative if (
            item.publisher_id == command.publisher_id
            and item.plugin_id == command.plugin_id
            and item.contribution_id == target_id
            and item.kind == target_kind
        )), None)
        if target is None:
            raise PluginAuthorityMismatchError("plugin command target is unavailable")
        normalized = _normalize_command_inputs(
            command, cast(list[dict[str, Any]], value["inputs"])
        )
        return PluginCommandResolution(generation, command, target, normalized)


@dataclass(frozen=True, slots=True)
class PluginRuntimeAdmission:
    mode: Literal["core_only", "plugin"]
    authority: PluginRuntimeAuthority | None = None
    pin: PluginTurnPin | None = None

    @contextmanager
    def bind(self) -> Iterator[PluginRuntimeGeneration | None]:
        if self.pin is None:
            yield None
            return
        with self.pin.bind() as generation:
            yield generation

    def release(self) -> None:
        if self.pin is not None:
            self.pin.release()


def _parse_authority_value(raw: object) -> PluginRuntimeAuthority:
    if not isinstance(raw, dict):
        raise PluginRuntimeAdmissionError(
            CMP_CHAT_INVALID_PARAMS, "plugin_authority_invalid", retryable=False
        )
    expected_keys = {
        "mode",
        "registry_revision",
        "dependency_graph_hash",
        "commit_epoch",
        "active_generation_id",
    }
    revision = raw.get("registry_revision")
    epoch = raw.get("commit_epoch")
    if (
        set(raw) != expected_keys
        or raw.get("mode") != "plugin"
        or isinstance(revision, bool)
        or not isinstance(revision, int)
        or not 0 <= revision <= MAX_SAFE_INTEGER
        or isinstance(epoch, bool)
        or not isinstance(epoch, int)
        or not 0 <= epoch <= MAX_SAFE_INTEGER
        or not isinstance(raw.get("dependency_graph_hash"), str)
        or _HASH_RE.fullmatch(cast(str, raw["dependency_graph_hash"])) is None
        or not isinstance(raw.get("active_generation_id"), str)
        or _GENERATION_ID_RE.fullmatch(cast(str, raw["active_generation_id"])) is None
    ):
        raise PluginRuntimeAdmissionError(
            CMP_CHAT_INVALID_PARAMS, "plugin_authority_invalid", retryable=False
        )
    return PluginRuntimeAuthority(
        registry_revision=revision,
        dependency_graph_hash=cast(str, raw["dependency_graph_hash"]),
        commit_epoch=epoch,
        active_generation_id=cast(str, raw["active_generation_id"]),
    )


def admit_plugin_runtime(
    registry: PluginRuntimeRegistry,
    raw_authority: object | None,
) -> PluginRuntimeAdmission:
    """Validate and pin plugin authority before any turn registration or output."""
    if raw_authority is None or raw_authority == {"mode": "core_only"}:
        return PluginRuntimeAdmission(mode="core_only")
    authority = _parse_authority_value(raw_authority)
    try:
        pin = registry.acquire_pin(authority)
    except PluginRuntimeFencedError as error:
        raise PluginRuntimeAdmissionError(
            CMP_PLUGIN_LEASE_BUSY,
            "plugin_runtime_fenced",
            retryable=True,
        ) from error
    except PluginAuthorityMismatchError as error:
        raise PluginRuntimeAdmissionError(
            CMP_PLUGIN_EXPECTED_GENERATION_CONFLICT,
            "plugin_runtime_authority_mismatch",
            retryable=True,
        ) from error
    return PluginRuntimeAdmission(mode="plugin", authority=authority, pin=pin)
