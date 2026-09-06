from __future__ import annotations

import sys

import sidecar.ai.container as container_mod
from sidecar import server
from sidecar.ai.engines.ollama_catalog_cache import (
    SCHEMA_VERSION as OLLAMA_CATALOG_CACHE_SCHEMA_VERSION,
)
from sidecar.ai.engines.ollama_templates import (
    SCHEMA_VERSION as OLLAMA_TEMPLATE_SCHEMA_VERSION,
)
from sidecar.ai.memory.embedding import EMBEDDING_SCHEMA_VERSION
from sidecar.ai.memory.store_migrations import SCHEMA_VERSION as MEMORY_SCHEMA_VERSION
from sidecar.protocol import API_VERSION
from sidecar.runtime.diagnostics import SCHEMA_VERSION as DIAGNOSTICS_SCHEMA_VERSION
from sidecar.runtime.runtime_gap_schema import RUNTIME_GAP_SCHEMA_VERSION
from sidecar.runtime.schema_versions import get_all_schema_versions


def _entry_by_id(entries: list[dict[str, object]]) -> dict[str, dict[str, object]]:
    return {str(entry["id"]): entry for entry in entries}


def test_get_all_schema_versions_returns_sidecar_registry() -> None:
    sys.modules.pop("sidecar.runtime.runtime_gap", None)
    sys.modules.pop("sidecar.ai.plugins.generated_plugin_contracts", None)
    sys.modules.pop("sidecar.ai.plugins", None)

    entries = get_all_schema_versions()
    by_id = _entry_by_id(entries)

    assert "sidecar.runtime.runtime_gap" not in sys.modules
    assert by_id["sidecar.protocol_api"]["version"] == API_VERSION
    assert by_id["sidecar.diagnostics_log"]["version"] == DIAGNOSTICS_SCHEMA_VERSION
    assert by_id["sidecar.memory_store"]["version"] == MEMORY_SCHEMA_VERSION
    assert by_id["sidecar.embedding_index"]["version"] == EMBEDDING_SCHEMA_VERSION
    assert by_id["sidecar.runtime_gap"]["version"] == RUNTIME_GAP_SCHEMA_VERSION
    assert by_id["sidecar.plugin_contract_set"]["version"] == 1
    assert "sidecar.ai.plugins" not in sys.modules
    assert "sidecar.ai.plugins.generated_plugin_contracts" not in sys.modules
    assert (
        by_id["sidecar.ollama_template_registry"]["version"]
        == OLLAMA_TEMPLATE_SCHEMA_VERSION
    )
    assert (
        by_id["sidecar.ollama_model_catalog_cache"]["version"]
        == OLLAMA_CATALOG_CACHE_SCHEMA_VERSION
    )

    for entry in entries:
        assert isinstance(entry["id"], str)
        assert isinstance(entry["surface"], str)
        assert isinstance(entry["owner"], str)
        assert isinstance(entry["kind"], str)
        assert isinstance(entry["forward_policy"], str)
        assert isinstance(entry["source"], str)
        assert "version" in entry


def test_initialize_exposes_schema_versions(monkeypatch, tmp_path) -> None:
    # initialize builds a REAL container; without this the MonitorManager it
    # creates points at ~/.companion/background-memory, where its constructor
    # prunes (DELETES) terminal status records and recover_stale_monitors()
    # rewrites live running+persistent monitors to state="stale".
    monkeypatch.setattr(
        container_mod,
        "resolve_background_runtime_root",
        lambda _cfg: tmp_path / "runtime",
    )
    try:
        outcome = server.process_message(
            {
                "jsonrpc": "2.0",
                "id": 17,
                "method": "initialize",
                "params": {"accept_version": API_VERSION},
            },
            initialized=False,
        )

        assert outcome.response is not None
        result = outcome.response["result"]
        by_id = _entry_by_id(result["schema_versions"])

        assert by_id["sidecar.memory_store"]["version"] == MEMORY_SCHEMA_VERSION
        assert by_id["sidecar.diagnostics_log"]["version"] == DIAGNOSTICS_SCHEMA_VERSION
        assert (
            by_id["sidecar.ollama_model_catalog_cache"]["version"]
            == OLLAMA_CATALOG_CACHE_SCHEMA_VERSION
        )
    finally:
        # initialize owns a real engine stack; leaving it open keeps its
        # subprocess alive after this focused test file has completed.
        server._BRAIN_CONTAINER.close()  # noqa: SLF001
