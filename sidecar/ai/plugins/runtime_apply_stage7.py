"""Stage 7 provider-descriptor generation builder.

Kept separate from runtime_apply.py so the long-lived core publication path
stays below the plugin-tree size cap. Imported lazily after runtime_apply has
finished initializing, avoiding a module-cycle at import time.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, cast

from sidecar.ai.plugins.runtime_contracts import STAGE6_SCHEMA_VERSION
from sidecar.ai.plugins.runtime_registry import (
    PluginProviderDescriptor,
    PluginRuntimeGeneration,
)


def build_generation_v5(
    snapshot_value: dict[str, Any],
    content_envelope: object,
) -> PluginRuntimeGeneration:
    from sidecar.ai.plugins.runtime_apply import (  # noqa: PLC0415
        _build_generation_v4,
        _contract_rejection,
        _generation_id,
        _reject_duplicate_keys,
        _reject_json_constant,
        _validated_contract,
    )

    provider_rows = cast(list[dict[str, Any]], snapshot_value["provider_descriptors"])
    provider_digests = {cast(str, row["descriptor_digest"]) for row in provider_rows}
    if not isinstance(content_envelope, list):
        raise _contract_rejection("runtime_content_envelope_invalid")
    base_envelope = [item for item in content_envelope if isinstance(item, dict)
                     and item.get("content_digest") not in provider_digests]
    provider_envelope = [item for item in content_envelope if isinstance(item, dict)
                         and item.get("content_digest") in provider_digests]
    base_snapshot = {
        "kind": "plugin_runtime_snapshot",
        "runtime_schema_version": STAGE6_SCHEMA_VERSION,
        "registry_revision": snapshot_value["registry_revision"],
        "dependency_graph_hash": snapshot_value["dependency_graph_hash"],
        "commit_epoch": snapshot_value["commit_epoch"],
        "active_generation_id": snapshot_value["active_generation_id"],
        "declarative_content": snapshot_value["declarative_content"],
        "remote_mcp_bindings": snapshot_value["remote_mcp_bindings"],
        "restricted_contributions": snapshot_value["restricted_contributions"],
    }
    base = _build_generation_v4(base_snapshot, base_envelope)
    envelope_by_digest: dict[str, dict[str, Any]] = {}
    for item in provider_envelope:
        digest = cast(str, item["content_digest"])
        if digest in envelope_by_digest:
            raise _contract_rejection("runtime_content_envelope_duplicate")
        envelope_by_digest[digest] = item
    if set(envelope_by_digest) != provider_digests:
        raise _contract_rejection("runtime_provider_content_closure_mismatch")
    providers: list[PluginProviderDescriptor] = []
    for row in provider_rows:
        digest = cast(str, row["descriptor_digest"])
        envelope = envelope_by_digest[digest]
        content_json = cast(str, envelope["content_json"])
        if hashlib.sha256(content_json.encode("utf-8")).hexdigest() != digest:
            raise _contract_rejection("runtime_content_digest_mismatch")
        try:
            raw = json.loads(content_json,
                             object_pairs_hook=_reject_duplicate_keys,
                             parse_constant=_reject_json_constant)
        except (TypeError, ValueError) as error:
            raise _contract_rejection("runtime_provider_descriptor_invalid") from error
        descriptor = _validated_contract(
            "PluginProviderDescriptorV5", raw, "runtime_provider_descriptor_invalid"
        )
        if descriptor["provider_id"] != row["provider_id"] \
                or descriptor["engine_type"] != row["engine_type"]:
            raise _contract_rejection("runtime_provider_descriptor_mismatch")
        providers.append(PluginProviderDescriptor(
            provider_id=cast(str, row["provider_id"]),
            engine_type=cast(str, row["engine_type"]),
            descriptor_digest=digest,
            descriptor=descriptor,
        ))
    provider_tuple = tuple(sorted(providers, key=lambda item: item.provider_id.encode()))
    return PluginRuntimeGeneration(
        authority=base.authority,
        sidecar_plugin_generation=_generation_id(
            base.authority, list(base.contributions), base.declarative,
            base.settings, base.workflow_tool_bindings, base.remote_tools, provider_tuple,
        ),
        contributions=base.contributions,
        declarative=base.declarative,
        settings=base.settings,
        workflow_tool_bindings=base.workflow_tool_bindings,
        remote_tools=base.remote_tools,
        providers=provider_tuple,
    )
