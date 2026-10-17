from __future__ import annotations

import hashlib
import json

import pytest

from sidecar.ai.mcp.tool_surface import (
    MAX_DESCRIPTION_CHARS,
    MAX_TOOLS,
    ToolSurfaceError,
    summarize_tools,
    tools_digest,
)


@pytest.mark.parametrize("change", [
    {"side_effecting": False},
    {"actions": {"read": {"side_effecting": False}}},
    {"actions": {"read": {"side_effecting": True}}},
])
def test_digest_covers_execution_policy(change: dict) -> None:
    original = {"name": "lookup", "description": "Search", "inputSchema": {"type": "object"}}
    before, _ = summarize_tools([original])
    after, _ = summarize_tools([{**original, **change}])
    assert tools_digest(before) != tools_digest(after)


@pytest.mark.parametrize("tools", [
    [{"name": f"tool_{index}"} for index in range(MAX_TOOLS + 1)],
    [{"name": "bad", "inputSchema": {"description": "x" * 5000}}],
    [{"name": "x" * 129}],
    [{"name": "tool", "description": "x" * (MAX_DESCRIPTION_CHARS + 1)}],
    [{"description": "missing name"}],
])
def test_incomplete_surface_is_rejected(tools: list) -> None:
    with pytest.raises(ValueError):
        summarize_tools(tools)


def test_digest_version_invalidates_existing_approvals() -> None:
    tools, _ = summarize_tools([{"name": "lookup"}])
    legacy = [{"name": "lookup", "description": "", "schema_digest": hashlib.sha256(b"{}").hexdigest()}]
    old_digest = hashlib.sha256(json.dumps(legacy, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    assert tools_digest(tools) != old_digest


def test_duplicate_tool_names_are_rejected() -> None:
    with pytest.raises(ValueError):
        summarize_tools([{"name": "lookup"}, {"name": " lookup ", "description": "Changed"}])


def _nested(depth: int) -> object:
    """A value whose deepest node sits ``depth`` hops below it, alternating object/array like rea."""
    if depth == 0:
        return "leaf"
    inner = _nested(depth - 1)
    return {"items": inner} if depth % 2 else [inner]


def test_measured_rea_surface_is_admitted() -> None:
    rows, _ = summarize_tools([
        {"name": "inspect_binary_layout", "description": "d" * 1177},
        {"name": "compare_web_captures", "inputSchema": _nested(19)},
    ])
    assert [row["name"] for row in rows] == ["compare_web_captures", "inspect_binary_layout"]


@pytest.mark.parametrize(("tool", "reason", "bound", "limit", "observed"), [
    ({"name": "wordy", "description": "x" * 2049},
     "tool_text_exceeded", "description_chars", 2048, 2049),
    ({"name": "deep", "inputSchema": _nested(33)}, "schema_structure_exceeded", "schema_depth", 32, 33),
    ({"name": "wide", "inputSchema": {"a": [[0] * 200 for _ in range(30)]}},
     "schema_structure_exceeded", "schema_nodes", 4096, 4097),
    ({"name": "keys", "inputSchema": {"properties": {f"k{i}": 1 for i in range(129)}}},
     "schema_object_exceeded", "schema_keys", 128, 129),
    ({"name": "items", "inputSchema": {"enum": list(range(257))}},
     "schema_array_exceeded", "schema_items", 256, 257),
    ({"name": "text", "inputSchema": {"description": "x" * 4097}},
     "schema_string_exceeded", "schema_string_chars", 4096, 4097),
])
def test_violation_names_the_tool_and_the_bound(
    tool: dict, reason: str, bound: str, limit: int, observed: int,
) -> None:
    with pytest.raises(ToolSurfaceError) as caught:
        summarize_tools([{"name": "fine"}, tool])
    error = caught.value
    assert str(error) == reason
    assert error.log_data() == {
        "reason": reason, "tool": tool["name"], "bound": bound, "limit": limit, "observed": observed,
    }


def test_surface_level_violations_report_bounded_detail() -> None:
    with pytest.raises(ToolSurfaceError) as too_many:
        summarize_tools([{"name": f"tool_{index}"} for index in range(MAX_TOOLS + 1)])
    assert too_many.value.log_data() == {
        "reason": "tool_surface_exceeded", "bound": "tool_count", "limit": 256, "observed": 257,
    }
    with pytest.raises(ToolSurfaceError) as long_name:
        summarize_tools([{"name": "n" * 400}])
    assert long_name.value.log_data() == {
        "reason": "tool_text_exceeded", "tool": "n" * 128, "bound": "name_chars",
        "limit": 128, "observed": 400,
    }


def test_tools_digest_is_stable_across_the_admission_change() -> None:
    rows, _ = summarize_tools([
        {"name": "lookup", "description": "Search docs", "inputSchema": {
            "type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]}},
        {"name": "write_note", "side_effecting": True, "actions": {"read": {"side_effecting": False}}},
    ])
    assert tools_digest(rows) == "a24a27d7927804a3d23e6a3d6fa283eef15636b86c0962ce01e8b1bbbc13b853"


_READ_ONLY = {"readOnlyHint": True}


@pytest.mark.parametrize("annotations", [
    None,
    {},
    {"readOnlyHint": False},
    {"readOnlyHint": "true"},
    {"openWorldHint": True},
    {"readOnlyHint": True, "openWorldHint": True},
    {"readOnlyHint": True, "destructiveHint": True},
    {"title": "Lookup", "idempotentHint": True},
])
def test_surface_without_a_read_only_claim_keeps_its_digest(annotations: dict | None) -> None:
    tools = [
        {"name": "lookup", "description": "Search docs", "inputSchema": {
            "type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]}},
        {"name": "write_note", "side_effecting": True, "actions": {"read": {"side_effecting": False}}},
    ]
    tools[0]["annotations"] = annotations
    rows, _ = summarize_tools(tools)
    assert all("read_only_claim" not in row for row in rows)
    assert tools_digest(rows) == "a24a27d7927804a3d23e6a3d6fa283eef15636b86c0962ce01e8b1bbbc13b853"


@pytest.mark.parametrize("annotations", [
    _READ_ONLY,
    {"readOnlyHint": True, "openWorldHint": False, "destructiveHint": False},
])
def test_a_qualifying_read_only_claim_is_recorded_in_the_row(annotations: dict) -> None:
    rows, _ = summarize_tools([{"name": "list_unknowns", "annotations": annotations}, {"name": "open_binary"}])
    claims = {row["name"]: row.get("read_only_claim") for row in rows}
    assert claims == {"list_unknowns": True, "open_binary": None}
    assert rows[0]["side_effecting"] is True


def test_a_claim_is_display_only_until_the_row_opts_in() -> None:
    # Astra W2 F4: a surface approved before claims were recorded (or by a row whose
    # switch is off) keeps its digest; only an opted-in row hashes the claim.
    plain = {"name": "list_unknowns", "description": "List"}
    claiming = {**plain, "annotations": _READ_ONLY}
    assert tools_digest(summarize_tools([claiming])[0]) == tools_digest(summarize_tools([plain])[0])
    assert tools_digest(summarize_tools([claiming])[0], read_only_claims=True) != tools_digest(
        summarize_tools([plain])[0], read_only_claims=True
    )


def test_adding_or_dropping_a_read_only_claim_changes_the_digest() -> None:
    plain = {"name": "list_unknowns", "description": "List"}
    claiming = {**plain, "annotations": _READ_ONLY}
    digests = [tools_digest(summarize_tools([tool])[0], read_only_claims=True) for tool in (
        plain,
        claiming,
        {**plain, "annotations": {**_READ_ONLY, "destructiveHint": True}},
        {**plain, "annotations": {**_READ_ONLY, "openWorldHint": True}},
    )]
    assert digests[0] != digests[1]
    assert digests[1] != digests[2]
    assert digests[1] != digests[3]
    assert digests[0] == digests[2] == digests[3]


def test_oversized_annotations_are_refused_with_the_tool_named() -> None:
    with pytest.raises(ToolSurfaceError) as caught:
        summarize_tools([{"name": "fine"}, {"name": "noisy", "annotations": {"title": "x" * 4097}}])
    assert caught.value.log_data() == {
        "reason": "schema_string_exceeded", "tool": "noisy", "bound": "schema_string_chars",
        "limit": 4096, "observed": 4097,
    }
