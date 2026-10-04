"""Parity: the checked-in tool-family table matches the tool manifest.

``TOOL_FAMILY_NAMES`` had drifted to name 16 tools no manifest offers while
missing 24 that it does; this pins it to the manifest in both directions.
"""

from __future__ import annotations

import json
from collections import defaultdict

from sidecar.ai.tools.catalog import tool_manifest_path
from sidecar.ai.tools.tool_families import (
    KNOWN_TOOL_FAMILIES,
    RETIRED_TOOL_FAMILY_NAMES,
    TOOL_FAMILY_NAMES,
    tool_family_for_status,
)


def _manifest_families() -> dict[str, set[str]]:
    manifest = json.loads(tool_manifest_path().read_text(encoding="utf-8"))
    families: dict[str, set[str]] = defaultdict(set)
    for tool in manifest["tools"]:
        families[str(tool["tool_family"])].add(str(tool["name"]))
    return dict(families)


def test_tool_family_names_match_the_manifest_exactly() -> None:
    table = {family: set(names) for family, names in TOOL_FAMILY_NAMES.items()}
    assert table == _manifest_families()


def test_retired_names_are_absent_from_the_manifest_and_live_table() -> None:
    manifest_names = set().union(*_manifest_families().values())
    retired = {name for names in RETIRED_TOOL_FAMILY_NAMES.values() for name in names}
    assert not retired & manifest_names
    live = {name for names in TOOL_FAMILY_NAMES.values() for name in names}
    assert not retired & live


def test_known_families_are_manifest_families_plus_documented_extras() -> None:
    manifest_families = set(_manifest_families())
    assert manifest_families <= KNOWN_TOOL_FAMILIES
    retired_only = set(RETIRED_TOOL_FAMILY_NAMES) - manifest_families
    assert retired_only == {"browser", "rich_files"}
    assert KNOWN_TOOL_FAMILIES - manifest_families == {"other"} | retired_only


def test_name_fallback_classifies_manifest_and_retired_names() -> None:
    assert tool_family_for_status(name="run_command", tool_family=None) == "shell"
    assert tool_family_for_status(name="create_artifact", tool_family="") == "artifact"
    assert tool_family_for_status(name="browser_open", tool_family=None) == "browser"
    assert tool_family_for_status(name="lsp_definition", tool_family=None) == "code_intelligence"
    assert tool_family_for_status(name="mcp__x__y", tool_family=None) is None
