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
    # Retired slot: plugin workflows no longer exist. Kept (always empty) so the
    # frozen generation fingerprint and the V2-V6 builders stay byte-stable.
    workflow_tool_bindings: tuple[()] = ()
    remote_tools: tuple["PluginRemoteToolDescriptor", ...] = ()
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
class PluginRemoteToolDescriptor:
    name: str
    description: str
    input_schema: dict[str, Any]
    side_effecting: bool = True
    server_name: str = "electron_tool_bridge"
    source_kind: str = "mcp"
    tool_family: str = "other"
    server_tool_name: str = ""
    connection_id: str = ""


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
        self._current: PluginRuntimeAuthority | None = None
        self._fence_reason: str | None = None
        self._active_lease: ContextVar[PluginRuntimeGeneration | None] = ContextVar(
            f"plugin_runtime_lease_{id(self)}",
            default=None,
        )
        self._event_sink = event_sink

    def has_published_generation(self) -> bool:
        """Whether Electron has published any plugin runtime generation yet."""
        with self._lock:
            return self._current is not None and self._current in self._generations

    def _emit(self, event: str, data: dict[str, object]) -> None:
        if self._event_sink is not None:
            try:
                self._event_sink(event, data)
            except Exception:  # noqa: BLE001  # telemetry
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
                published = retained
            else:
                self._generations[generation.authority] = generation
                self._generations.move_to_end(generation.authority)
                self._current = generation.authority
                self._evict_unleased_locked()
                published = generation
        return published

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
