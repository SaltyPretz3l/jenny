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


def _content() -> tuple[str, str]:
    value = {
        "content_schema_version": 4,
        "publisher_id": "acme-labs",
        "plugin_id": "restricted-tools",
        "contribution_id": "compute",
        "payload": {
            "kind": "restricted_compute",
            "description": "Run bounded compute",
            "input_schema_json": '{"type":"object","properties":{"value":{"type":"integer"}}}',
            "output_schema_json": '{"type":"object"}',
            "timeout_ms": 1000,
            "capabilities": ["control.cancelled"],
            "network_origins": [],
        },
    }
    text = json.dumps(value, separators=(",", ":"))
    return text, hashlib.sha256(text.encode()).hexdigest()


def _snapshot(content_digest: str) -> dict[str, object]:
    remote_schema = '{"type":"object"}'
    return {
        "kind": "plugin_runtime_snapshot",
        "runtime_schema_version": 4,
        "registry_revision": 6,
        "dependency_graph_hash": "a" * 64,
        "commit_epoch": 6,
        "active_generation_id": "gen-stage6",
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
                "schema_digest": hashlib.sha256(remote_schema.encode()).hexdigest(),
                "schema_json": remote_schema,
            }],
        }],
        "restricted_contributions": [{
            "publisher_id": "acme-labs",
            "plugin_id": "restricted-tools",
            "contribution_id": "compute",
            "kind": "restricted_compute",
            "artifact_digest": "1" * 64,
            "content_digest": content_digest,
            "component_digest": "2" * 64,
            "abi_digest": "3" * 64,
            "timeout_ms": 1000,
        }],
    }


def test_v4_apply_preserves_remote_tools_and_adds_restricted_tool() -> None:
    content_json, content_digest = _content()
    registry = PluginRuntimeRegistry()
    resources = {kind: object() for kind in RESOURCE_KINDS}

    publication = apply_plugin_runtime(
        registry,
        snapshot=_snapshot(content_digest),
        declarative_content=[{
            "content_digest": content_digest,
            "content_json": content_json,
        }],
        resource_provider=lambda: resources,
    )

    with registry.lease(publication.generation.authority):
        descriptors = registry.build_turn_tool_descriptors()
        assert [item.name for item in descriptors] == [
            "acme-labs.remote-tools.remote-main:lookup",
            "plugin:acme-labs:restricted-tools:compute",
        ]
        restricted = descriptors[1]
        assert restricted.server_name == "electron_tool_bridge"
        assert restricted.source_kind == "restricted"
        assert restricted.input_schema["properties"]["value"]["type"] == "integer"


def test_v4_apply_rejects_restricted_content_digest_drift() -> None:
    content_json, content_digest = _content()
    registry = PluginRuntimeRegistry()
    resources = {kind: object() for kind in RESOURCE_KINDS}

    with pytest.raises(PluginRuntimeContractError, match="content_digest_mismatch"):
        apply_plugin_runtime(
            registry,
            snapshot=_snapshot("0" * 64),
            declarative_content=[{
                "content_digest": "0" * 64,
                "content_json": content_json,
            }],
            resource_provider=lambda: resources,
        )
