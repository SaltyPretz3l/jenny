from __future__ import annotations

import importlib.util
from typing import Any

import pytest

from sidecar.ai.plugins.runtime_apply import build_plugin_runtime
from sidecar.ai.plugins.runtime_contracts import PluginRuntimeContractError


def _v5(provider_rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "kind": "plugin_runtime_snapshot",
        "runtime_schema_version": 5,
        "registry_revision": 1,
        "dependency_graph_hash": "1" * 64,
        "commit_epoch": 1,
        "active_generation_id": "gen_1",
        "declarative_content": [],
        "remote_mcp_bindings": [],
        "restricted_contributions": [],
        "view_contributions": [],
        "provider_descriptors": provider_rows,
    }


def _resources() -> dict[str, object]:
    return {kind: object() for kind in ("engine", "model", "memory", "mcp", "monitor", "tool")}


def test_stage7_provider_builder_module_is_retired() -> None:
    assert importlib.util.find_spec("sidecar.ai.plugins.runtime_apply_stage7") is None


def test_v5_snapshot_without_providers_applies_with_no_provider_rows() -> None:
    resources = _resources()
    generation = build_plugin_runtime(
        snapshot=_v5([]), declarative_content=[], resource_provider=lambda: resources
    )
    assert generation.contributions == ()
    assert generation.sidecar_plugin_generation.startswith("sidecar-")
    # The frozen fingerprint is unchanged by the retirement: an empty provider list
    # hashes exactly like the V4 projection of the same snapshot.
    v4 = {k: v for k, v in _v5([]).items() if k not in {"view_contributions", "provider_descriptors"}}
    v4["runtime_schema_version"] = 4
    legacy = build_plugin_runtime(
        snapshot=v4, declarative_content=[], resource_provider=lambda: resources
    )
    assert legacy.sidecar_plugin_generation == generation.sidecar_plugin_generation


def test_v5_snapshot_with_provider_rows_is_refused() -> None:
    row = {
        "publisher_id": "openai", "plugin_id": "chatgpt_subscription",
        "contribution_id": "provider", "provider_id": "chatgpt", "engine_type": "chatgpt",
        "artifact_digest": "b" * 64, "descriptor_digest": "a" * 64,
    }
    resources = _resources()
    with pytest.raises(PluginRuntimeContractError) as raised:
        build_plugin_runtime(
            snapshot=_v5([row]), declarative_content=[], resource_provider=lambda: resources
        )
    assert raised.value.reason_code == "runtime_provider_descriptor_unsupported"
