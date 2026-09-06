"""Legacy publication and V1 attestation kept separate from compilation."""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from typing import Mapping

from sidecar.ai.error_codes import (
    CMP_PLUGIN_EPOCH_REGRESSION,
    CMP_PLUGIN_EXPECTED_GENERATION_CONFLICT,
    CMP_PLUGIN_OUTCOME_INDETERMINATE,
)
from sidecar.ai.plugins.runtime_contracts import PluginRuntimeContractError, validated_contract
from sidecar.ai.plugins.runtime_registry import (
    PluginRuntimeGeneration,
    PluginRuntimePublicationError,
    PluginRuntimeRegistry,
)

RESOURCE_KINDS = ("engine", "model", "memory", "mcp", "monitor", "tool")
_RESOURCE_PROOF_SALT = secrets.token_bytes(32)


@dataclass(frozen=True, slots=True)
class PluginRuntimePublication:
    generation: PluginRuntimeGeneration
    attestation: dict[str, object]


def _resource_proofs(resources: Mapping[str, object]) -> list[dict[str, object]]:
    proofs: list[dict[str, object]] = []
    for kind in RESOURCE_KINDS:
        resource = resources[kind]
        digest = hashlib.sha256()
        digest.update(_RESOURCE_PROOF_SALT)
        digest.update(kind.encode("ascii"))
        digest.update(id(resource).to_bytes(16, "big", signed=False))
        digest.update(
            f"{type(resource).__module__}.{type(resource).__qualname__}".encode("utf-8")
        )
        proofs.append(
            {
                "resource_kind": kind,
                "resource_id": f"{kind}-current",
                "digest": digest.hexdigest(),
            }
        )
    return proofs


def publish_plugin_runtime(
    registry: PluginRuntimeRegistry,
    generation: PluginRuntimeGeneration,
    resources: Mapping[str, object],
) -> PluginRuntimePublication:
    attestation: dict[str, object] = {
        "attestation_schema_version": 1,
        "participant_kind": "sidecar",
        "registry_revision": generation.authority.registry_revision,
        "dependency_graph_hash": generation.authority.dependency_graph_hash,
        "commit_epoch": generation.authority.commit_epoch,
        "sidecar_plugin_generation": generation.sidecar_plugin_generation,
        "reused_resource_proofs": _resource_proofs(resources),
        "rejected_contributions": [],
    }
    validated_attestation = validated_contract(
        "PluginRuntimeAttestationV1", attestation, "runtime_attestation_invalid"
    )
    try:
        published = registry.publish(generation)
    except PluginRuntimePublicationError as error:
        regression_reasons = {
            "runtime_commit_epoch_regression",
            "runtime_registry_revision_regression",
        }
        code = (
            CMP_PLUGIN_EPOCH_REGRESSION
            if error.reason_code in regression_reasons
            else CMP_PLUGIN_EXPECTED_GENERATION_CONFLICT
        )
        raise PluginRuntimeContractError(error.reason_code, code=code) from error
    return PluginRuntimePublication(published, validated_attestation)


__all__ = [
    "CMP_PLUGIN_OUTCOME_INDETERMINATE",
    "PluginRuntimePublication",
    "publish_plugin_runtime",
]
