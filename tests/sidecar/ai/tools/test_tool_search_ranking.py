"""Red-first: tool_search ranking tiers (W7a, spec §6.2).

The documented defect: a query containing a full underscored tool id could rank
that tool behind a sibling collecting exact name-part points because
exact name-PART matches earn 10 each while a term equal to the FULL tool id
only earns the 3-point full-name fallback. The fix introduces ranking tiers
above the semantic tail: exact id > id prefix > alias > name-part/hint/
description. (The spec's display-name tier folds into the name-part tier:
display names are derived from tool ids, and per-term scoring cannot match a
multi-word display string.)

Also pins (green insurance) the already-shipped suppression behavior:
tool_search is never offered when nothing is deferred (assembly.py — the
spec's Rev 2 "fix" that turned out to be shipped behavior, demoted to a
regression pin).
"""

from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.tools.assembly import (
    ToolAssemblyContext,
    assemble_tool_contract,
)
from sidecar.ai.tools.catalog import MANAGED_SIDECAR_SURFACE, CanonicalToolAvailability
from sidecar.ai.tools.tool_search import (
    ToolResolutionContext,
    build_search_index,
    score_tool,
)
from tests.sidecar.ai.tools.test_assembly import (
    MODE_ASSIST,
    TOOL_NOT_EXPOSED_REASON,
    _descriptor,
)


def _entry(name: str, description: str = "", aliases: tuple[str, ...] = ()) -> SimpleNamespace:
    return SimpleNamespace(
        name=name,
        description=description,
        search_hint="",
        aliases=aliases,
    )


class TestRankingTiers:
    def test_exact_id_query_outranks_generic_part_matches(self) -> None:
        # The spec's motivating case, verbatim: the literal tool id in the
        # query must beat a sibling collecting exact-part points.
        index = build_search_index(
            frozenset({"delete_file", "edit_file"}),
            (
                _entry("delete_file", "Delete a file"),
                _entry("edit_file", "Create or edit file contents"),
            ),
        )
        results = index.search("delete_file create or edit file contents")
        assert results
        assert results[0].name == "delete_file"

    def test_exact_id_term_outranks_exact_part_matches(self) -> None:
        # A term equal to the full id must score strictly above the same term
        # matching as one exact part of a longer sibling id.
        exact_id = score_tool(["worktree"], "worktree", "", is_mcp=False)
        exact_part = score_tool(["worktree"], "worktree_delete", "", is_mcp=False)
        assert exact_id > exact_part

    def test_id_prefix_outranks_any_single_part_match(self) -> None:
        # A term that is a strict prefix of the tool id outranks an exact
        # name-part match (spec tier: prefix > semantic).
        prefix_score = score_tool(["worktre"], "worktree", "", is_mcp=False)
        part_score = score_tool(["delete"], "worktree_delete", "", is_mcp=False)
        assert prefix_score > part_score

    def test_alias_match_outranks_description_matches(self) -> None:
        # An alias hit must beat a description hit — and must make the tool
        # searchable at all (today an alias-only match scores 0 and the tool
        # is absent from results).
        index = build_search_index(
            frozenset({"search_files", "log_reader"}),
            (
                _entry("search_files", "", aliases=("grep",)),
                _entry("log_reader", "grep the logs for entries"),
            ),
        )
        results = index.search("grep")
        assert [r.name for r in results][0] == "search_files"

    def test_prefix_outranks_alias(self) -> None:
        # Spec tier order: prefix > alias.
        prefix_score = score_tool(["grep"], "grep_search", "", is_mcp=False)
        alias_score = score_tool(
            ["grep"], "search_files", "", is_mcp=False, aliases=("grep",)
        )
        assert prefix_score > alias_score

    def test_exact_id_outranks_prefix(self) -> None:
        exact_id = score_tool(["worktree"], "worktree", "", is_mcp=False)
        prefix = score_tool(["worktree"], "worktree_delete", "", is_mcp=False)
        assert exact_id > prefix


class TestToolSearchSuppression:
    def test_tool_search_is_not_offered_when_nothing_is_deferred(self) -> None:
        # Shipped behavior pinned as a regression guard (spec §6.2): with no
        # deferred tools there is nothing to search, so tool_search must not
        # be offered even when its descriptor is present and an index exists.
        read_file = _descriptor("read_file", tool_family="filesystem")
        tool_search = _descriptor(
            "tool_search",
            source_kind="synthetic",
            tool_family="discovery",
            availability=CanonicalToolAvailability(),
        )
        resolution_context = ToolResolutionContext(
            deferred_names=frozenset(),
            un_deferred_names=set(),
            search_index=build_search_index(frozenset(), ()),
        )
        contract = assemble_tool_contract(
            (read_file, tool_search),
            ToolAssemblyContext(
                surface=MANAGED_SIDECAR_SURFACE,
                config={},
                engine_supports_tool_calling=True,
                mode=MODE_ASSIST,
                plan_mode=False,
                resolution_context=resolution_context,
                workspace_root_present=True,
                include_deferred_tools=True,
            ),
        )
        entry = contract.entry("tool_search")
        assert entry.available is False
        assert entry.reason == TOOL_NOT_EXPOSED_REASON
        assert entry.prompt_schema is None
