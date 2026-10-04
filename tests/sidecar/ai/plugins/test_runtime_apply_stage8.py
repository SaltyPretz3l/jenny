from __future__ import annotations

import hashlib

import pytest

from sidecar.ai.plugins.generated_plugin_contracts import validate
from sidecar.ai.plugins.runtime_apply_stage8 import PluginRuntimeApplyStage8
from sidecar.ai.plugins.runtime_registry import (
    PluginAuthorityMismatchError,
    PluginRuntimeAuthority,
    PluginRuntimeGeneration,
    PluginRuntimeRegistry,
)


def generation(identifier: str = "gen-1", epoch: int = 1) -> PluginRuntimeGeneration:
    authority = PluginRuntimeAuthority(
        registry_revision=epoch,
        dependency_graph_hash=str(epoch) * 64,
        commit_epoch=epoch,
        active_generation_id=identifier,
    )
    return PluginRuntimeGeneration(
        authority=authority,
        sidecar_plugin_generation=f"sidecar-{epoch:032x}",
        contributions=(),
    )


def test_prepare_is_invisible_abort_is_idempotent_and_commit_is_atomic() -> None:
    registry = PluginRuntimeRegistry()
    apply = PluginRuntimeApplyStage8(registry)
    candidate = generation()
    prepared = apply.prepare(candidate)
    assert prepared["ok"] is True
    assert prepared["attestation"]["applied"] is False
    assert validate("PluginRuntimeAttestationV6", prepared["attestation"])["ok"] is True
    assert prepared["attestation"]["sidecar_plugin_generation"] == hashlib.sha256(
        candidate.sidecar_plugin_generation.encode("utf-8")
    ).hexdigest()
    with pytest.raises(PluginAuthorityMismatchError):
        with registry.lease(candidate.authority):
            pass
    assert apply.abort("gen-1") == {"ok": True}
    assert apply.abort("gen-1") == {"ok": True}
    apply.prepare(candidate)
    committed = apply.commit("gen-1")
    assert committed["ok"] is True
    assert committed["attestation"]["applied"] is True
    assert committed["attestation"]["active_generation_id"] == "gen-1"
    with registry.lease(candidate.authority) as leased:
        assert leased is candidate


def test_candidate_map_is_bounded_and_reconcile_projects_committed_generation() -> None:
    registry = PluginRuntimeRegistry()
    apply = PluginRuntimeApplyStage8(registry)
    for index in range(1, 7):
        apply.prepare(generation(f"gen-{index}", index))
    assert apply.commit("gen-1") == {"ok": False, "reason": "runtime_candidate_missing"}
    result = apply.reconcile(generation("gen-6", 6))
    assert result["ok"] is True
    apply.close()
