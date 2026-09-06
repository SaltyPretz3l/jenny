"""Transactional V6 candidate publication; prepare is deliberately invisible."""

from __future__ import annotations

import hashlib
import json
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, cast

from sidecar.ai.plugins.runtime_registry import (
    PluginEngineBinding,
    PluginNativeToolDescriptor,
    PluginRuntimeGeneration,
    PluginRuntimeRegistry,
)

MAX_CANDIDATES = 4
CANDIDATE_TTL_SECONDS = 60.0
# Self-declared side_effecting is honored only for first-party/signed publishers.
# All other native tools are forced side-effecting so read-only and plan mode fail
# closed (H3, PLAN_MODE_V2_SPEC).
TRUSTED_SIDE_EFFECT_PUBLISHERS: frozenset[str] = frozenset({"jenny-official"})


def _digest(value: object) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


@dataclass(slots=True)
class _Candidate:
    generation: PluginRuntimeGeneration
    created_at: float


class PluginRuntimeApplyStage8:
    def __init__(self, registry: PluginRuntimeRegistry, *, monotonic=time.monotonic) -> None:
        self._registry = registry
        self._monotonic = monotonic
        self._candidates: OrderedDict[str, _Candidate] = OrderedDict()

    def _attestation(
        self, generation: PluginRuntimeGeneration, *, applied: bool
    ) -> dict[str, object]:
        authority = generation.authority
        participants = ["sidecar", "native_mcp", "engine_adapter"]
        authority_tuple = [
            authority.registry_revision,
            authority.dependency_graph_hash,
            authority.commit_epoch,
            authority.active_generation_id,
        ]
        return {
            "attestation_schema_version": 6,
            "registry_revision": authority.registry_revision,
            "dependency_graph_hash": authority.dependency_graph_hash,
            "commit_epoch": authority.commit_epoch,
            "active_generation_id": authority.active_generation_id,
            # The frozen V6 wire contract carries a digest, while the registry's
            # V1-V5-compatible generation identifier remains `sidecar-<id>`.
            # Never leak that internal identifier into the sha256_hex field.
            "sidecar_plugin_generation": hashlib.sha256(
                generation.sidecar_plugin_generation.encode("utf-8")
            ).hexdigest(),
            "electron_runtime_generation": _digest({"authority": authority_tuple}),
            "participant_set_digest": _digest(participants),
            "expected_rejections_digest": generation.expected_rejections_digest,
            "applied": applied,
        }

    def _expire(self) -> None:
        now = self._monotonic()
        for key in list(self._candidates):
            if now - self._candidates[key].created_at > CANDIDATE_TTL_SECONDS:
                self._candidates.pop(key, None)

    def prepare(self, generation: PluginRuntimeGeneration) -> dict[str, object]:
        self._expire()
        key = generation.authority.active_generation_id
        self._candidates[key] = _Candidate(generation, self._monotonic())
        self._candidates.move_to_end(key)
        while len(self._candidates) > MAX_CANDIDATES:
            self._candidates.popitem(last=False)
        return {"ok": True, "attestation": self._attestation(generation, applied=False)}

    def commit(self, generation_id: str) -> dict[str, object]:
        self._expire()
        candidate = self._candidates.pop(generation_id, None)
        if candidate is None:
            return {"ok": False, "reason": "runtime_candidate_missing"}
        published = self._registry.publish(candidate.generation)
        return {"ok": True, "attestation": self._attestation(published, applied=True)}

    def abort(self, generation_id: str) -> dict[str, object]:
        self._candidates.pop(generation_id, None)
        return {"ok": True}

    def reconcile(self, generation: PluginRuntimeGeneration) -> dict[str, object]:
        published = self._registry.publish(generation)
        return {"ok": True, "attestation": self._attestation(published, applied=True)}

    def close(self) -> None:
        self._candidates.clear()


def build_generation_v6(
    snapshot: dict[str, Any], content_envelope: object
) -> PluginRuntimeGeneration:
    """Build V6 by extending the frozen V5 projection with privileged bindings."""
    from sidecar.ai.plugins.runtime_apply import (  # noqa: PLC0415
        _contract_rejection,
        _generation_id,
        _reject_duplicate_keys,
        _reject_json_constant,
    )
    from sidecar.ai.plugins.runtime_apply_stage7 import (  # noqa: PLC0415
        build_generation_v5,
    )

    legacy_snapshot = {
        "kind": "plugin_runtime_snapshot",
        "runtime_schema_version": 5,
        "registry_revision": snapshot["registry_revision"],
        "dependency_graph_hash": snapshot["dependency_graph_hash"],
        "commit_epoch": snapshot["commit_epoch"],
        "active_generation_id": snapshot["active_generation_id"],
        "declarative_content": snapshot["declarative_content"],
        "remote_mcp_bindings": snapshot["remote_mcp_bindings"],
        "restricted_contributions": snapshot["restricted_contributions"],
        "view_contributions": snapshot["view_contributions"],
        "provider_descriptors": snapshot["provider_descriptors"],
    }
    base = build_generation_v5(legacy_snapshot, content_envelope)

    native_tools: list[PluginNativeToolDescriptor] = []
    for binding in cast(list[dict[str, Any]], snapshot["native_mcp_bindings"]):
        binding_publisher = cast(str, binding["publisher_id"])
        for tool in cast(list[dict[str, Any]], binding["tools"]):
            schema_json = cast(str, tool["schema_json"])
            if hashlib.sha256(schema_json.encode("utf-8")).hexdigest() != tool["schema_digest"]:
                raise _contract_rejection(
                    "runtime_native_schema_digest_mismatch",
                    cast(str, binding["contribution_id"]),
                )
            try:
                input_schema = json.loads(
                    schema_json,
                    object_pairs_hook=_reject_duplicate_keys,
                    parse_constant=_reject_json_constant,
                )
            except (TypeError, ValueError) as error:
                raise _contract_rejection(
                    "runtime_native_schema_invalid",
                    cast(str, binding["contribution_id"]),
                ) from error
            if not isinstance(input_schema, dict):
                raise _contract_rejection("runtime_native_schema_invalid")
            declared = cast(bool, tool["side_effecting"])
            side_effecting = (
                declared if binding_publisher in TRUSTED_SIDE_EFFECT_PUBLISHERS else True
            )
            native_tools.append(PluginNativeToolDescriptor(
                name=cast(str, tool["namespaced_name"]),
                description=cast(str, tool["description"]),
                input_schema=input_schema,
                binding_digest=cast(str, binding["binding_digest"]),
                publisher_id=binding_publisher,
                plugin_id=cast(str, binding["plugin_id"]),
                contribution_id=cast(str, binding["contribution_id"]),
                side_effecting=side_effecting,
                server_tool_name=cast(str, tool["remote_name"]),
            ))
    native_tuple = tuple(sorted(native_tools, key=lambda item: item.name.encode("utf-8")))
    if len({item.name for item in native_tuple}) != len(native_tuple):
        raise _contract_rejection("runtime_native_tool_duplicate")

    engines = tuple(sorted((
        PluginEngineBinding(
            authority=base.authority,
            adapter_id=cast(str, row["adapter_id"]),
            binding_digest=cast(str, row["binding_digest"]),
            descriptor=dict(row),
        )
        for row in cast(list[dict[str, Any]], snapshot["engine_adapters"])
    ), key=lambda item: item.adapter_id.encode("utf-8")))
    if len({item.adapter_id for item in engines}) != len(engines):
        raise _contract_rejection("runtime_engine_adapter_duplicate")

    return PluginRuntimeGeneration(
        authority=base.authority,
        sidecar_plugin_generation=_generation_id(
            base.authority,
            list(base.contributions),
            base.declarative,
            base.settings,
            base.workflow_tool_bindings,
            base.remote_tools,
            base.providers,
            native_tuple,
            engines,
        ),
        contributions=base.contributions,
        declarative=base.declarative,
        settings=base.settings,
        workflow_tool_bindings=base.workflow_tool_bindings,
        remote_tools=base.remote_tools,
        providers=base.providers,
        native_tools=native_tuple,
        engine_bindings=engines,
        expected_rejections_digest=_digest(snapshot["expected_rejections"]),
    )
