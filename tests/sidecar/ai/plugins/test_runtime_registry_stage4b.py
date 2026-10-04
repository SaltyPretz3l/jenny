from __future__ import annotations

import hashlib
import json
from copy import deepcopy

import pytest

from sidecar.ai.plugins.runtime_apply import (
    RESOURCE_KINDS,
    PluginRuntimeContractError,
    apply_plugin_runtime,
)
from sidecar.ai.plugins.runtime_registry import PluginRuntimeRegistry


def _resource_objects() -> dict[str, object]:
    return {kind: object() for kind in RESOURCE_KINDS}


def _v2_content(contribution_id: str, payload: dict[str, object]) -> tuple[str, str]:
    value = {
        "content_schema_version": 2,
        "publisher_id": "jenny-official",
        "plugin_id": "starter",
        "contribution_id": contribution_id,
        "payload": payload,
    }
    exact = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return exact, hashlib.sha256(exact.encode()).hexdigest()


def _v2_spec() -> tuple[dict[str, object], list[dict[str, str]]]:
    rows = {
        "settings-main": _v2_content(
            "settings-main",
            {
                "kind": "settings_schema",
                "fields": [
                    {
                        "type": "string",
                        "key": "path",
                        "label": "Path",
                        "default": "README.md",
                        "max_length": 128,
                    }
                ],
            },
        ),
        "prompt-main": _v2_content(
            "prompt-main",
            {
                "kind": "prompt",
                "template": "Summarize {{subject}}",
                "placeholders": ["subject"],
            },
        ),
    }
    arrays: dict[str, list[dict[str, object]]] = {
        "skill_scopes": [],
        "prompts": [],
        "themes": [],
        "settings_schemas": [],
        "commands": [],
        "workflows": [],
        "mcp_descriptors": [],
    }
    for contribution_id, array_name in (
        ("settings-main", "settings_schemas"),
        ("prompt-main", "prompts"),
    ):
        arrays[array_name].append(
            {
                "publisher_id": "jenny-official",
                "plugin_id": "starter",
                "contribution_id": contribution_id,
                "artifact_digest": "e" * 64,
                "content_digest": rows[contribution_id][1],
                "content_schema_version": 2,
            }
        )
    settings = {
        "settings_state_schema_version": 2,
        "publisher_id": "jenny-official",
        "plugin_id": "starter",
        "contribution_id": "settings-main",
        "schema_digest": rows["settings-main"][1],
        "revision": 1,
        "updated_at": "2026-08-04T12:00:00Z",
        "values": [{"type": "string", "key": "path", "value": "README.md"}],
    }
    state_json = json.dumps(
        settings, sort_keys=True, ensure_ascii=False, separators=(",", ":")
    )
    state_digest = hashlib.sha256(state_json.encode()).hexdigest()
    snapshot: dict[str, object] = {
        "kind": "plugin_runtime_snapshot",
        "runtime_schema_version": 2,
        "registry_revision": 1,
        "dependency_graph_hash": "a" * 64,
        "commit_epoch": 1,
        "active_generation_id": "gen-stage4b",
        "declarative_content": arrays,
        "workflow_tool_bindings": [],
        "settings_states": [
            {
                "publisher_id": "jenny-official",
                "plugin_id": "starter",
                "contribution_id": "settings-main",
                "state_digest": state_digest,
                "revision": 1,
            }
        ],
    }
    envelope = [
        {"content_digest": digest, "content_json": exact}
        for exact, digest in rows.values()
    ] + [{"state_digest": state_digest, "state_json": state_json}]
    return snapshot, envelope


def test_v2_apply_attests_settings_with_the_retired_arrays_empty() -> None:
    snapshot, envelope = _v2_spec()
    registry = PluginRuntimeRegistry()
    resources = _resource_objects()

    publication = apply_plugin_runtime(
        registry,
        snapshot=snapshot,
        declarative_content=envelope,
        resource_provider=lambda: resources,
    )

    assert {item.kind for item in publication.generation.declarative} == {
        "settings_schema",
        "prompt",
    }
    assert publication.generation.settings[0].values == (
        ("path", "string", "README.md"),
    )
    assert publication.generation.workflow_tool_bindings == ()


@pytest.mark.parametrize("retired", ["commands", "workflows", "workflow_tool_bindings"])
def test_v2_apply_refuses_retired_command_and_workflow_surfaces(retired: str) -> None:
    snapshot, envelope = _v2_spec()
    candidate = deepcopy(snapshot)
    declarative = candidate["declarative_content"]
    assert isinstance(declarative, dict)
    if retired == "workflow_tool_bindings":
        candidate[retired] = [
            {
                "publisher_id": "jenny-official",
                "plugin_id": "starter",
                "workflow_id": "workflow-main",
                "node_id": "read",
                "tool_id": "read_file",
                "manifest_version": 2,
                "descriptor_sha256": "f" * 64,
            }
        ]
    else:
        declarative[retired] = [dict(declarative["prompts"][0])]
    resources = _resource_objects()

    with pytest.raises(PluginRuntimeContractError) as error:
        apply_plugin_runtime(
            PluginRuntimeRegistry(),
            snapshot=candidate,
            declarative_content=envelope,
            resource_provider=lambda: resources,
        )

    assert error.value.reason_code == "runtime_surface_not_supported"
