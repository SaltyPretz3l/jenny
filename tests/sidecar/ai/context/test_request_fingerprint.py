from __future__ import annotations

import re

from sidecar.ai.context.prompt_cache import CacheSection, StructuredSystemPrompt
from sidecar.ai.context.request_fingerprint import (
    PROMPT_VERSION,
    RequestFingerprint,
    compute_request_fingerprint,
)


def test_prompt_version_tracks_personality_system_v4() -> None:
    assert PROMPT_VERSION == "jenny-prompt-v4-2026-08-21"


def _tool(name: str, description: str = "tool") -> dict[str, object]:
    return {
        "name": name,
        "description": description,
        "parameters": {"type": "object", "properties": {}},
    }


def test_same_prefix_yields_same_hash() -> None:
    prompt = StructuredSystemPrompt(
        sections=(
            CacheSection(name="identity", content="You are Jenny.", cacheable=True),
            CacheSection(name="rules", content="Be helpful.", cacheable=True),
        ),
        session_start_date="2026-05-01",
        current_date="2026-07-18",
    )
    a = compute_request_fingerprint(system_prompt=prompt, tool_schemas=[])
    b = compute_request_fingerprint(system_prompt=prompt, tool_schemas=[])
    assert a.prefix_hash == b.prefix_hash


def test_tool_order_does_not_affect_hash() -> None:
    a_tools = [_tool("alpha"), _tool("bravo"), _tool("charlie")]
    b_tools = [_tool("charlie"), _tool("alpha"), _tool("bravo")]
    a = compute_request_fingerprint(system_prompt="sys", tool_schemas=a_tools)
    b = compute_request_fingerprint(system_prompt="sys", tool_schemas=b_tools)
    assert a.tool_schema_hash == b.tool_schema_hash
    assert a.per_tool_schema_hashes == b.per_tool_schema_hashes


def test_per_tool_hashes_keyed_by_name() -> None:
    tools = [_tool("read_file"), _tool("write_file")]
    fp = compute_request_fingerprint(system_prompt="sys", tool_schemas=tools)
    assert set(fp.per_tool_schema_hashes.keys()) == {"read_file", "write_file"}
    for digest in fp.per_tool_schema_hashes.values():
        assert isinstance(digest, str) and len(digest) == 16


def test_dynamic_content_outside_prefix_is_excluded() -> None:
    cacheable = (
        CacheSection(name="identity", content="You are Jenny.", cacheable=True),
        CacheSection(name="rules", content="Be helpful.", cacheable=True),
    )
    prompt_a = StructuredSystemPrompt(
        sections=(
            *cacheable,
            CacheSection(name="dynamic", content="user said hello", cacheable=False),
        ),
        session_start_date="2026-05-01",
    )
    prompt_b = StructuredSystemPrompt(
        sections=(
            *cacheable,
            CacheSection(name="dynamic", content="user said something else", cacheable=False),
        ),
        session_start_date="2026-05-01",
    )
    a = compute_request_fingerprint(system_prompt=prompt_a, tool_schemas=[])
    b = compute_request_fingerprint(system_prompt=prompt_b, tool_schemas=[])
    assert a.prefix_hash == b.prefix_hash


def test_current_date_changes_prefix_once_per_day() -> None:
    sections = (CacheSection(name="identity", content="You are Jenny."),)
    day_one_a = StructuredSystemPrompt(
        sections=sections,
        session_start_date="2026-05-01",
        current_date="2026-07-18",
    )
    day_one_b = StructuredSystemPrompt(
        sections=sections,
        session_start_date="2026-05-01",
        current_date="2026-07-18",
    )
    day_two = StructuredSystemPrompt(
        sections=sections,
        session_start_date="2026-05-01",
        current_date="2026-07-19",
    )

    first = compute_request_fingerprint(system_prompt=day_one_a, tool_schemas=[])
    same_day = compute_request_fingerprint(system_prompt=day_one_b, tool_schemas=[])
    next_day = compute_request_fingerprint(system_prompt=day_two, tool_schemas=[])

    assert first.prefix_hash == same_day.prefix_hash
    assert first.prefix_hash != next_day.prefix_hash


def test_prefix_stops_at_first_noncacheable_section() -> None:
    prompt_a = StructuredSystemPrompt(
        sections=(
            CacheSection(name="a", content="A", cacheable=True),
            CacheSection(name="boundary", content="B", cacheable=False),
            CacheSection(name="late", content="D1", cacheable=True),
        ),
    )
    prompt_b = StructuredSystemPrompt(
        sections=(
            CacheSection(name="a", content="A", cacheable=True),
            CacheSection(name="boundary", content="B", cacheable=False),
            CacheSection(name="late", content="D2", cacheable=True),
        ),
    )

    first = compute_request_fingerprint(system_prompt=prompt_a, tool_schemas=[])
    changed_after_boundary = compute_request_fingerprint(
        system_prompt=prompt_b,
        tool_schemas=[],
    )

    assert first.prefix_hash == changed_after_boundary.prefix_hash
    assert first.prefix_section_count == 1


def test_tool_schema_count_matches_input() -> None:
    tools = [_tool(f"t{i}") for i in range(7)]
    fp = compute_request_fingerprint(system_prompt="sys", tool_schemas=tools)
    assert fp.tool_schema_count == 7


def test_generated_at_format() -> None:
    fp = compute_request_fingerprint(system_prompt="sys", tool_schemas=[])
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$", fp.generated_at)


def test_compute_handles_empty_inputs() -> None:
    fp = compute_request_fingerprint(system_prompt=None, tool_schemas=None)
    assert isinstance(fp, RequestFingerprint)
    assert fp.prompt_version == PROMPT_VERSION
    assert fp.tool_schema_count == 0
    assert fp.prefix_section_count == 0
    assert fp.per_tool_schema_hashes == {}
    assert isinstance(fp.prefix_hash, str) and len(fp.prefix_hash) == 16
    assert isinstance(fp.tool_schema_hash, str) and len(fp.tool_schema_hash) == 16


def test_blank_prompt_version_falls_back_to_current_version() -> None:
    fp = compute_request_fingerprint(
        system_prompt="sys",
        tool_schemas=[],
        prompt_version="   ",
    )

    assert fp.prompt_version == PROMPT_VERSION


def test_string_system_prompt_has_section_count_one() -> None:
    fp = compute_request_fingerprint(system_prompt="hello", tool_schemas=[])
    assert fp.prefix_section_count == 1


def test_none_system_prompt_has_section_count_zero() -> None:
    fp = compute_request_fingerprint(system_prompt=None, tool_schemas=[])
    assert fp.prefix_section_count == 0


def test_to_dict_roundtrip() -> None:
    tools = [_tool("alpha"), _tool("bravo")]
    fp = compute_request_fingerprint(system_prompt="sys", tool_schemas=tools)
    payload = fp.to_dict()
    assert set(payload.keys()) == {
        "prompt_version",
        "prefix_hash",
        "tool_schema_hash",
        "per_tool_schema_hashes",
        "prefix_section_count",
        "tool_schema_count",
        "generated_at",
    }
    assert payload["prefix_hash"] == fp.prefix_hash
    assert payload["prompt_version"] == PROMPT_VERSION
    assert payload["per_tool_schema_hashes"] == fp.per_tool_schema_hashes
