"""Row 53 S5: the rea preset keeps a starter set visible to a 32k local model.

Built from the captured rea 6.4.0 ``tools/list`` (fixtures/rea_starter_tools.json):
the 12 starter tools carry their real description and inputSchema; the other
158 carry their real name and description plus a padded schema of the captured
compact size, so the tst-auto token estimate sees the real surface.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.mcp.presets import MCP_SERVER_PRESETS, preset_guidance, starter_tool_names
from sidecar.ai.mcp.tool_namespace import namespace_mcp_tool_name
from sidecar.ai.tools.assembly import ToolAssemblyContext, assemble_tool_contract
from sidecar.ai.tools.catalog import (
    MANAGED_SIDECAR_SURFACE,
    CanonicalToolDescriptor,
    normalize_runtime_descriptor,
)
from sidecar.ai.tools.tool_search import (
    DeferralMode,
    ToolResolutionContext,
    build_search_index,
    compute_deferral_set,
)
from tests.sidecar.ai.tools.test_assembly import MODE_ASSIST, _descriptor

_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "rea_starter_tools.json"
_MANAGED_CONTEXT_WINDOW = 32_768
# chars/4 over the compact provider-facing schemas (name, description, parameters)
# of the 12 real starter tools: what un-deferring them costs every rea turn.
_STARTER_SCHEMA_TOKENS = 6_927


@lru_cache(maxsize=1)
def _fixture() -> dict[str, Any]:
    return json.loads(_FIXTURE.read_text(encoding="utf-8"))


def _compact(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _padded_schema(schema_chars: int) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": "object", "description": ""}
    schema["description"] = "x" * max(0, schema_chars - len(_compact(schema)))
    return schema


def _rea_descriptors(server_name: str = "rea") -> tuple[CanonicalToolDescriptor, ...]:
    fixture = _fixture()
    raw = [
        (tool["name"], tool["description"], tool["inputSchema"])
        for tool in fixture["starter_tools"]
    ] + [
        (tool["name"], tool["description"], _padded_schema(tool["schema_chars"]))
        for tool in fixture["other_tools"]
    ]
    return tuple(
        normalize_runtime_descriptor(
            MCPToolDescriptor(
                name=namespace_mcp_tool_name(server_name, name),
                description=description,
                input_schema=schema,
                side_effecting=True,
                server_name=server_name,
                server_tool_name=name,
            )
        )
        for name, description, schema in raw
    )


def _rea_names(group: str) -> frozenset[str]:
    return frozenset(namespace_mcp_tool_name("rea", tool["name"]) for tool in _fixture()[group])


def test_rea_preset_names_the_twelve_captured_starter_tools() -> None:
    preset = MCP_SERVER_PRESETS["rea"]

    assert len(preset.starter_tools) == 12
    assert set(preset.starter_tools) == {tool["name"] for tool in _fixture()["starter_tools"]}
    assert starter_tool_names("rea") == _rea_names("starter_tools")
    assert "mcp__rea__inspect_binary_layout" in starter_tool_names("rea")


def test_rea_guidance_is_static_and_within_its_budget() -> None:
    guidance = preset_guidance("rea")

    assert guidance is not None
    assert len(guidance) <= 1_700
    # Astra W2 F3: the workflow names only calls the captured starter schemas accept.
    assert "mcp__rea__open_binary with the absolute path" in guidance
    assert "mcp__rea__binary_session (no arguments)" in guidance
    assert "session id" not in guidance
    assert guidance.startswith("rea (reverse engineering) is connected as mcp__rea__* tools.")
    assert guidance.count("\n") == 2
    assert "\r" not in guidance


def test_a_server_with_another_name_gets_no_preset() -> None:
    for server_name in ("rea2", "REA", " rea", "rea-agents"):
        assert starter_tool_names(server_name) == frozenset()
        assert preset_guidance(server_name) is None


def test_mcp_descriptor_search_hint_reaches_the_catalog_descriptor() -> None:
    descriptor = normalize_runtime_descriptor(
        MCPToolDescriptor(
            name="mcp__rea__binary_session",
            description="Report the session.",
            input_schema={"type": "object"},
            side_effecting=True,
            server_name="rea",
            search_hint="session status",
        )
    )

    assert descriptor.search_hint == "session status"
    assert descriptor.connection_id == "mcp:rea"


def test_tst_auto_at_32k_keeps_exactly_the_rea_starter_set_undeferred() -> None:
    descriptors = _rea_descriptors()
    assert len(descriptors) == 170

    deferred = compute_deferral_set(
        DeferralMode.TST_AUTO,
        descriptors,
        frozenset(),
        context_window=_MANAGED_CONTEXT_WINDOW,
    )

    assert deferred == _rea_names("other_tools")
    assert len(deferred) == 158
    assert {d.name for d in descriptors} - deferred == starter_tool_names("rea")


def test_a_server_named_rea2_gets_no_starter_set() -> None:
    descriptors = _rea_descriptors("rea2")

    deferred = compute_deferral_set(
        DeferralMode.TST_AUTO,
        descriptors,
        frozenset(),
        context_window=_MANAGED_CONTEXT_WINDOW,
    )

    assert deferred == {d.name for d in descriptors}


def test_starter_tools_are_advertised_with_their_real_schemas() -> None:
    descriptors = _rea_descriptors()
    deferred = compute_deferral_set(
        DeferralMode.TST_AUTO,
        descriptors,
        frozenset(),
        context_window=_MANAGED_CONTEXT_WINDOW,
    )
    tool_search = _descriptor("tool_search", source_kind="synthetic", tool_family="discovery")
    contract = assemble_tool_contract(
        (*descriptors, tool_search),
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config={},
            engine_supports_tool_calling=True,
            mode=MODE_ASSIST,
            plan_mode=False,
            resolution_context=ToolResolutionContext(
                deferred_names=deferred,
                search_index=build_search_index(deferred, descriptors),
            ),
            workspace_root_present=True,
        ),
    )

    real_schemas = {
        namespace_mcp_tool_name("rea", tool["name"]): tool["inputSchema"]
        for tool in _fixture()["starter_tools"]
    }
    full = {s["name"]: s for s in contract.prompt_schemas if "parameters" in s}
    assert set(full) == {*real_schemas, "tool_search"}
    assert all(full[name]["parameters"] == schema for name, schema in real_schemas.items())
    assert {s["name"] for s in contract.prompt_schemas if s.get("defer_loading")} == deferred
    assert all(contract.entry(name).descriptor.connection_id == "mcp:rea" for name in real_schemas)


def test_starter_schema_token_cost_is_recorded() -> None:
    chars = sum(
        len(
            _compact(
                {
                    "name": namespace_mcp_tool_name("rea", tool["name"]),
                    "description": tool["description"],
                    "parameters": tool["inputSchema"],
                }
            )
        )
        for tool in _fixture()["starter_tools"]
    )
    print(f"rea starter schemas: {chars} chars, {chars // 4} tokens at chars/4")

    assert chars // 4 == _STARTER_SCHEMA_TOKENS


def test_search_ranks_rea_tools_by_name_and_first_sentence() -> None:
    descriptors = _rea_descriptors()
    index = build_search_index(frozenset(d.name for d in descriptors), descriptors)

    analysis = [hit.name for hit in index.search("page analysis view")]
    network = [hit.name for hit in index.search("network capture")]

    assert analysis[0] == "mcp__rea__inspect_analysis_view"
    assert "mcp__rea__inspect_web_network_capture" in network[:3]


def test_first_description_sentence_outranks_a_later_mention() -> None:
    later = MCPToolDescriptor(
        name="mcp__rea__compare_runs",
        description="Compare two runs. The result lists every disassembly difference.",
        input_schema={"type": "object"},
        side_effecting=False,
        server_name="rea",
    )
    first = MCPToolDescriptor(
        name="mcp__rea__render_listing",
        description="Render a disassembly listing for one range.\nReturns text.",
        input_schema={"type": "object"},
        side_effecting=False,
        server_name="rea",
    )
    descriptors = tuple(normalize_runtime_descriptor(d) for d in (later, first))
    index = build_search_index(frozenset(d.name for d in descriptors), descriptors)

    hits = index.search("disassembly")

    assert [hit.name for hit in hits] == ["mcp__rea__render_listing", "mcp__rea__compare_runs"]
    assert hits[0].score > hits[1].score


def test_an_explicit_search_hint_is_kept_and_a_derived_one_is_capped() -> None:
    explicit = MCPToolDescriptor(
        name="mcp__rea__a_tool",
        description="Opens files. Mentions firmware later.",
        input_schema={"type": "object"},
        side_effecting=False,
        server_name="rea",
        search_hint="firmware image reader",
    )
    long_first = MCPToolDescriptor(
        name="mcp__rea__b_tool",
        description=("word " * 40) + "firmware at the end of a very long first sentence. Next.",
        input_schema={"type": "object"},
        side_effecting=False,
        server_name="rea",
    )
    descriptors = tuple(normalize_runtime_descriptor(d) for d in (long_first, explicit))
    index = build_search_index(frozenset(d.name for d in descriptors), descriptors)

    hits = index.search("firmware")

    # The explicit hint scores as a hint; the long first sentence is cut at 160
    # chars before "firmware", so b_tool earns only the description weight.
    assert [hit.name for hit in hits] == ["mcp__rea__a_tool", "mcp__rea__b_tool"]
    assert hits[0].score > hits[1].score
