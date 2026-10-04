from __future__ import annotations

import importlib.util
from typing import Any

import pytest

from sidecar.ai.plugins.runtime_apply import build_plugin_runtime
from sidecar.ai.plugins.runtime_apply_stage8 import PluginRuntimeApplyStage8, build_generation_v6
from sidecar.ai.plugins.runtime_contracts import PluginRuntimeContractError
from sidecar.ai.plugins.runtime_registry import PluginRuntimeRegistry

PRIVILEGED_ARRAYS = (
    "full_host_descriptors",
    "native_mcp_bindings",
    "session_providers",
    "engine_adapters",
    "hook_descriptors",
    "containment_profiles",
)


def _v6(**overrides: Any) -> dict[str, Any]:
    snapshot: dict[str, Any] = {
        "kind": "plugin_runtime_snapshot",
        "runtime_schema_version": 6,
        "registry_revision": 1,
        "dependency_graph_hash": "1" * 64,
        "commit_epoch": 1,
        "active_generation_id": "gen_1",
        "declarative_content": [],
        "remote_mcp_bindings": [],
        "restricted_contributions": [],
        "view_contributions": [],
        "provider_descriptors": [],
        "expected_rejections": [],
    }
    for field in PRIVILEGED_ARRAYS:
        snapshot[field] = []
    snapshot.update(overrides)
    return snapshot


def _resources() -> dict[str, object]:
    return {kind: object() for kind in ("engine", "model", "memory", "mcp", "monitor", "tool")}


def test_privileged_descriptor_module_is_retired() -> None:
    assert importlib.util.find_spec("sidecar.ai.plugins.runtime_privileged") is None


def test_v6_snapshot_with_empty_privileged_arrays_still_applies_transactionally() -> None:
    resources = _resources()
    generation = build_plugin_runtime(
        snapshot=_v6(), declarative_content=[], resource_provider=lambda: resources
    )
    assert generation.contributions == ()
    assert generation.sidecar_plugin_generation.startswith("sidecar-")
    assert not hasattr(generation, "native_tools")
    assert not hasattr(generation, "engine_bindings")

    registry = PluginRuntimeRegistry()
    apply = PluginRuntimeApplyStage8(registry)
    prepared = apply.prepare(generation)
    assert prepared["ok"] is True
    assert prepared["attestation"]["applied"] is False
    committed = apply.commit("gen_1")
    assert committed["ok"] is True
    assert committed["attestation"]["applied"] is True
    with registry.lease(generation.authority) as leased:
        assert leased is generation
    assert apply.abort("gen_1") == {"ok": True}
    assert apply.reconcile(generation)["ok"] is True


def test_v6_fingerprint_matches_the_v5_projection_of_the_same_snapshot() -> None:
    resources = _resources()
    v6 = build_plugin_runtime(snapshot=_v6(), declarative_content=[], resource_provider=lambda: resources)
    v5_snapshot = {
        key: value for key, value in _v6().items()
        if key not in {*PRIVILEGED_ARRAYS, "expected_rejections"}
    }
    v5_snapshot["runtime_schema_version"] = 5
    v5 = build_plugin_runtime(
        snapshot=v5_snapshot, declarative_content=[], resource_provider=lambda: resources
    )
    assert v6.sidecar_plugin_generation == v5.sidecar_plugin_generation


@pytest.mark.parametrize("field", PRIVILEGED_ARRAYS)
def test_v6_snapshot_with_privileged_rows_is_refused(field: str) -> None:
    snapshot = _v6(**{field: [{"contribution_id": "row"}]})
    with pytest.raises(PluginRuntimeContractError) as raised:
        build_generation_v6(snapshot, [])
    assert raised.value.reason_code == "runtime_privileged_descriptor_unsupported"
