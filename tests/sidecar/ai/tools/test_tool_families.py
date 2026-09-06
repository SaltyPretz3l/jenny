"""Tests for tool-family registration shared across catalog/status/assembly."""

from __future__ import annotations

import pytest

from sidecar.ai.tools import catalog as catalog_module
from sidecar.ai.tools.tool_families import (
    KNOWN_TOOL_FAMILIES,
    TOOL_FAMILY_ALIASES,
    TOOL_FAMILY_NAMES,
    requested_tool_families,
    tool_family_for_status,
)

_FOUNDATION_FAMILIES = ("browser", "code_intelligence", "rich_files")


@pytest.mark.parametrize("family", _FOUNDATION_FAMILIES)
def test_foundation_families_registered(family: str) -> None:
    assert family in KNOWN_TOOL_FAMILIES
    assert family in TOOL_FAMILY_NAMES
    assert family in TOOL_FAMILY_ALIASES


@pytest.mark.parametrize("family", _FOUNDATION_FAMILIES)
def test_foundation_families_resolve_in_status_lookup(family: str) -> None:
    resolved = tool_family_for_status(name="placeholder", tool_family=family)
    assert resolved == family


@pytest.mark.parametrize("family", sorted(KNOWN_TOOL_FAMILIES))
def test_every_known_descriptor_family_resolves_in_status_lookup(family: str) -> None:
    assert tool_family_for_status(name="placeholder", tool_family=family) == family


@pytest.mark.parametrize("tool_name", TOOL_FAMILY_NAMES["browser"])
def test_browser_family_resolves_all_browser_tools(tool_name: str) -> None:
    assert tool_name in TOOL_FAMILY_NAMES["browser"]
    assert tool_family_for_status(name=tool_name, tool_family=None) == "browser"


@pytest.mark.parametrize(
    "tool_name",
    (
        "pdf_inspect",
        "image_inspect",
        "spreadsheet_inspect",
        "document_inspect",
        "presentation_inspect",
        "notebook_inspect",
    ),
)
def test_rich_files_family_resolves_inspect_tools(tool_name: str) -> None:
    assert tool_name in TOOL_FAMILY_NAMES["rich_files"]
    assert tool_family_for_status(name=tool_name, tool_family=None) == "rich_files"


def test_requested_rich_files_keywords_resolve_family() -> None:
    assert "rich_files" in requested_tool_families("inspect this pdf")
    assert "rich_files" in requested_tool_families("show image dimensions")
    assert "rich_files" in requested_tool_families("inspect this spreadsheet")
    assert "rich_files" in requested_tool_families("inspect this document")
    assert "rich_files" in requested_tool_families("summarize this presentation")
    assert "rich_files" in requested_tool_families("inspect this notebook")


@pytest.mark.parametrize(
    "tool_name",
    tuple(tool_name for tool_name in TOOL_FAMILY_NAMES["git"] if tool_name.startswith("worktree_")),
)
def test_git_family_resolves_all_worktree_tools(tool_name: str) -> None:
    assert tool_family_for_status(name=tool_name, tool_family=None) == "git"


@pytest.mark.parametrize(
    "tool_name", ["workspace_change_baseline", "workspace_change_delta"]
)
def test_git_family_resolves_worktree_tracking_tools(tool_name: str) -> None:
    assert tool_family_for_status(name=tool_name, tool_family=None) == "git"


def test_requested_browser_keyword_resolves_browser_family() -> None:
    assert "browser" in requested_tool_families("use the browser")


@pytest.mark.parametrize("family", _FOUNDATION_FAMILIES)
def test_manifest_validator_accepts_foundation_families(family: str) -> None:
    entry: dict[str, object] = {
        "name": f"sample_{family}_tool",
        "description": "Foundation family acceptance probe.",
        "parameters": {"type": "object", "properties": {}},
        "category": "builtin",
        "source_kind": "builtin",
        "side_effecting": False,
        "read_only": True,
        "owner": "sidecar",
        "tool_family": family,
        "surfaces": ["managed_sidecar"],
        "availability": {
            "config_flag": None,
            "workspace_required": False,
            "platforms": [],
            "defer_eligible": False,
            "always_available": False,
        },
    }
    catalog_module._validate_manifest_payload(  # noqa: SLF001
        {"manifest_version": 2, "tools": [entry]}
    )


def test_knowledge_family_registered() -> None:
    assert "knowledge" in KNOWN_TOOL_FAMILIES
    assert TOOL_FAMILY_NAMES["knowledge"] == (
        "knowledge_search",
        "knowledge_view",
        "knowledge_exec",
    )


@pytest.mark.parametrize(
    "tool_name",
    ("knowledge_search", "knowledge_view", "knowledge_exec"),
)
def test_knowledge_family_resolves_tools(tool_name: str) -> None:
    assert tool_family_for_status(name=tool_name, tool_family=None) == "knowledge"


def test_requested_knowledge_keywords_resolve_family() -> None:
    assert "knowledge" in requested_tool_families("search my knowledge base")


def test_known_tool_families_remains_a_superset_of_existing_dicts() -> None:
    for family in TOOL_FAMILY_NAMES:
        assert family in KNOWN_TOOL_FAMILIES, (
            f"TOOL_FAMILY_NAMES has '{family}' but KNOWN_TOOL_FAMILIES does not"
        )
    for family in TOOL_FAMILY_ALIASES:
        assert family in KNOWN_TOOL_FAMILIES, (
            f"TOOL_FAMILY_ALIASES has '{family}' but KNOWN_TOOL_FAMILIES does not"
        )
