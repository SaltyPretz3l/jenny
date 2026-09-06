"""Tests for prompt cache boundary markers."""

from __future__ import annotations

from datetime import date

import pytest

from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.context.prompt_cache import (
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    CacheSection,
    StructuredSystemPrompt,
    build_structured_system_prompt,
    resolve_current_date,
)

# ── CacheSection basics ────────────────────────────────────────────


class TestCacheSection:
    def test_defaults_to_cacheable(self) -> None:
        section = CacheSection(name="intro", content="Hello")
        assert section.cacheable is True

    def test_non_cacheable_flag(self) -> None:
        section = CacheSection(name="lessons", content="X", cacheable=False)
        assert section.cacheable is False

    def test_frozen(self) -> None:
        section = CacheSection(name="a", content="b")
        with pytest.raises(AttributeError):
            section.name = "c"  # type: ignore[misc]


# ── StructuredSystemPrompt ──────────────────────────────────────────


class TestStructuredSystemPrompt:
    def test_to_text_no_boundary_when_all_cacheable(self) -> None:
        prompt = StructuredSystemPrompt(
            sections=(
                CacheSection(name="a", content="A"),
                CacheSection(name="b", content="B"),
            ),
        )
        assert SYSTEM_PROMPT_DYNAMIC_BOUNDARY not in prompt.to_text()
        assert prompt.to_text() == "A\n\nB"

    def test_to_text_inserts_boundary(self) -> None:
        prompt = StructuredSystemPrompt(
            sections=(
                CacheSection(name="static", content="Static"),
                CacheSection(name="dynamic", content="Dynamic", cacheable=False),
            ),
        )
        text = prompt.to_text()
        assert SYSTEM_PROMPT_DYNAMIC_BOUNDARY in text
        parts = text.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
        assert "Static" in parts[0]
        assert "Dynamic" in parts[1]

    def test_to_text_no_boundary_when_disabled(self) -> None:
        prompt = StructuredSystemPrompt(
            sections=(
                CacheSection(name="static", content="S"),
                CacheSection(name="dyn", content="D", cacheable=False),
            ),
        )
        text = prompt.to_text(insert_boundary=False)
        assert SYSTEM_PROMPT_DYNAMIC_BOUNDARY not in text
        assert text == "S\n\nD"

    def test_str_delegates_to_to_text(self) -> None:
        prompt = StructuredSystemPrompt(
            sections=(CacheSection(name="x", content="X"),),
        )
        assert str(prompt) == prompt.to_text()

    def test_empty_sections(self) -> None:
        prompt = StructuredSystemPrompt(sections=())
        assert prompt.to_text() == ""

    def test_skips_empty_content(self) -> None:
        prompt = StructuredSystemPrompt(
            sections=(
                CacheSection(name="a", content="A"),
                CacheSection(name="empty", content=""),
                CacheSection(name="b", content="B"),
            ),
        )
        assert prompt.to_text() == "A\n\nB"

    def test_multiple_non_cacheable_grouped(self) -> None:
        prompt = StructuredSystemPrompt(
            sections=(
                CacheSection(name="static1", content="S1"),
                CacheSection(name="static2", content="S2"),
                CacheSection(name="dyn1", content="D1", cacheable=False),
                CacheSection(name="dyn2", content="D2", cacheable=False),
            ),
        )
        text = prompt.to_text()
        parts = text.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
        assert len(parts) == 2
        assert "S1" in parts[0]
        assert "S2" in parts[0]
        assert "D1" in parts[1]
        assert "D2" in parts[1]

    def test_session_start_date_preserved(self) -> None:
        prompt = StructuredSystemPrompt(
            sections=(CacheSection(name="a", content="A"),),
            session_start_date="2025-01-15",
        )
        assert prompt.session_start_date == "2025-01-15"

    def test_current_date_preserved_separately(self) -> None:
        prompt = StructuredSystemPrompt(
            sections=(CacheSection(name="a", content="A"),),
            session_start_date="2025-01-15",
            current_date="2026-07-18",
        )
        assert prompt.session_start_date == "2025-01-15"
        assert prompt.current_date == "2026-07-18"


def test_resolve_current_date_uses_local_calendar_date_value() -> None:
    assert resolve_current_date(today=date(2026, 7, 18)) == "2026-07-18"


# ── build_structured_system_prompt ──────────────────────────────────


class TestBuildStructuredSystemPrompt:
    def test_wraps_sections_with_date(self) -> None:
        sections = [
            CacheSection(name="a", content="A"),
            CacheSection(name="b", content="B", cacheable=False),
        ]
        prompt = build_structured_system_prompt(
            sections,
            session_start_date="2025-07-01",
            current_date="2026-07-18",
        )
        assert isinstance(prompt, StructuredSystemPrompt)
        assert len(prompt.sections) == 2
        assert prompt.session_start_date == "2025-07-01"
        assert prompt.current_date == "2026-07-18"

    def test_default_empty_date(self) -> None:
        prompt = build_structured_system_prompt([])
        assert prompt.session_start_date == ""
        assert prompt.current_date == ""

    def test_context_builder_round_trips_session_start_date(self) -> None:
        prompt = ContextBuilder(None).build_system_prompt(
            "Base prompt",
            cache_aware=True,
            session_start_date="2026-03-28",
            current_date="2026-07-18",
        )

        assert isinstance(prompt, StructuredSystemPrompt)
        assert prompt.session_start_date == "2026-03-28"
        assert prompt.current_date == "2026-07-18"
        assert "`2026-07-18`" in str(prompt)
        assert "`2026-03-28`" not in str(prompt)

    def test_context_builder_marks_workspace_instructions_non_cacheable(self, tmp_path) -> None:
        workspace = tmp_path / "workspace"
        skills = workspace / "skills" / "ops"
        skills.mkdir(parents=True)
        (skills / "SKILL.md").write_text(
            "---\nname: Shared Skill\n---\nBody\n",
            encoding="utf-8",
        )
        (workspace / "agentj.md").write_text(
            "Apply workspace-level review norms.",
            encoding="utf-8",
        )

        prompt = ContextBuilder(workspace).build_system_prompt(
            "Base prompt",
            cache_aware=True,
        )

        assert isinstance(prompt, StructuredSystemPrompt)
        section_names = [section.name for section in prompt.sections]
        assert section_names.index("skills") < section_names.index("workspace_instructions")
        workspace_section = next(
            section for section in prompt.sections if section.name == "workspace_instructions"
        )
        assert workspace_section.cacheable is False
        assert "## Workspace Instructions (agentj.md)" in workspace_section.content

    def test_context_builder_marks_workspace_manifest_non_cacheable(self, tmp_path) -> None:
        workspace = tmp_path / "workspace"
        workspace.mkdir(parents=True)
        (workspace / "package.json").write_text("{}", encoding="utf-8")

        prompt = ContextBuilder(workspace).build_system_prompt(
            "Base prompt",
            cache_aware=True,
            workspace_manifest_enabled=True,
        )

        assert isinstance(prompt, StructuredSystemPrompt)
        section = next(
            item for item in prompt.sections if item.name == "workspace_manifest"
        )
        assert section.cacheable is False
        assert section.content.startswith("## Workspace Manifest")

    def test_context_builder_marks_task_capsule_non_cacheable(self, tmp_path) -> None:
        workspace = tmp_path / "workspace"
        workspace.mkdir(parents=True)
        (workspace / "AGENTS.md").write_text("Use narrow diffs.", encoding="utf-8")
        (workspace / "INVENTORY.md").write_text("Sidecar runtime map.", encoding="utf-8")
        (workspace / "WORKSPACE_MANIFEST.md").write_text("Runtime routes.", encoding="utf-8")

        prompt = ContextBuilder(workspace).build_system_prompt(
            "Base prompt",
            cache_aware=True,
            latest_user_content="Fix sidecar context prompt assembly.",
            task_capsule_enabled=True,
        )

        assert isinstance(prompt, StructuredSystemPrompt)
        section = next(item for item in prompt.sections if item.name == "task_capsule")
        assert section.cacheable is False
        assert section.content.startswith("## Coding Task Capsule")
