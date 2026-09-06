"""Strict all-or-nothing compilation and attestation for declarative plugins."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping
from typing import Any, Final, cast

from sidecar.ai.context.builder_plugins import PluginContextItem
from sidecar.ai.plugins.runtime_contracts import (
    STAGE4B_SCHEMA_VERSION,
    STAGE5_SCHEMA_VERSION,
    STAGE6_SCHEMA_VERSION,
    STAGE7_SCHEMA_VERSION,
    STAGE8_SCHEMA_VERSION,
    PluginRuntimeContractError,
    expected_content,
)
from sidecar.ai.plugins.runtime_contracts import contract_rejection as _contract_rejection
from sidecar.ai.plugins.runtime_contracts import descriptor_identity as _descriptor_identity
from sidecar.ai.plugins.runtime_contracts import parsed_content as _parsed_content
from sidecar.ai.plugins.runtime_contracts import reject_duplicate_keys as _reject_duplicate_keys
from sidecar.ai.plugins.runtime_contracts import reject_json_constant as _reject_json_constant
from sidecar.ai.plugins.runtime_contracts import validated_contract as _validated_contract
from sidecar.ai.plugins.runtime_publication import (
    CMP_PLUGIN_OUTCOME_INDETERMINATE,
    PluginRuntimePublication,
    publish_plugin_runtime,
)
from sidecar.ai.plugins.runtime_registry import (
    PluginDeclarativeContribution,
    PluginEngineBinding,
    PluginNativeToolDescriptor,
    PluginProviderDescriptor,
    PluginRemoteToolDescriptor,
    PluginRuntimeAuthority,
    PluginRuntimeGeneration,
    PluginRuntimeRegistry,
    PluginSettingsRecord,
    PluginWorkflowToolBinding,
)
from sidecar.ai.tools.catalog import manifest_tool_entry

RESOURCE_KINDS: Final[tuple[str, ...]] = (
    "engine",
    "model",
    "memory",
    "mcp",
    "monitor",
    "tool",
)
_SUPPORTED_ARRAYS: Final[dict[str, str]] = {
    "skill_scopes": "skill",
    "prompts": "prompt",
}
_V2_ARRAYS: Final[dict[str, str]] = {
    **_SUPPORTED_ARRAYS,
    "themes": "theme",
    "settings_schemas": "settings_schema",
    "commands": "command",
    "workflows": "workflow",
}
_INERT_ARRAYS: Final[tuple[str, ...]] = (
    "themes",
    "settings_schemas",
    "commands",
    "workflows",
    "mcp_descriptors",
)


def _expected_content(
    declarative: Mapping[str, Any],
    *, runtime_version: int,
) -> dict[str, tuple[tuple[str, str, str], str, int]]:
    arrays = _V2_ARRAYS if runtime_version == STAGE4B_SCHEMA_VERSION else _SUPPORTED_ARRAYS
    return expected_content(declarative, arrays=arrays)


def _tool_descriptor_digest(tool_id: str) -> str | None:
    entry = manifest_tool_entry(tool_id)
    if entry is None or entry.get("workflow_eligible") is not True:
        return None
    payload: dict[str, Any] = {
        "manifest_version": 2,
        "name": entry.get("name"),
        "parameters": entry.get("parameters"),
        "side_effecting": entry.get("side_effecting") is True,
        "read_only": entry.get("read_only") is True,
        "workflow_eligible": entry.get("workflow_eligible") is True,
        "source_kind": entry.get("source_kind") or "",
        "tool_family": entry.get("tool_family") or "",
        "owner": entry.get("owner") or "",
        "surfaces": entry.get("surfaces") if isinstance(entry.get("surfaces"), list) else [],
        "availability": entry.get("availability") or {},
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _context_item(
    digest: str,
    expected_identity: tuple[str, str, str],
    expected_kind: str,
    content: Mapping[str, Any],
) -> PluginContextItem:
    identity = (
        cast(str, content["publisher_id"]),
        cast(str, content["plugin_id"]),
        cast(str, content["contribution_id"]),
    )
    payload = cast(dict[str, Any], content["payload"])
    if identity != expected_identity or payload.get("kind") != expected_kind:
        raise _contract_rejection("runtime_content_identity_mismatch", expected_identity[2])
    text_key = "instructions" if expected_kind == "skill" else "template"
    return PluginContextItem(
        publisher_id=identity[0],
        plugin_id=identity[1],
        contribution_id=identity[2],
        kind=expected_kind,
        content_digest=digest,
        content=cast(str, payload[text_key]),
    )


def _generation_id(  # noqa: PLR0913
    authority: PluginRuntimeAuthority,
    contributions: list[PluginContextItem],
    declarative: tuple[PluginDeclarativeContribution, ...],
    settings: tuple[PluginSettingsRecord, ...],
    tool_bindings: tuple[PluginWorkflowToolBinding, ...],
    remote_tools: tuple[PluginRemoteToolDescriptor, ...] = (),
    providers: tuple[PluginProviderDescriptor, ...] = (),
    native_tools: tuple[PluginNativeToolDescriptor, ...] = (),
    engine_bindings: tuple[PluginEngineBinding, ...] = (),
) -> str:
    identity = {
        "registry_revision": authority.registry_revision,
        "dependency_graph_hash": authority.dependency_graph_hash,
        "commit_epoch": authority.commit_epoch,
        "active_generation_id": authority.active_generation_id,
    }
    payload: dict[str, object] = {
        "authority": identity,
        "content_digests": sorted(
            {item.content_digest for item in contributions}
            | {item.content_digest for item in declarative}
        ),
        "settings": [
            [item.publisher_id, item.plugin_id, item.contribution_id,
             item.schema_digest, item.revision]
            for item in settings
        ],
        "workflow_tool_bindings": [
            [item.publisher_id, item.plugin_id, item.workflow_id, item.node_id,
             item.tool_id, item.manifest_version, item.descriptor_sha256]
            for item in tool_bindings
        ],
        "remote_tools": [item.name for item in remote_tools],
        "providers": [[item.provider_id, item.descriptor_digest] for item in providers],
    }
    # Preserve the frozen V1-V5 generation fingerprint byte-for-byte. These
    # keys exist only for a V6 generation that actually carries privileged
    # descriptors.
    if native_tools:
        payload["native_tools"] = [
            [item.name, item.binding_digest, item.publisher_id,
             item.plugin_id, item.contribution_id]
            for item in native_tools
        ]
    if engine_bindings:
        payload["engine_bindings"] = [
            [item.adapter_id, item.binding_digest] for item in engine_bindings
        ]
    fingerprint = hashlib.sha256(
        json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()[:32]
    return f"sidecar-{fingerprint}"


def _build_generation(
    snapshot_value: dict[str, Any],
    content_envelope: object,
) -> PluginRuntimeGeneration:
    runtime_version = cast(int, snapshot_value.get("runtime_schema_version", 1))
    declarative = cast(dict[str, Any], snapshot_value["declarative_content"])
    if runtime_version == 1 and any(declarative[name] for name in _INERT_ARRAYS):
        raise _contract_rejection("runtime_surface_not_supported")
    if declarative["mcp_descriptors"]:
        raise _contract_rejection("runtime_mcp_activation_forbidden")
    expected = _expected_content(declarative, runtime_version=runtime_version)
    parsed, settings = _parsed_content(content_envelope, expected)
    if set(parsed) != set(expected):
        raise _contract_rejection("runtime_content_closure_mismatch")
    contributions = [
        _context_item(digest, identity, kind, parsed[digest])
        for digest, (identity, kind, _version) in expected.items()
        if kind in {"skill", "prompt"}
    ]
    contributions.sort(
        key=lambda item: tuple(
            value.encode("utf-8")
            for value in (item.publisher_id, item.plugin_id, item.contribution_id)
        )
    )
    authority = PluginRuntimeAuthority(
        registry_revision=cast(int, snapshot_value["registry_revision"]),
        dependency_graph_hash=cast(str, snapshot_value["dependency_graph_hash"]),
        commit_epoch=cast(int, snapshot_value["commit_epoch"]),
        active_generation_id=cast(str, snapshot_value["active_generation_id"]),
    )
    declarative_records = tuple(sorted((
        PluginDeclarativeContribution(
            publisher_id=identity[0], plugin_id=identity[1], contribution_id=identity[2],
            kind=kind, content_digest=digest,
            payload=cast(dict[str, Any], parsed[digest]["payload"]),
        )
        for digest, (identity, kind, _version) in expected.items()
    ), key=lambda item: (
        item.publisher_id.encode(), item.plugin_id.encode(), item.contribution_id.encode()
    )))
    expected_settings = cast(list[dict[str, Any]], snapshot_value.get("settings_states", []))
    if {item["state_digest"] for item in expected_settings} != set(settings):
        raise _contract_rejection("runtime_settings_closure_mismatch")
    settings_records: list[PluginSettingsRecord] = []
    for item in expected_settings:
        state = settings[item["state_digest"]]
        identity = (state["publisher_id"], state["plugin_id"], state["contribution_id"])
        if (
            identity != (item["publisher_id"], item["plugin_id"], item["contribution_id"])
            or state["revision"] != item["revision"]
        ):
            raise _contract_rejection("runtime_settings_identity_mismatch")
        settings_records.append(PluginSettingsRecord(
            publisher_id=identity[0], plugin_id=identity[1], contribution_id=identity[2],
            schema_digest=state["schema_digest"], revision=state["revision"],
            values=tuple((row["key"], row["type"], row["value"]) for row in state["values"]),
        ))
    tool_bindings: list[PluginWorkflowToolBinding] = []
    for item in cast(list[dict[str, Any]], snapshot_value.get("workflow_tool_bindings", [])):
        recomputed = _tool_descriptor_digest(cast(str, item["tool_id"]))
        if recomputed is None or recomputed != item["descriptor_sha256"]:
            raise _contract_rejection("runtime_workflow_tool_descriptor_stale")
        tool_bindings.append(PluginWorkflowToolBinding(**item))
    declarative_tuple = tuple(declarative_records)
    settings_tuple = tuple(settings_records)
    bindings_tuple = tuple(tool_bindings)
    return PluginRuntimeGeneration(
        authority=authority,
        sidecar_plugin_generation=_generation_id(
            authority, contributions, declarative_tuple, settings_tuple, bindings_tuple,
        ),
        contributions=tuple(contributions),
        declarative=declarative_tuple,
        settings=settings_tuple,
        workflow_tool_bindings=bindings_tuple,
    )


def _build_generation_v3(  # noqa: C901, PLR0912
    snapshot_value: dict[str, Any],
    content_envelope: object,
) -> PluginRuntimeGeneration:
    declarative = cast(list[dict[str, Any]], snapshot_value["declarative_content"])
    expected: dict[str, tuple[tuple[str, str, str], str, int]] = {}
    for descriptor in declarative:
        digest = cast(str, descriptor["content_digest"])
        if digest in expected:
            raise _contract_rejection("runtime_content_digest_duplicate")
        expected[digest] = (_descriptor_identity(descriptor), "declarative",
                            cast(int, descriptor["content_schema_version"]))
    parsed, settings = _parsed_content(content_envelope, expected)
    if settings or set(parsed) != set(expected):
        raise _contract_rejection("runtime_content_closure_mismatch")
    contributions: list[PluginContextItem] = []
    declarative_records: list[PluginDeclarativeContribution] = []
    for digest, (identity, _kind, _version) in expected.items():
        content = parsed[digest]
        payload = cast(dict[str, Any], content["payload"])
        kind = str(payload.get("kind") or "")
        if (content.get("publisher_id"), content.get("plugin_id"),
                content.get("contribution_id")) != identity:
            raise _contract_rejection("runtime_content_identity_mismatch", identity[2])
        if kind not in {"skill", "prompt"}:
            raise _contract_rejection("runtime_surface_not_supported", identity[2])
        contributions.append(_context_item(digest, identity, kind, content))
        declarative_records.append(PluginDeclarativeContribution(
            publisher_id=identity[0], plugin_id=identity[1], contribution_id=identity[2],
            kind=kind, content_digest=digest, payload=payload,
        ))
    remote_tools: list[PluginRemoteToolDescriptor] = []
    for binding in cast(list[dict[str, Any]], snapshot_value["remote_mcp_bindings"]):
        for row in cast(list[dict[str, Any]], binding["contributions"]):
            if row["kind"] != "tool":
                continue
            schema_json = cast(str, row["schema_json"])
            if hashlib.sha256(schema_json.encode("utf-8")).hexdigest() != row["schema_digest"]:
                raise _contract_rejection("runtime_remote_schema_digest_mismatch")
            try:
                schema = json.loads(
                    schema_json,
                    object_pairs_hook=_reject_duplicate_keys,
                    parse_constant=_reject_json_constant,
                )
            except (TypeError, ValueError) as error:
                raise _contract_rejection("runtime_remote_schema_invalid") from error
            if not isinstance(schema, dict):
                raise _contract_rejection("runtime_remote_schema_invalid")
            remote_tools.append(PluginRemoteToolDescriptor(
                name=cast(str, row["namespaced_name"]),
                description=cast(str, row["description"]),
                input_schema=cast(dict[str, Any], schema),
                server_tool_name=cast(str, row["namespaced_name"]),
            ))
    if len({item.name for item in remote_tools}) != len(remote_tools):
        raise _contract_rejection("runtime_remote_tool_duplicate")
    authority = PluginRuntimeAuthority(
        registry_revision=cast(int, snapshot_value["registry_revision"]),
        dependency_graph_hash=cast(str, snapshot_value["dependency_graph_hash"]),
        commit_epoch=cast(int, snapshot_value["commit_epoch"]),
        active_generation_id=cast(str, snapshot_value["active_generation_id"]),
    )
    contribution_tuple = tuple(sorted(contributions, key=lambda item: (
        item.publisher_id.encode(), item.plugin_id.encode(), item.contribution_id.encode()
    )))
    declarative_tuple = tuple(sorted(declarative_records, key=lambda item: (
        item.publisher_id.encode(), item.plugin_id.encode(), item.contribution_id.encode()
    )))
    remote_tuple = tuple(sorted(remote_tools, key=lambda item: item.name.encode()))
    return PluginRuntimeGeneration(
        authority=authority,
        sidecar_plugin_generation=_generation_id(
            authority, list(contribution_tuple), declarative_tuple, (), (), remote_tuple,
        ),
        contributions=contribution_tuple,
        declarative=declarative_tuple,
        remote_tools=remote_tuple,
    )


def _build_generation_v4(  # noqa: C901, PLR0912, PLR0915
    snapshot_value: dict[str, Any],
    content_envelope: object,
) -> PluginRuntimeGeneration:
    declarative = cast(list[dict[str, Any]], snapshot_value["declarative_content"])
    restricted = cast(list[dict[str, Any]], snapshot_value["restricted_contributions"])
    expected: dict[str, tuple[tuple[str, str, str], str, int]] = {}
    for descriptor in declarative:
        digest = cast(str, descriptor["content_digest"])
        if digest in expected:
            raise _contract_rejection("runtime_content_digest_duplicate")
        expected[digest] = (
            _descriptor_identity(descriptor), "declarative",
            cast(int, descriptor["content_schema_version"]),
        )
    for descriptor in restricted:
        digest = cast(str, descriptor["content_digest"])
        if digest in expected:
            raise _contract_rejection("runtime_content_digest_duplicate")
        expected[digest] = (
            _descriptor_identity(descriptor), cast(str, descriptor["kind"]),
            STAGE6_SCHEMA_VERSION,
        )
    parsed, settings = _parsed_content(content_envelope, expected)
    if settings or set(parsed) != set(expected):
        raise _contract_rejection("runtime_content_closure_mismatch")

    contributions: list[PluginContextItem] = []
    declarative_records: list[PluginDeclarativeContribution] = []
    for descriptor in declarative:
        digest = cast(str, descriptor["content_digest"])
        identity = _descriptor_identity(descriptor)
        content = parsed[digest]
        payload = cast(dict[str, Any], content["payload"])
        kind = str(payload.get("kind") or "")
        if (content.get("publisher_id"), content.get("plugin_id"),
                content.get("contribution_id")) != identity:
            raise _contract_rejection("runtime_content_identity_mismatch", identity[2])
        if kind not in {"skill", "prompt"}:
            raise _contract_rejection("runtime_surface_not_supported", identity[2])
        contributions.append(_context_item(digest, identity, kind, content))
        declarative_records.append(PluginDeclarativeContribution(
            publisher_id=identity[0], plugin_id=identity[1], contribution_id=identity[2],
            kind=kind, content_digest=digest, payload=payload,
        ))

    remote_tools: list[PluginRemoteToolDescriptor] = []
    for binding in cast(list[dict[str, Any]], snapshot_value["remote_mcp_bindings"]):
        for row in cast(list[dict[str, Any]], binding["contributions"]):
            if row["kind"] != "tool":
                continue
            schema_json = cast(str, row["schema_json"])
            if hashlib.sha256(schema_json.encode("utf-8")).hexdigest() != row["schema_digest"]:
                raise _contract_rejection("runtime_remote_schema_digest_mismatch")
            try:
                schema = json.loads(schema_json, object_pairs_hook=_reject_duplicate_keys,
                                    parse_constant=_reject_json_constant)
            except (TypeError, ValueError) as error:
                raise _contract_rejection("runtime_remote_schema_invalid") from error
            if not isinstance(schema, dict):
                raise _contract_rejection("runtime_remote_schema_invalid")
            remote_tools.append(PluginRemoteToolDescriptor(
                name=cast(str, row["namespaced_name"]),
                description=cast(str, row["description"]),
                input_schema=schema,
                server_tool_name=cast(str, row["namespaced_name"]),
            ))

    for descriptor in restricted:
        digest = cast(str, descriptor["content_digest"])
        identity = _descriptor_identity(descriptor)
        content = parsed[digest]
        payload = cast(dict[str, Any], content["payload"])
        if ((content.get("publisher_id"), content.get("plugin_id"),
             content.get("contribution_id")) != identity
                or payload.get("kind") != descriptor["kind"]
                or payload.get("timeout_ms") != descriptor["timeout_ms"]):
            raise _contract_rejection("runtime_restricted_content_mismatch", identity[2])
        try:
            input_schema = json.loads(
                cast(str, payload["input_schema_json"]),
                object_pairs_hook=_reject_duplicate_keys,
                parse_constant=_reject_json_constant,
            )
            output_schema = json.loads(
                cast(str, payload["output_schema_json"]),
                object_pairs_hook=_reject_duplicate_keys,
                parse_constant=_reject_json_constant,
            )
        except (TypeError, ValueError) as error:
            raise _contract_rejection("runtime_restricted_schema_invalid", identity[2]) from error
        if not isinstance(input_schema, dict) or not isinstance(output_schema, dict):
            raise _contract_rejection("runtime_restricted_schema_invalid", identity[2])
        namespaced = f"plugin:{identity[0]}:{identity[1]}:{identity[2]}"
        remote_tools.append(PluginRemoteToolDescriptor(
            name=namespaced,
            description=cast(str, payload["description"]),
            input_schema=input_schema,
            server_tool_name=namespaced,
            source_kind="restricted",
        ))

    if len({item.name for item in remote_tools}) != len(remote_tools):
        raise _contract_rejection("runtime_remote_tool_duplicate")
    authority = PluginRuntimeAuthority(
        registry_revision=cast(int, snapshot_value["registry_revision"]),
        dependency_graph_hash=cast(str, snapshot_value["dependency_graph_hash"]),
        commit_epoch=cast(int, snapshot_value["commit_epoch"]),
        active_generation_id=cast(str, snapshot_value["active_generation_id"]),
    )
    contribution_tuple = tuple(sorted(contributions, key=lambda item: (
        item.publisher_id.encode(), item.plugin_id.encode(), item.contribution_id.encode()
    )))
    declarative_tuple = tuple(sorted(declarative_records, key=lambda item: (
        item.publisher_id.encode(), item.plugin_id.encode(), item.contribution_id.encode()
    )))
    remote_tuple = tuple(sorted(remote_tools, key=lambda item: item.name.encode()))
    return PluginRuntimeGeneration(
        authority=authority,
        sidecar_plugin_generation=_generation_id(
            authority, list(contribution_tuple), declarative_tuple, (), (), remote_tuple,
        ),
        contributions=contribution_tuple,
        declarative=declarative_tuple,
        remote_tools=remote_tuple,
    )


def _capture_resources(
    resource_provider: Callable[[], Mapping[str, object]],
) -> dict[str, object]:
    resources = dict(resource_provider())
    missing = set(resources) != set(RESOURCE_KINDS)
    if missing or any(resources[kind] is None for kind in RESOURCE_KINDS):
        raise PluginRuntimeContractError(
            "runtime_resource_proof_unavailable",
            code=CMP_PLUGIN_OUTCOME_INDETERMINATE,
        )
    return resources


def apply_plugin_runtime(
    registry: PluginRuntimeRegistry,
    *,
    snapshot: object,
    declarative_content: object,
    resource_provider: Callable[[], Mapping[str, object]],
) -> PluginRuntimePublication:
    generation = build_plugin_runtime(
        snapshot=snapshot,
        declarative_content=declarative_content,
        resource_provider=resource_provider,
    )
    if (
        isinstance(snapshot, dict)
        and snapshot.get("runtime_schema_version") == STAGE8_SCHEMA_VERSION
    ):
        raise PluginRuntimeContractError("runtime_v6_requires_transaction")
    return publish_plugin_runtime(registry, generation, _capture_resources(resource_provider))


def build_plugin_runtime(
    *,
    snapshot: object,
    declarative_content: object,
    resource_provider: Callable[[], Mapping[str, object]],
) -> PluginRuntimeGeneration:
    runtime_version = snapshot.get("runtime_schema_version", 1) if isinstance(snapshot, dict) else 1
    snapshot_value = _validated_contract(
        "PluginRuntimeSnapshotV6" if runtime_version == STAGE8_SCHEMA_VERSION else (
        "PluginRuntimeSnapshotV5" if runtime_version == STAGE7_SCHEMA_VERSION else (
        "PluginRuntimeSnapshotV4" if runtime_version == STAGE6_SCHEMA_VERSION else (
            "PluginRuntimeSnapshotV3" if runtime_version == STAGE5_SCHEMA_VERSION else (
            "PluginRuntimeSnapshotV2" if runtime_version == STAGE4B_SCHEMA_VERSION
            else "PluginRuntimeSnapshotV1"
        )))),
        snapshot,
        "runtime_snapshot_invalid",
    )
    if runtime_version in {STAGE7_SCHEMA_VERSION, STAGE8_SCHEMA_VERSION}:
        from sidecar.ai.plugins import runtime_apply_stage7, runtime_apply_stage8  # noqa: PLC0415
    if runtime_version == STAGE8_SCHEMA_VERSION:
        generation = runtime_apply_stage8.build_generation_v6(
            snapshot_value, declarative_content
        )
    else:
        generation = (runtime_apply_stage7.build_generation_v5(snapshot_value, declarative_content)
                  if runtime_version == STAGE7_SCHEMA_VERSION
                  else (_build_generation_v4(snapshot_value, declarative_content)
                  if runtime_version == STAGE6_SCHEMA_VERSION
                  else (_build_generation_v3(snapshot_value, declarative_content)
                        if runtime_version == STAGE5_SCHEMA_VERSION
                        else _build_generation(snapshot_value, declarative_content))))
    resources_before = _capture_resources(resource_provider)
    resources_after = _capture_resources(resource_provider)
    if any(resources_before[kind] is not resources_after[kind] for kind in RESOURCE_KINDS):
        raise PluginRuntimeContractError(
            "runtime_resource_identity_changed",
            code=CMP_PLUGIN_OUTCOME_INDETERMINATE,
        )
    return generation
