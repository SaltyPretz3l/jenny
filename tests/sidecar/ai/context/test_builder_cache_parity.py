from __future__ import annotations

from sidecar.ai.context.builder import ContextBuilder, RuntimeToolStatus
from sidecar.ai.context.prompt_cache import StructuredSystemPrompt


def test_cache_aware_prompt_includes_requested_tool_availability() -> None:
    statuses = [
        RuntimeToolStatus(
            name="worktree_list",
            display_name="Worktree List",
            available=True,
            tool_family="git",
        )
    ]
    builder = ContextBuilder(None)

    plain = builder.build_system_prompt(
        "Base",
        tool_statuses=statuses,
        latest_user_content="Use the git worktree tool worktree_list.",
    )
    structured = builder.build_system_prompt(
        "Base",
        tool_statuses=statuses,
        latest_user_content="Use the git worktree tool worktree_list.",
        cache_aware=True,
    )

    assert "## Requested Tool Availability" in plain
    assert isinstance(structured, StructuredSystemPrompt)
    section_names = [section.name for section in structured.sections]
    requested_section = structured.sections[section_names.index("requested_tool_availability")]
    assert requested_section.cacheable is False
    assert "## Requested Tool Availability" in requested_section.content


def test_cache_aware_prompt_includes_delegation_after_tool_loop_guidance() -> None:
    statuses = [
        RuntimeToolStatus(
            name="delegate",
            display_name="Delegate",
            available=True,
            tool_family="runtime",
        )
    ]
    builder = ContextBuilder(None)

    plain = builder.build_system_prompt("Base", tool_statuses=statuses)
    structured = builder.build_system_prompt(
        "Base",
        tool_statuses=statuses,
        cache_aware=True,
    )

    assert "## Read-only Delegation" in plain
    assert isinstance(structured, StructuredSystemPrompt)
    section_names = [section.name for section in structured.sections]
    guidance_index = section_names.index("tool_loop_guidance")
    assert section_names[guidance_index + 1] == "subagent_selection_guidance"
    delegation_section = structured.sections[guidance_index + 1]
    assert delegation_section.cacheable is False
    assert "## Read-only Delegation" in delegation_section.content
