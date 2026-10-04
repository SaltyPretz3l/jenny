"""Transactional V6 candidate publication; prepare is deliberately invisible."""

from __future__ import annotations

import hashlib
import json
import time
from collections import OrderedDict
from dataclasses import dataclass, replace
from typing import Any

from sidecar.ai.plugins.runtime_registry import (
    PluginRuntimeGeneration,
    PluginRuntimeRegistry,
)

MAX_CANDIDATES = 4
CANDIDATE_TTL_SECONDS = 60.0


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
        # Frozen wire value: the attested participant set predates the retirement.
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


# The privileged tier (full host, native MCP, session providers, engine adapters,
# hooks) is retired. The host still sends the frozen V6 snapshot shape with these
# arrays empty; a non-empty one is refused rather than ignored.
PRIVILEGED_ARRAYS: tuple[str, ...] = (
    "full_host_descriptors",
    "native_mcp_bindings",
    "session_providers",
    "engine_adapters",
    "hook_descriptors",
    "containment_profiles",
)


def build_generation_v6(
    snapshot: dict[str, Any], content_envelope: object
) -> PluginRuntimeGeneration:
    """Build V6 as V5: every privileged array must be empty."""
    from sidecar.ai.plugins.runtime_apply import (
        _contract_rejection,
        build_generation_v5,
    )

    if any(snapshot[field] for field in PRIVILEGED_ARRAYS):
        raise _contract_rejection("runtime_privileged_descriptor_unsupported")
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
    return replace(base, expected_rejections_digest=_digest(snapshot["expected_rejections"]))
