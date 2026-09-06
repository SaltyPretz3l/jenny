from __future__ import annotations

import hashlib
import json

import pytest

from sidecar.ai.plugins.runtime_apply import (
    RESOURCE_KINDS,
    PluginRuntimeContractError,
    apply_plugin_runtime,
)
from sidecar.ai.plugins.runtime_registry import PluginRuntimeRegistry


def _snapshot(schema_json: str, schema_digest: str) -> dict[str, object]:
    return {
        "kind": "plugin_runtime_snapshot",
        "runtime_schema_version": 3,
        "registry_revision": 5,
        "dependency_graph_hash": "a" * 64,
        "commit_epoch": 5,
        "active_generation_id": "gen-stage5",
        "declarative_content": [],
        "remote_mcp_bindings": [{
            "publisher_id": "acme-labs",
            "plugin_id": "remote-tools",
            "contribution_id": "remote-main",
            "binding_digest": "b" * 64,
            "descriptor_digest": "c" * 64,
            "artifact_digest": "d" * 64,
            "endpoint_origin_digest": "e" * 64,
            "negotiated_protocol": "2026-07-28",
            "auth_profile_ref": "f" * 64,
            "contributions": [{
                "kind": "tool",
                "remote_name": "lookup",
                "namespaced_name": "acme-labs.remote-tools.remote-main:lookup",
                "description": "Look up a remote record",
                "schema_digest": schema_digest,
                "schema_json": schema_json,
            }],
        }],
    }


def test_v3_apply_publishes_remote_tools_only_inside_the_turn_lease() -> None:
    schema_json = json.dumps(
        {"type": "object", "properties": {"query": {"type": "string"}}},
        separators=(",", ":"),
    )
    schema_digest = hashlib.sha256(schema_json.encode()).hexdigest()
    registry = PluginRuntimeRegistry()
    resources = {kind: object() for kind in RESOURCE_KINDS}

    publication = apply_plugin_runtime(
        registry,
        snapshot=_snapshot(schema_json, schema_digest),
        declarative_content=[],
        resource_provider=lambda: resources,
    )

    assert registry.build_turn_tool_descriptors() == ()
    with registry.lease(publication.generation.authority):
        descriptors = registry.build_turn_tool_descriptors()
        assert len(descriptors) == 1
        assert descriptors[0].name == "acme-labs.remote-tools.remote-main:lookup"
        assert descriptors[0].server_name == "electron_tool_bridge"
        assert descriptors[0].source_kind == "mcp"
        assert descriptors[0].input_schema["properties"]["query"]["type"] == "string"


def test_v3_apply_rejects_remote_schema_digest_drift() -> None:
    schema_json = '{"type":"object"}'
    registry = PluginRuntimeRegistry()
    resources = {kind: object() for kind in RESOURCE_KINDS}

    with pytest.raises(PluginRuntimeContractError, match="schema_digest_mismatch"):
        apply_plugin_runtime(
            registry,
            snapshot=_snapshot(schema_json, "0" * 64),
            declarative_content=[],
            resource_provider=lambda: resources,
        )
