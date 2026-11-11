"""A tool_search result says the tools it found are callable now, or what to try (row 129, C4)."""

from __future__ import annotations

from sidecar.ai.tools.tool_search import ToolSearchIndex, _IndexEntry
from sidecar.ai.tools.tool_search_handler import handle_tool_search


def _index() -> ToolSearchIndex:
    return ToolSearchIndex(
        [
            _IndexEntry(name="mcp__git__commit", description="Commit", search_hint="", is_mcp=True),
            _IndexEntry(name="mcp__db__query", description="Query DB", search_hint="", is_mcp=True),
        ]
    )


_SCHEMAS = {
    "mcp__git__commit": {"name": "mcp__git__commit", "description": "Commit changes"},
    "mcp__db__query": {"name": "mcp__db__query", "description": "Query DB"},
}


def test_a_result_with_matches_ends_by_saying_they_can_be_called_now() -> None:
    result = handle_tool_search(
        {"query": "git"}, search_index=_index(), schema_for=_SCHEMAS.get, un_deferred_set=set(),
    )

    last = result.output.splitlines()[-1]
    assert "can call" in last and "now" in last and "names listed" in last


def test_no_match_says_what_to_try_instead() -> None:
    result = handle_tool_search(
        {"query": "zzzznonexistent"}, search_index=_index(), schema_for=_SCHEMAS.get,
        un_deferred_set=set(),
    )

    assert result.output.startswith("No tools found matching 'zzzznonexistent'.")
    assert "other keywords" in result.output
    assert "select:ToolName" in result.output


def test_tools_without_a_schema_are_not_called_callable() -> None:
    result = handle_tool_search(
        {"query": "select:mcp__db__query"}, search_index=_index(), schema_for=lambda _n: None,
        un_deferred_set=set(),
    )

    assert "can call" not in result.output


def test_a_mixed_result_names_the_unavailable_exception() -> None:
    schemas = {"mcp__git__commit": _SCHEMAS["mcp__git__commit"]}
    result = handle_tool_search(
        {"query": "select:mcp__git__commit,mcp__db__query"}, search_index=_index(),
        schema_for=schemas.get, un_deferred_set=set(),
    )

    assert "mcp__db__query: Query DB (not available)" in result.output
    assert result.output.splitlines()[-1].endswith("(except any marked not available).")
