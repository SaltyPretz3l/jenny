from __future__ import annotations

import hashlib
from typing import Any

import pytest

from sidecar.ai.plugins.generated_plugin_contracts import validate
from sidecar.ai.plugins.runtime_apply_stage8 import PluginRuntimeApplyStage8, build_generation_v6
from sidecar.ai.plugins.runtime_contracts import PluginRuntimeContractError
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


def native_tool_snapshot(
    *,
    publisher_id: str = "publisher",
    schema_json: str = '{"type":"object"}',
    side_effecting: bool = False,
) -> dict[str, Any]:
    return {
        "registry_revision": 1,
        "dependency_graph_hash": "1" * 64,
        "commit_epoch": 1,
        "active_generation_id": "gen_1",
        "declarative_content": [],
        "remote_mcp_bindings": [],
        "restricted_contributions": [],
        "view_contributions": [],
        "provider_descriptors": [],
        "native_mcp_bindings": [
            {
                "binding_digest": "2" * 64,
                "publisher_id": publisher_id,
                "plugin_id": "plugin",
                "contribution_id": "native",
                "tools": [
                    {
                        "namespaced_name": f"plugin:{publisher_id}:plugin:native:tool",
                        "description": "description",
                        "schema_json": schema_json,
                        "schema_digest": hashlib.sha256(schema_json.encode("utf-8")).hexdigest(),
                        "side_effecting": side_effecting,
                        "remote_name": "tool",
                    }
                ],
            }
        ],
        "engine_adapters": [],
        "expected_rejections": [],
    }


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


@pytest.mark.parametrize(
    "schema_json",
    ['{"type":"object","type":"string"}', '{"minimum":NaN}'],
)
def test_native_tool_schema_rejects_ambiguous_json(schema_json: str) -> None:
    snapshot = native_tool_snapshot(schema_json=schema_json)

    with pytest.raises(PluginRuntimeContractError) as raised:
        build_generation_v6(snapshot, [])

    assert raised.value.reason_code == "runtime_native_schema_invalid"


@pytest.mark.parametrize(
    ("publisher_id", "declared", "expected"),
    [
        ("jenny-official", False, False),
        ("third-party", False, True),
        ("jenny-official", True, True),
        ("third-party", True, True),
    ],
)
def test_native_tool_side_effect_declarations_only_trust_first_party(
    publisher_id: str,
    declared: bool,
    expected: bool,
) -> None:
    runtime_generation = build_generation_v6(
        native_tool_snapshot(publisher_id=publisher_id, side_effecting=declared),
        [],
    )

    assert runtime_generation.native_tools[0].side_effecting is expected
