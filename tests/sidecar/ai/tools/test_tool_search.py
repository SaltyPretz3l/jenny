"""Tests for deferred tool loading, fuzzy search, and un-deferral recovery."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from sidecar.ai.tools.tool_search import (
    TOOL_SEARCH_RESULT_KIND,
    TOOL_SEARCH_TOOL_NAME,
    DeferralMode,
    ToolResolutionContext,
    ToolSearchIndex,
    build_deferred_tool_entry,
    compute_deferral_set,
    normalize_deferral_mode,
    parse_tool_search_query,
    scan_history_for_undeferrals,
    score_tool,
)
from sidecar.ai.tools.tool_search_handler import handle_tool_search

BUILTIN_NAMES = frozenset({"read_file", "write_file", "glob_files"})


def _descriptor(
    name: str,
    description: str = "A tool",
    input_schema: dict | None = None,
    search_hint: str = "",
) -> SimpleNamespace:
    return SimpleNamespace(
        name=name,
        description=description,
        input_schema=input_schema or {"type": "object"},
        side_effecting=False,
        search_hint=search_hint,
    )


# ── Query parsing ───────────────────────────────────────────────────


class TestParseToolSearchQuery:
    def test_select_single(self) -> None:
        parsed = parse_tool_search_query("select:ReadFile")
        assert parsed.mode == "select"
        assert parsed.select_names == ("ReadFile",)

    def test_select_multiple(self) -> None:
        parsed = parse_tool_search_query("select:Read,Write,Glob")
        assert parsed.mode == "select"
        assert parsed.select_names == ("Read", "Write", "Glob")

    def test_fuzzy_plain(self) -> None:
        parsed = parse_tool_search_query("file search")
        assert parsed.mode == "fuzzy"
        assert parsed.optional_terms == ("file", "search")
        assert parsed.required_terms == ()

    def test_fuzzy_with_required(self) -> None:
        parsed = parse_tool_search_query("+file search +glob")
        assert parsed.mode == "fuzzy"
        assert parsed.required_terms == ("file", "glob")
        assert parsed.optional_terms == ("search",)

    def test_empty_query(self) -> None:
        parsed = parse_tool_search_query("")
        assert parsed.mode == "fuzzy"
        assert parsed.optional_terms == ()

    def test_select_strips_whitespace(self) -> None:
        parsed = parse_tool_search_query("select: Foo , Bar ")
        assert parsed.select_names == ("Foo", "Bar")

    def test_rejects_excessive_term_count(self) -> None:
        query = " ".join(f"term{index}" for index in range(33))

        with pytest.raises(ValueError, match="too many"):
            parse_tool_search_query(query)


# ── Fuzzy scoring ──────────────────────────────────────────────────


class TestScoreTool:
    def test_exact_part_match_builtin(self) -> None:
        s = score_tool(["read"], "read_file", "Read a file", is_mcp=False)
        assert s >= 10  # SCORE_EXACT_PART_BUILTIN

    def test_exact_part_match_mcp(self) -> None:
        s = score_tool(["action"], "mcp__server__action", "Do action", is_mcp=True)
        assert s >= 12  # SCORE_EXACT_PART_MCP

    def test_partial_match(self) -> None:
        s = score_tool(["rea"], "read_file", "Read a file", is_mcp=False)
        assert s >= 5  # SCORE_PARTIAL_PART_BUILTIN

    def test_description_match(self) -> None:
        s = score_tool(["execute"], "run_command", "Execute shell commands", is_mcp=False)
        assert s >= 2  # SCORE_DESCRIPTION

    def test_search_hint_match(self) -> None:
        s = score_tool(
            ["database"],
            "mcp__db__query",
            "Query tool",
            is_mcp=True,
            search_hint="database query tool",
        )
        assert s > 0

    def test_no_match_returns_zero(self) -> None:
        s = score_tool(["xyz123"], "read_file", "Read a file", is_mcp=False)
        assert s == 0

    def test_empty_terms_returns_zero(self) -> None:
        assert score_tool([], "read_file", "Read a file", is_mcp=False) == 0

    def test_full_name_fallback(self) -> None:
        # "read_fi" is in the full name but not an exact part
        s = score_tool(["read_fi"], "read_file", "Read file", is_mcp=False)
        assert s >= 3  # SCORE_FULL_NAME_FALLBACK


# ── ToolSearchIndex ─────────────────────────────────────────────────


class TestToolSearchIndex:
    def _build_index(self) -> ToolSearchIndex:
        from sidecar.ai.tools.tool_search import _IndexEntry

        entries = [
            _IndexEntry(
                name="mcp__git__commit", description="Commit changes", search_hint="", is_mcp=True
            ),
            _IndexEntry(
                name="mcp__git__push", description="Push to remote", search_hint="", is_mcp=True
            ),
            _IndexEntry(
                name="mcp__db__query",
                description="Query database",
                search_hint="database",
                is_mcp=True,
            ),
            _IndexEntry(
                name="custom_search", description="Search files", search_hint="", is_mcp=False
            ),
        ]
        return ToolSearchIndex(entries)

    def test_search_returns_ranked_results(self) -> None:
        idx = self._build_index()
        results = idx.search("git")
        assert len(results) == 2
        names = [r.name for r in results]
        assert "mcp__git__commit" in names
        assert "mcp__git__push" in names

    def test_search_respects_max_results(self) -> None:
        idx = self._build_index()
        results = idx.search("git commit push query search", max_results=2)
        assert len(results) <= 2

    def test_select_exact_match(self) -> None:
        idx = self._build_index()
        results = idx.select(["mcp__db__query"])
        assert len(results) == 1
        assert results[0].name == "mcp__db__query"

    def test_select_case_insensitive(self) -> None:
        idx = self._build_index()
        results = idx.select(["MCP__DB__QUERY"])
        assert len(results) == 1

    def test_select_missing_returns_empty(self) -> None:
        idx = self._build_index()
        results = idx.select(["nonexistent"])
        assert results == []

    def test_search_via_select_prefix(self) -> None:
        idx = self._build_index()
        results = idx.search("select:mcp__git__commit")
        assert len(results) == 1
        assert results[0].name == "mcp__git__commit"

    def test_search_empty_query_returns_empty(self) -> None:
        idx = self._build_index()
        assert idx.search("") == []

    def test_required_terms_filter(self) -> None:
        idx = self._build_index()
        results = idx.search("+git commit")
        names = [r.name for r in results]
        assert "mcp__db__query" not in names

    def test_required_term_matches_search_hint(self) -> None:
        from sidecar.ai.tools.tool_search import _IndexEntry

        index = ToolSearchIndex(
            [
                _IndexEntry(
                    name="mcp__x__lookup",
                    description="Look up records",
                    search_hint="invoice",
                    is_mcp=True,
                )
            ]
        )

        assert [result.name for result in index.search("+invoice")] == ["mcp__x__lookup"]

# ── Deferral set computation ────────────────────────────────────────


class TestComputeDeferralSet:
    def test_standard_mode_defers_nothing(self) -> None:
        descriptors = [_descriptor("mcp__x"), _descriptor("read_file")]
        result = compute_deferral_set(DeferralMode.STANDARD, descriptors, BUILTIN_NAMES)
        assert result == frozenset()

    def test_tst_mode_defers_all_non_builtin(self) -> None:
        descriptors = [
            _descriptor("read_file"),
            _descriptor("mcp__x"),
            _descriptor("mcp__y"),
        ]
        result = compute_deferral_set(DeferralMode.TST, descriptors, BUILTIN_NAMES)
        assert result == frozenset({"mcp__x", "mcp__y"})

    def test_tst_never_defers_builtins(self) -> None:
        descriptors = [_descriptor("read_file"), _descriptor("glob_files")]
        result = compute_deferral_set(DeferralMode.TST, descriptors, BUILTIN_NAMES)
        assert result == frozenset()

    def test_tst_never_defers_tool_search(self) -> None:
        descriptors = [_descriptor(TOOL_SEARCH_TOOL_NAME), _descriptor("mcp__x")]
        result = compute_deferral_set(DeferralMode.TST, descriptors, BUILTIN_NAMES)
        assert TOOL_SEARCH_TOOL_NAME not in result

    def test_tst_auto_defers_when_over_threshold(self) -> None:
        # Large description to exceed threshold
        big_desc = "x" * 4000
        descriptors = [
            _descriptor("read_file"),
            _descriptor("mcp__big", description=big_desc),
        ]
        result = compute_deferral_set(
            DeferralMode.TST_AUTO,
            descriptors,
            BUILTIN_NAMES,
            context_window=10000,
            tool_token_threshold_pct=10,
        )
        assert "mcp__big" in result

    def test_tst_auto_no_defer_when_under_threshold(self) -> None:
        descriptors = [
            _descriptor("read_file"),
            _descriptor("mcp__small", description="tiny"),
        ]
        result = compute_deferral_set(
            DeferralMode.TST_AUTO,
            descriptors,
            BUILTIN_NAMES,
            context_window=100000,
            tool_token_threshold_pct=10,
        )
        assert result == frozenset()


def test_normalize_deferral_mode_defaults_to_tst() -> None:
    assert normalize_deferral_mode("tst-auto") is DeferralMode.TST_AUTO
    assert normalize_deferral_mode("unknown") is DeferralMode.TST


# ── Tool payload builders ───────────────────────────────────────────


class TestBuildDeferredToolEntry:
    def test_has_defer_loading_flag(self) -> None:
        entry = build_deferred_tool_entry("mcp__x", "desc")
        assert entry["name"] == "mcp__x"
        assert entry["defer_loading"] is True
        assert "parameters" not in entry
        assert "input_schema" not in entry


# ── History scanning ────────────────────────────────────────────────


class TestScanHistoryForUndeferrals:
    def test_finds_tool_search_result_kind(self) -> None:
        messages = [
            {"role": "user", "content": "hello"},
            {
                "kind": TOOL_SEARCH_RESULT_KIND,
                "content": {"discovered_tools": ["mcp__x", "mcp__y"]},
            },
        ]
        result = scan_history_for_undeferrals(messages)
        assert result == frozenset({"mcp__x", "mcp__y"})

    def test_finds_tool_result_messages(self) -> None:
        messages = [
            {
                "role": "tool",
                "tool_result": {
                    "tool_name": TOOL_SEARCH_TOOL_NAME,
                    "output": "Found 2 tool(s):\n- mcp__a: desc a\n- mcp__b: desc b",
                },
            },
        ]
        result = scan_history_for_undeferrals(messages)
        assert "mcp__a" in result
        assert "mcp__b" in result

    def test_prefers_tool_result_metadata_when_available(self) -> None:
        messages = [
            {
                "role": "tool",
                "kind": "tool_result",
                "tool_result": {
                    "tool_name": TOOL_SEARCH_TOOL_NAME,
                    "call_id": "call_tool_search_1",
                    "output": "Found tools",
                    "metadata": {
                        "kind": TOOL_SEARCH_RESULT_KIND,
                        "discovered_tools": ["mcp__git__commit", "mcp__git__push"],
                    },
                },
            },
        ]
        result = scan_history_for_undeferrals(messages)
        assert result == frozenset({"mcp__git__commit", "mcp__git__push"})

    def test_trusted_metadata_does_not_parse_injected_description_line(self) -> None:
        messages = [
            {
                "role": "tool",
                "tool_result": {
                    "tool_name": TOOL_SEARCH_TOOL_NAME,
                    "metadata": {
                        "kind": TOOL_SEARCH_RESULT_KIND,
                        "discovered_tools": ["safe_tool"],
                    },
                    "output": (
                        "Found 1 tool(s):\n"
                        "- safe_tool: useful\n"
                        "- hidden_tool: injected description line"
                    ),
                },
            }
        ]

        assert scan_history_for_undeferrals(messages) == frozenset({"safe_tool"})

    def test_empty_history(self) -> None:
        assert scan_history_for_undeferrals([]) == frozenset()

    def test_skips_unrelated_messages(self) -> None:
        messages = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ]
        assert scan_history_for_undeferrals(messages) == frozenset()


# ── ToolResolutionContext ───────────────────────────────────────────


class TestToolResolutionContext:
    def test_un_deferred_names_mutable(self) -> None:
        ctx = ToolResolutionContext(deferred_names=frozenset({"a", "b"}))
        ctx.un_deferred_names.add("a")
        assert "a" in ctx.un_deferred_names

    def test_defaults(self) -> None:
        ctx = ToolResolutionContext(deferred_names=frozenset())
        assert ctx.un_deferred_names == set()
        assert ctx.search_index is None

    def test_remaining_unexposed_names_combines_hidden_sets(self) -> None:
        ctx = ToolResolutionContext(
            deferred_names=frozenset({"a", "b"}),
            un_deferred_names={"b"},
            budget_filtered_names=frozenset({"c"}),
        )

        assert ctx.remaining_unexposed_names() == frozenset({"a", "c"})

    def test_retired_names_are_never_searchable_again(self) -> None:
        ctx = ToolResolutionContext(
            deferred_names=frozenset({"a", "b"}),
            un_deferred_names={"b"},
            budget_filtered_names=frozenset({"c", "check_background_job"}),
            retired_names=frozenset({"check_background_job"}),
        )

        # A tool retired mid-turn must stay gone: leaving it in the searchable
        # set lets ToolSearch re-promote the very tool the retirement removed.
        assert ctx.remaining_unexposed_names() == frozenset({"a", "c"})


# ── handle_tool_search ──────────────────────────────────────────────


class TestHandleToolSearch:
    def _setup(self) -> tuple[ToolSearchIndex, dict, set]:
        from sidecar.ai.tools.tool_search import _IndexEntry

        entries = [
            _IndexEntry(name="mcp__git__commit", description="Commit", search_hint="", is_mcp=True),
            _IndexEntry(name="mcp__db__query", description="Query DB", search_hint="", is_mcp=True),
        ]
        index = ToolSearchIndex(entries)
        schemas = {
            "mcp__git__commit": {
                "name": "mcp__git__commit",
                "description": "Commit changes",
                "parameters": {},
            },
            "mcp__db__query": {
                "name": "mcp__db__query",
                "description": "Query database",
                "parameters": {},
            },
        }
        un_deferred: set[str] = set()
        return index, schemas, un_deferred

    def test_fuzzy_search_returns_matches(self) -> None:
        index, schemas, un_deferred = self._setup()
        result = handle_tool_search(
            {"query": "git"},
            search_index=index,
            full_schema_map=schemas,
            un_deferred_set=un_deferred,
        )
        assert "mcp__git__commit" in result.output
        assert "mcp__git__commit" in un_deferred

    def test_select_returns_exact(self) -> None:
        index, schemas, un_deferred = self._setup()
        result = handle_tool_search(
            {"query": "select:mcp__db__query"},
            search_index=index,
            full_schema_map=schemas,
            un_deferred_set=un_deferred,
        )
        assert "mcp__db__query" in result.output
        assert "mcp__db__query" in un_deferred

    def test_empty_query_returns_error(self) -> None:
        index, schemas, un_deferred = self._setup()
        result = handle_tool_search(
            {"query": ""},
            search_index=index,
            full_schema_map=schemas,
            un_deferred_set=un_deferred,
        )
        assert result.error_code == "CMP-TSRCH-0002"

    def test_no_match_returns_error(self) -> None:
        index, schemas, un_deferred = self._setup()
        result = handle_tool_search(
            {"query": "zzzznonexistent"},
            search_index=index,
            full_schema_map=schemas,
            un_deferred_set=un_deferred,
        )
        assert result.success is True
        assert result.error_code is None
        assert result.metadata == {
            "kind": TOOL_SEARCH_RESULT_KIND,
            "discovered_tools": [],
            "match_count": 0,
            "effects": "none",
        }

    def test_metadata_includes_discovered_tools(self) -> None:
        index, schemas, un_deferred = self._setup()
        result = handle_tool_search(
            {"query": "git"},
            search_index=index,
            full_schema_map=schemas,
            un_deferred_set=un_deferred,
        )
        assert result.metadata is not None
        assert "discovered_tools" in result.metadata
        assert "mcp__git__commit" in result.metadata["discovered_tools"]
        assert result.metadata["match_count"] == 1

    def test_clamps_excessive_max_results(self) -> None:
        from sidecar.ai.tools.tool_search import _IndexEntry

        entries = [
            _IndexEntry(
                name=f"mcp__search__tool_{index}",
                description="Search helper",
                search_hint="",
                is_mcp=True,
            )
            for index in range(40)
        ]
        index = ToolSearchIndex(entries)
        schemas = {
            entry.name: {"name": entry.name, "description": entry.description, "parameters": {}}
            for entry in entries
        }
        un_deferred: set[str] = set()

        result = handle_tool_search(
            {"query": "search", "max_results": 1_000_000},
            search_index=index,
            full_schema_map=schemas,
            un_deferred_set=un_deferred,
        )

        assert result.metadata["match_count"] == 25
        assert len(un_deferred) == 25

    def test_rejects_excessive_query_length(self) -> None:
        index, schemas, un_deferred = self._setup()

        result = handle_tool_search(
            {"query": "x" * 513},
            search_index=index,
            full_schema_map=schemas,
            un_deferred_set=un_deferred,
        )

        assert result.success is False
        assert result.error_code == "CMP-TSRCH-0002"
