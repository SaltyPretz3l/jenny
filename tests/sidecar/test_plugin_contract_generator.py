"""Guard the plugin contract generator's schema lint.

The Stage 2 exit gate flips every file under config/plugins/v1/ to
``"frozen": true`` at once and writes the contract lock. An earlier revision of
the lint hard-required ``frozen`` to be exactly ``False``, which would have made
the freeze itself break generation and the parity check -- the exit gate
sabotaging the thing it gates. These tests pin the properties that keep the
freeze possible, and the properties that keep parallel authoring lanes from
diverging.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from scripts.generate_plugin_contracts import (
    COMMON_FILE,
    SCHEMA_DIR,
    SCHEMA_DIRS,
    SchemaLintError,
    _build_spec,
    _lint_file_metadata,
    _merge_local_defs,
    contract_files,
)

A_CONTRACT_FILE = "plugin-cleanup-state.schema.json"


def _document(filename: str) -> dict[str, Any]:
    return json.loads((SCHEMA_DIR / filename).read_text(encoding="utf-8"))


@pytest.mark.parametrize("frozen", [False, True])
def test_lint_accepts_both_freeze_states(frozen: bool) -> None:
    document = _document(A_CONTRACT_FILE)
    document["frozen"] = frozen
    _lint_file_metadata(document, A_CONTRACT_FILE)


@pytest.mark.parametrize("frozen", ["true", 1, None])
def test_lint_rejects_non_boolean_freeze_state(frozen: Any) -> None:
    document = _document(A_CONTRACT_FILE)
    document["frozen"] = frozen
    with pytest.raises(SchemaLintError, match="must be a boolean"):
        _lint_file_metadata(document, A_CONTRACT_FILE)


def test_lint_rejects_unknown_top_level_facets() -> None:
    document = _document(A_CONTRACT_FILE)
    document["contract_verison"] = 1  # deliberate typo
    with pytest.raises(SchemaLintError, match="unsupported document facet"):
        _lint_file_metadata(document, A_CONTRACT_FILE)


def test_contract_files_are_discovered_and_exclude_the_common_file() -> None:
    discovered = contract_files()
    assert discovered, "expected at least the pilot contracts to be discovered"
    assert COMMON_FILE not in discovered
    assert discovered == sorted(discovered), "emission order must be deterministic"
    assert all(name.endswith(".schema.json") for name in discovered)


def test_v2_contract_files_are_discovered_separately_from_the_frozen_v1_family() -> None:
    v2_files = contract_files(SCHEMA_DIRS[1])
    assert "plugin-manifest.schema.json" in v2_files
    assert "plugin-command-invocation.schema.json" in v2_files
    assert COMMON_FILE not in v2_files


def test_v3_contract_family_is_discovered_with_mixed_lineage_versions() -> None:
    v3_files = contract_files(SCHEMA_DIRS[2])
    assert v3_files == [
        "plugin-declarative-content.schema.json",
        "plugin-distribution-operation.schema.json",
        "plugin-distribution-state.schema.json",
        "plugin-generation.schema.json",
        "plugin-manifest.schema.json",
        "plugin-package-record.schema.json",
        "plugin-remote-mcp-authorization.schema.json",
        "plugin-remote-mcp-binding.schema.json",
        "plugin-runtime-snapshot.schema.json",
    ]
    versions = {
        json.loads((SCHEMA_DIRS[2] / filename).read_text(encoding="utf-8"))["contract_version"]
        for filename in v3_files
    }
    assert versions == {1, 3}


def test_frozen_stage4_budget_view_can_remain_scoped_to_v1_v2() -> None:
    contracts = _build_spec(SCHEMA_DIRS[:2])["contracts"]
    assert "PluginManifestV2" in contracts
    assert "PluginManifestV3" not in contracts
    assert "PluginDistributionStateV1" not in contracts


def test_each_contract_retains_its_family_structural_budget() -> None:
    contracts = _build_spec()["contracts"]
    assert contracts["PluginManifestV1"]["structure"]["max_payload_utf8_bytes"] == 65536
    assert contracts["PluginManifestV3"]["structure"]["max_payload_utf8_bytes"] == 4194304


def test_every_discovered_contract_file_parses_and_lints() -> None:
    for filename in contract_files():
        document = _document(filename)
        _lint_file_metadata(document, filename)
        assert "root" in document, f"{filename}: missing 'root'"


def test_local_defs_overlay_shared_defs() -> None:
    shared = {"commit_epoch": {"type": "integer"}}
    document = {"defs": {"my_local": {"type": "boolean"}}}
    merged = _merge_local_defs(document, shared, A_CONTRACT_FILE)
    assert set(merged) == {"commit_epoch", "my_local"}
    # The shared def must survive the overlay unmodified.
    assert merged["commit_epoch"] is shared["commit_epoch"]


def test_local_defs_may_not_shadow_a_shared_def() -> None:
    shared = {"commit_epoch": {"type": "integer"}}
    document = {"defs": {"commit_epoch": {"type": "string"}}}
    with pytest.raises(SchemaLintError, match="may not shadow"):
        _merge_local_defs(document, shared, A_CONTRACT_FILE)


def test_absent_local_defs_leaves_shared_defs_untouched() -> None:
    shared = {"commit_epoch": {"type": "integer"}}
    merged = _merge_local_defs({}, shared, A_CONTRACT_FILE)
    assert merged == shared


def test_generated_artifacts_are_current() -> None:
    """A hand-edited generated file, or a schema edit without a regen, fails here."""
    root = Path(SCHEMA_DIR).resolve().parents[2]
    completed = subprocess.run(
        [sys.executable, str(root / "scripts" / "generate_plugin_contracts.py"), "--check"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, f"generator reports stale artifacts:\n{completed.stdout}\n{completed.stderr}"


def test_common_file_declares_a_boolean_freeze_state() -> None:
    """The freeze state must be a boolean -- deliberately NOT pinned to False.

    Pinning today's value would re-create, one layer out, the exact defect this
    module documents above: the W7 freeze flip sets every contract to
    ``frozen: true`` at once, and this file is a required test for the plugin
    rule in changed_target_test_map.json, so a hard ``is False`` assertion here
    would block the very commit that performs the flip.
    """
    assert isinstance(_document(COMMON_FILE)["frozen"], bool)
