"""Unified sidecar schema and protocol version registry."""

from __future__ import annotations

from sidecar.runtime.runtime_gap_schema import RUNTIME_GAP_SCHEMA_VERSION

PLUGIN_CONTRACT_SET_VERSION = 1


def get_all_schema_versions() -> list[dict[str, object]]:
    """Return sidecar-owned schema/API versions for status surfaces."""
    from sidecar.ai.engines.ollama_catalog_cache import (  # noqa: PLC0415
        SCHEMA_VERSION as OLLAMA_CATALOG_CACHE_SCHEMA_VERSION,
    )
    from sidecar.ai.engines.ollama_templates import (  # noqa: PLC0415
        SCHEMA_VERSION as OLLAMA_TEMPLATE_SCHEMA_VERSION,
    )
    from sidecar.ai.memory.embedding import EMBEDDING_SCHEMA_VERSION  # noqa: PLC0415
    from sidecar.ai.memory.store_migrations import (  # noqa: PLC0415
        SCHEMA_VERSION as MEMORY_SCHEMA_VERSION,
    )
    from sidecar.protocol import API_VERSION  # noqa: PLC0415
    from sidecar.runtime.diagnostics import (  # noqa: PLC0415
        SCHEMA_VERSION as DIAGNOSTICS_SCHEMA_VERSION,
    )

    return [
        {
            "id": "sidecar.protocol_api",
            "surface": "Sidecar JSON-RPC API handshake",
            "owner": "sidecar",
            "kind": "api_version",
            "version": API_VERSION,
            "forward_policy": "lockstep_api_version",
            "source": "sidecar/protocol.py",
        },
        {
            "id": "sidecar.diagnostics_log",
            "surface": "Sidecar diagnostics log",
            "owner": "sidecar",
            "kind": "log_schema",
            "version": DIAGNOSTICS_SCHEMA_VERSION,
            "forward_policy": "integer_schema_only",
            "source": "sidecar/runtime/diagnostics.py",
        },
        {
            "id": "sidecar.memory_store",
            "surface": "Memory store",
            "owner": "sidecar",
            "kind": "sqlite_schema",
            "version": MEMORY_SCHEMA_VERSION,
            "forward_policy": "reject_future",
            "source": "sidecar/ai/memory/store_migrations.py",
        },
        {
            "id": "sidecar.embedding_index",
            "surface": "Memory embedding index",
            "owner": "sidecar",
            "kind": "sqlite_metadata_schema",
            "version": EMBEDDING_SCHEMA_VERSION,
            "forward_policy": "rewrite_metadata_on_upgrade",
            "source": "sidecar/ai/memory/embedding.py",
        },
        {
            "id": "sidecar.runtime_gap",
            "surface": "Runtime gap candidate notification",
            "owner": "sidecar",
            "kind": "notification_schema",
            "version": RUNTIME_GAP_SCHEMA_VERSION,
            "forward_policy": "additive_notification_schema",
            "source": "sidecar/runtime/runtime_gap.py",
        },
        {
            "id": "sidecar.ollama_template_registry",
            "surface": "Ollama template registry diagnostics",
            "owner": "sidecar",
            "kind": "diagnostic_schema",
            "version": OLLAMA_TEMPLATE_SCHEMA_VERSION,
            "forward_policy": "additive_registry_schema",
            "source": "sidecar/ai/engines/ollama_templates.py",
        },
        {
            "id": "sidecar.ollama_model_catalog_cache",
            "surface": "Ollama model catalog cache",
            "owner": "sidecar",
            "kind": "json_cache_schema",
            "version": OLLAMA_CATALOG_CACHE_SCHEMA_VERSION,
            "forward_policy": "preserve_future_cache_schema",
            "source": "sidecar/ai/engines/ollama_catalog_cache.py",
        },
        {
            "id": "sidecar.plugin_contract_set",
            "surface": "Sidecar plugin V1 contract set",
            "owner": "sidecar",
            "kind": "contract_set",
            "version": PLUGIN_CONTRACT_SET_VERSION,
            "forward_policy": "frozen_v1_add_new_version",
            "source": "sidecar/ai/plugins/generated_plugin_contracts.py",
        },
    ]
