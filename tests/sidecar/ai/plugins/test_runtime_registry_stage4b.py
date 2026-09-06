from __future__ import annotations

import hashlib
import json
from copy import deepcopy

import pytest

from sidecar.ai.context.builder_plugins import PluginContextItem
from sidecar.ai.plugins.runtime_apply import (
    RESOURCE_KINDS,
    PluginRuntimeContractError,
    _tool_descriptor_digest,
    apply_plugin_runtime,
)
from sidecar.ai.plugins.runtime_registry import (
    PluginAuthorityMismatchError,
    PluginDeclarativeContribution,
    PluginRuntimeAuthority,
    PluginRuntimeGeneration,
    PluginRuntimeRegistry,
)


def _generation(index: int) -> PluginRuntimeGeneration:
    authority = PluginRuntimeAuthority(
        registry_revision=index + 1,
        dependency_graph_hash=f"{index + 1:064x}",
        commit_epoch=index + 1,
        active_generation_id=f"gen-{index + 1}",
    )
    contribution = PluginContextItem(
        publisher_id="jenny-official",
        plugin_id="starter",
        contribution_id=f"skill-{index + 1}",
        kind="skill",
        content_digest=f"{index + 2:064x}",
        content=f"instruction {index + 1}",
    )
    return PluginRuntimeGeneration(authority, f"sidecar-gen-{index + 1}", (contribution,))


def _resource_objects() -> dict[str, object]:
    return {kind: object() for kind in RESOURCE_KINDS}


def test_generation_withdrawal_cancels_workflows_but_not_ordinary_turn_pins() -> None:
    registry = PluginRuntimeRegistry()
    first = _generation(1)
    second = _generation(2)
    registry.publish(first)
    pin = registry.acquire_pin(first.authority)
    cancelled: list[str] = []
    unregister = registry.register_workflow_cancellation(
        first.authority, lambda: cancelled.append("withdrawn")
    )

    registry.publish(second)

    assert cancelled == ["withdrawn"]
    with pin.bind() as retained:
        assert retained is first
    pin.release()
    unregister()


def test_completed_workflow_unregisters_its_withdrawal_callback() -> None:
    registry = PluginRuntimeRegistry()
    first = _generation(1)
    registry.publish(first)
    cancelled: list[str] = []
    unregister = registry.register_workflow_cancellation(
        first.authority, lambda: cancelled.append("withdrawn")
    )
    unregister()

    registry.publish(_generation(2))

    assert cancelled == []


def test_command_resolution_requires_current_leased_authority_and_exact_typed_inputs() -> None:
    registry = PluginRuntimeRegistry()
    authority = PluginRuntimeAuthority(7, "a" * 64, 9, "gen-stage4b")
    prompt = PluginDeclarativeContribution(
        "jenny-official",
        "starter",
        "prompt-main",
        "prompt",
        "b" * 64,
        {"kind": "prompt", "template": "{{name}}", "placeholders": ["name"]},
    )
    command = PluginDeclarativeContribution(
        "jenny-official",
        "starter",
        "command-main",
        "command",
        "c" * 64,
        {
            "kind": "command",
            "target_kind": "prompt",
            "target_contribution_id": "prompt-main",
            "inputs": [
                {
                    "type": "string",
                    "key": "name",
                    "label": "Name",
                    "default": "Jenny",
                    "max_length": 20,
                }
            ],
        },
    )
    generation = PluginRuntimeGeneration(
        authority, "sidecar-stage4b", (), declarative=(prompt, command)
    )
    registry.publish(generation)
    invocation = {
        "invocation_schema_version": 2,
        "publisher_id": "jenny-official",
        "plugin_id": "starter",
        "command_id": "command-main",
        "observed_generation_id": "gen-stage4b",
        "observed_registry_revision": 7,
        "inputs": [{"type": "string", "key": "name", "value": "Ada"}],
    }

    with pytest.raises(PluginAuthorityMismatchError, match="lease"):
        registry.resolve_command(invocation)
    with registry.lease(authority):
        resolved = registry.resolve_command(invocation)
        assert resolved.target is prompt
        assert resolved.inputs == (("name", "string", "Ada"),)

        stale = {**invocation, "observed_registry_revision": 6}
        with pytest.raises(PluginAuthorityMismatchError, match="stale"):
            registry.resolve_command(stale)
        wrong_type = deepcopy(invocation)
        wrong_type["inputs"] = [{"type": "integer", "key": "name", "value": 1}]
        with pytest.raises(PluginAuthorityMismatchError):
            registry.resolve_command(wrong_type)


def test_v2_apply_attests_settings_and_rechecks_workflow_tool_descriptor() -> None:
    def v2_content(contribution_id: str, payload: dict[str, object]) -> tuple[str, str]:
        value = {
            "content_schema_version": 2,
            "publisher_id": "jenny-official",
            "plugin_id": "starter",
            "contribution_id": contribution_id,
            "payload": payload,
        }
        exact = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        return exact, hashlib.sha256(exact.encode()).hexdigest()

    rows = {
        "settings-main": v2_content(
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
        "prompt-main": v2_content(
            "prompt-main",
            {
                "kind": "prompt",
                "template": "Summarize {{subject}}",
                "placeholders": ["subject"],
            },
        ),
        "command-main": v2_content(
            "command-main",
            {
                "kind": "command",
                "target_kind": "workflow",
                "target_contribution_id": "workflow-main",
                "inputs": [],
            },
        ),
        "workflow-main": v2_content(
            "workflow-main",
            {
                "kind": "workflow",
                "entry_node_id": "read",
                "nodes": [
                    {
                        "type": "tool",
                        "node_id": "read",
                        "tool_id": "read_file",
                        "bindings": [
                            {
                                "target": "path",
                                "value": {
                                    "source": "setting",
                                    "settings_contribution_id": "settings-main",
                                    "key": "path",
                                },
                            }
                        ],
                        "max_attempts": 1,
                        "timeout_ms": 1000,
                    }
                ],
                "edges": [],
                "total_timeout_ms": 2000,
            },
        ),
    }
    arrays = {
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
        ("command-main", "commands"),
        ("workflow-main", "workflows"),
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
    descriptor_digest = _tool_descriptor_digest("read_file")
    assert descriptor_digest == (
        "95620d16a1374d672d20dd3a36f7e7a1deba070af1d624ebacbb120a9f0229df"
    )
    snapshot = {
        "kind": "plugin_runtime_snapshot",
        "runtime_schema_version": 2,
        "registry_revision": 1,
        "dependency_graph_hash": "a" * 64,
        "commit_epoch": 1,
        "active_generation_id": "gen-stage4b",
        "declarative_content": arrays,
        "workflow_tool_bindings": [
            {
                "publisher_id": "jenny-official",
                "plugin_id": "starter",
                "workflow_id": "workflow-main",
                "node_id": "read",
                "tool_id": "read_file",
                "manifest_version": 2,
                "descriptor_sha256": descriptor_digest,
            }
        ],
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
        "command",
        "workflow",
    }
    assert publication.generation.settings[0].values == (
        ("path", "string", "README.md"),
    )
    assert publication.generation.workflow_tool_bindings[0].tool_id == "read_file"

    stale = deepcopy(snapshot)
    stale["registry_revision"] = 2
    stale["commit_epoch"] = 2
    stale["active_generation_id"] = "gen-stale"
    stale["workflow_tool_bindings"][0]["descriptor_sha256"] = "0" * 64
    with pytest.raises(PluginRuntimeContractError, match="descriptor_stale"):
        apply_plugin_runtime(
            registry,
            snapshot=stale,
            declarative_content=envelope,
            resource_provider=lambda: resources,
        )
