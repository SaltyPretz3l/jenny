from __future__ import annotations

import pytest

from sidecar.ai.plugins.runtime_apply import (
    RESOURCE_KINDS,
    PluginRuntimeContractError,
    apply_plugin_runtime,
)
from sidecar.ai.plugins.runtime_registry import PluginRuntimeRegistry


def _snapshot(restricted: list[dict[str, object]]) -> dict[str, object]:
    return {
        "kind": "plugin_runtime_snapshot",
        "runtime_schema_version": 4,
        "registry_revision": 6,
        "dependency_graph_hash": "a" * 64,
        "commit_epoch": 6,
        "active_generation_id": "gen-restricted-retired",
        "declarative_content": [],
        "remote_mcp_bindings": [],
        "restricted_contributions": restricted,
    }


def _apply(snapshot: dict[str, object]):
    resources = {kind: object() for kind in RESOURCE_KINDS}
    registry = PluginRuntimeRegistry()
    publication = apply_plugin_runtime(
        registry,
        snapshot=snapshot,
        declarative_content=[],
        resource_provider=lambda: resources,
    )
    return registry, publication


def test_v4_snapshot_with_no_restricted_contributions_still_applies() -> None:
    registry, publication = _apply(_snapshot([]))
    with registry.lease(publication.generation.authority):
        assert not registry.build_turn_tool_descriptors()


def test_v4_snapshot_with_a_restricted_contribution_is_refused() -> None:
    row = {
        "publisher_id": "acme-labs",
        "plugin_id": "restricted-tools",
        "contribution_id": "compute",
        "kind": "restricted_compute",
        "artifact_digest": "1" * 64,
        "content_digest": "2" * 64,
        "component_digest": "3" * 64,
        "abi_digest": "4" * 64,
        "timeout_ms": 1000,
    }
    with pytest.raises(PluginRuntimeContractError, match="runtime_surface_not_supported"):
        _apply(_snapshot([row]))
