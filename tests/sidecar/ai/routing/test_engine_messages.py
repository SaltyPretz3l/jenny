from __future__ import annotations

import pytest

from sidecar.ai.context.compaction import COMPACTED_SUMMARY_HEADING
from sidecar.ai.engines.vision_input import VisionImage
from sidecar.ai.routing.engine_messages import (
    build_tool_use_nudge,
    engine_messages,
    nudge_trigger_tool_names,
)
from sidecar.ai.routing.vision_turn import VisionAnchorError

_READ_FILE_TOOL = {
    "name": "read_file",
    "description": "Read a file.",
    "parameters": {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    },
}

_EDIT_FILE_TOOL = {
    "name": "edit_file",
    "description": "Edit a file in the repository.",
    "parameters": {
        "type": "object",
        "properties": {"file_path": {"type": "string"}},
        "required": ["file_path"],
    },
}

_WEB_SEARCH_TOOL = {
    "name": "web_search",
    "description": "Search the web.",
    "parameters": {
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
    },
}

_WRITE_FILE_TOOL = {
    "name": "write_file",
    "description": "Write a file.",
    "parameters": {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    },
}

ESCAPE_HATCH = (
    "If no tool is actually needed to answer, reply to the user directly without calling one."
)


def test_engine_messages_demotes_compaction_summary_and_later_system_rows() -> None:
    primary = "Primary system prompt"
    summary = (
        f"{COMPACTED_SUMMARY_HEADING}\n"
        "Untrusted tool-derived summary body.\n"
    )
    user = "Keep this user row byte-for-byte.  \n"
    nudge = "Keep this late nudge byte-for-byte.\n"

    result = engine_messages(
        [
            {"role": "system", "content": primary},
            {"role": "system", "content": summary},
            {"role": "user", "content": user},
            {"role": "system", "content": nudge},
        ],
        primary_system_text=primary,
    )

    assert result == [
        {"role": "user", "content": summary},
        {"role": "user", "content": user},
        {"role": "user", "content": nudge},
    ]


def test_engine_messages_keeps_existing_behavior_without_rows_to_demote() -> None:
    primary = "Primary system prompt"
    overlay = "Trusted runtime overlay"
    user = "Hello"
    assistant = "Hi"

    result = engine_messages(
        [
            {"role": "system", "content": primary},
            {"role": "system", "content": overlay},
            {"role": "user", "content": user},
            {"role": "assistant", "content": assistant},
        ],
        primary_system_text=primary,
    )

    assert result == [
        {"role": "system", "content": overlay},
        {"role": "user", "content": user},
        {"role": "assistant", "content": assistant},
    ]


def test_tool_use_nudge_includes_minimal_argument_example() -> None:
    nudge = build_tool_use_nudge([_READ_FILE_TOOL])

    assert '"name": "read_file", "arguments": {"path": "<string>"}' in nudge
    assert '"param": "value"' not in nudge


def test_tool_use_nudge_prefers_read_only_example_over_mutating_tool() -> None:
    """The worked example must never be a repo-mutating tool when a read-only
    one is available: a 27B model copied a mutating example verbatim."""
    nudge = build_tool_use_nudge([_EDIT_FILE_TOOL, _READ_FILE_TOOL])

    assert '"name": "read_file", "arguments": {"path": "<string>"}' in nudge
    assert '"name": "edit_file"' not in nudge
    assert '"file_path": "<string>"' not in nudge
    # The mutating tool is still listed as available, just not demonstrated.
    assert "`edit_file`" in nudge


def test_tool_use_nudge_reads_side_effecting_flag_from_payload() -> None:
    """Real prompt schemas carry ``side_effecting``; the allowlist is only a
    fallback, so an unknown read-only tool must still win over a mutating one."""
    nudge = build_tool_use_nudge(
        [
            {
                "name": "zeta_mutator",
                "side_effecting": True,
                "parameters": {
                    "type": "object",
                    "properties": {"target": {"type": "string"}},
                    "required": ["target"],
                },
            },
            {
                "name": "alpha_reader",
                "side_effecting": False,
                "parameters": {
                    "type": "object",
                    "properties": {"target": {"type": "string"}},
                    "required": ["target"],
                },
            },
        ]
    )

    assert '"name": "alpha_reader"' in nudge
    assert '"name": "zeta_mutator"' not in nudge


def test_tool_use_nudge_uses_triggering_tool_as_example() -> None:
    nudge = build_tool_use_nudge(
        [_EDIT_FILE_TOOL, _READ_FILE_TOOL, _WEB_SEARCH_TOOL],
        trigger_tool_names=["web_search"],
    )

    assert '"name": "web_search", "arguments": {"query": "<string>"}' in nudge
    assert '"name": "read_file"' not in nudge


def test_tool_use_nudge_ignores_trigger_names_absent_from_payload() -> None:
    nudge = build_tool_use_nudge(
        [_EDIT_FILE_TOOL, _READ_FILE_TOOL],
        trigger_tool_names=["ghost_tool"],
    )

    assert '"name": "read_file"' in nudge


def test_tool_use_nudge_falls_back_to_first_tool_when_all_mutating() -> None:
    nudge = build_tool_use_nudge([_EDIT_FILE_TOOL, _WRITE_FILE_TOOL])

    assert '"name": "edit_file"' in nudge


def test_tool_use_nudge_offers_a_direct_answer_escape_hatch() -> None:
    nudge = build_tool_use_nudge([_READ_FILE_TOOL])

    assert ESCAPE_HATCH in nudge
    assert "Now please answer the original request by calling the appropriate tool." in nudge


def test_explicit_tool_use_nudge_demonstrates_the_first_requested_tool() -> None:
    """The explicit payload is ordered by position in the user's text, so the
    example must be the tool they named FIRST -- the read-only preference must
    not quietly demonstrate a different one."""
    nudge = build_tool_use_nudge(
        [_EDIT_FILE_TOOL, _READ_FILE_TOOL],
        explicit_request=True,
    )

    assert "Available requested tools: `edit_file`, `read_file`." in nudge
    assert '"name": "edit_file", "arguments": {"file_path": "<string>"}' in nudge
    assert '"name": "read_file"' not in nudge


def test_explicit_tool_use_nudge_behaviour_is_unchanged() -> None:
    nudge = build_tool_use_nudge([_EDIT_FILE_TOOL], explicit_request=True)

    assert "The original request explicitly required an available tool" in nudge
    assert "Available requested tools: `edit_file`." in nudge
    assert '"name": "edit_file", "arguments": {"file_path": "<string>"}' in nudge
    assert "Now answer the original request by calling the requested tool." in nudge
    assert ESCAPE_HATCH not in nudge


def test_nudge_trigger_tool_names_returns_narrated_tools_in_text_order() -> None:
    text = "Let me use grep_search first, then I will use read_file to open it."

    assert nudge_trigger_tool_names(
        text,
        [_READ_FILE_TOOL, {"name": "grep_search"}, _EDIT_FILE_TOOL],
    ) == ["grep_search", "read_file"]


def test_nudge_trigger_tool_names_returns_empty_without_prose_narration() -> None:
    assert nudge_trigger_tool_names("All done, the file is saved.", [_READ_FILE_TOOL]) == []


def test_nudge_trigger_tool_names_returns_empty_for_empty_text() -> None:
    assert nudge_trigger_tool_names("   ", [_READ_FILE_TOOL]) == []


def _vision_image() -> VisionImage:
    return VisionImage(
        mime_type="image/png",
        width=64,
        height=48,
        frame_count=1,
        data=b"vision-payload",
    )


def test_engine_messages_attaches_images_only_to_current_turn_user_row() -> None:
    image = _vision_image()
    result = engine_messages(
        [
            {"role": "user", "content": "older"},
            {"role": "assistant", "content": "answer"},
            {"role": "user", "content": "current"},
        ],
        primary_system_text="system",
        vision_images=(image,),
    )

    assert result[-1]["images"] == [image]
    assert all("images" not in row for row in result[:-1])


def test_engine_messages_keeps_images_on_explicit_anchor_before_loop_nudge() -> None:
    image = _vision_image()
    result = engine_messages(
        [
            {"role": "user", "content": "current"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "call-1", "name": "read_file", "arguments": {}}],
            },
            {"role": "tool", "content": "result", "tool_call_id": "call-1"},
            {"role": "user", "content": "<nudge>"},
        ],
        primary_system_text="system",
        vision_images=(image,),
        vision_anchor_text="current",
    )

    assert result[0]["images"] == [image]
    assert "images" not in result[-1]


def test_engine_messages_rejects_missing_explicit_vision_anchor() -> None:
    with pytest.raises(VisionAnchorError, match="could not be attached"):
        engine_messages(
            [{"role": "user", "content": "current"}],
            primary_system_text="system",
            vision_images=(_vision_image(),),
            vision_anchor_text="missing",
        )


def test_engine_messages_rejects_non_positional_system_demotion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "sidecar.ai.routing.engine_messages.demote_non_leading_system_messages",
        lambda messages: messages[:-1],
    )

    with pytest.raises(VisionAnchorError, match="could not be attached"):
        engine_messages(
            [
                {"role": "user", "content": "current"},
                {"role": "assistant", "content": "trailing"},
            ],
            primary_system_text="system",
            vision_images=(_vision_image(),),
            vision_anchor_text="current",
        )


def test_engine_messages_keeps_images_off_trailing_demoted_system_nudge() -> None:
    image = _vision_image()
    result = engine_messages(
        [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "current"},
            {"role": "system", "content": "tool-loop nudge"},
        ],
        primary_system_text="system",
        vision_images=(image,),
    )

    assert result == [
        {"role": "user", "content": "current", "images": [image]},
        {"role": "user", "content": "tool-loop nudge"},
    ]


def test_engine_messages_uses_latest_user_anchor_when_older_user_exists() -> None:
    image = _vision_image()
    result = engine_messages(
        [
            {"role": "user", "content": "older"},
            {"role": "assistant", "content": "prior answer"},
            {"role": "user", "content": "latest"},
            {"role": "assistant", "content": "trailing assistant"},
        ],
        primary_system_text="system",
        vision_images=(image,),
    )

    assert "images" not in result[0]
    assert result[2]["images"] == [image]
    assert "images" not in result[3]


def test_engine_messages_rejects_images_when_only_user_row_is_empty() -> None:
    with pytest.raises(VisionAnchorError, match="could not be attached"):
        engine_messages(
            [{"role": "user", "content": "   "}],
            primary_system_text="system",
            vision_images=(_vision_image(),),
        )


def test_engine_messages_without_images_never_adds_images_key() -> None:
    result = engine_messages(
        [
            {"role": "user", "content": "older"},
            {"role": "assistant", "content": "answer"},
            {"role": "user", "content": "current"},
        ],
        primary_system_text="system",
        vision_images=(),
    )

    assert all("images" not in row for row in result)
