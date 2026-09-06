from __future__ import annotations

import logging

import pytest

from sidecar.ai.context import builder_skills, context_io
from sidecar.ai.context.builder import (
    ContextBuilder,
    RuntimeToolStatus,
    SkillScope,
    looks_like_current_info_request,
)
from sidecar.ai.context.builder_shared import (
    MAX_BOOTSTRAP_FILE_BYTES,
    MAX_BOOTSTRAP_PROMPT_BYTES,
    MAX_SKILL_FILE_BYTES,
    MAX_SKILL_FILES,
    MAX_SKILL_PROMPT_BYTES,
    MAX_WORKSPACE_CONTEXT_PROMPT_BYTES,
    _extract_frontmatter,
)


@pytest.mark.parametrize(
    ("metadata", "expected"),
    [
        ("jenny:\n    always: true", True),
        ("nanobot:\n    always: true", True),
        ("nanobot:\n    always: true\n  jenny:\n    always: false", False),
    ],
)
def test_skill_always_metadata_prefers_jenny_and_accepts_nanobot_alias(
    metadata, expected, tmp_path
) -> None:
    frontmatter = f"name: Demo\nmetadata:\n  {metadata}\n"
    assert _extract_frontmatter(frontmatter, skill_path=tmp_path / "SKILL.md")[-1] is expected


def test_context_builder_loads_enabled_multi_scope_skills_and_dedupes_realpaths(
    tmp_path,
) -> None:
    bundled_root = tmp_path / "bundled"
    user_root = tmp_path / "user"
    bundled_skill = bundled_root / "ops"
    user_skill = user_root / "ops"
    bundled_skill.mkdir(parents=True)
    user_skill.mkdir(parents=True)
    bundled_file = bundled_skill / "SKILL.md"
    bundled_file.write_text(
        (
            "---\n"
            "name: Shared Skill\n"
            "description: Shared guidance.\n"
            "whenToUse: When debugging shell state.\n"
            "allowedTools:\n"
            "  - read_file\n"
            "---\n"
            "Body\n"
        ),
        encoding="utf-8",
    )
    (user_skill / "SKILL.md").hardlink_to(bundled_file)

    prompt = ContextBuilder(
        tmp_path / "workspace",
        skill_scopes=(
            SkillScope(scope="bundled", root=bundled_root, enabled=True),
            SkillScope(scope="user", root=user_root, enabled=True),
        ),
        skills_system_enabled=True,
    ).build_system_prompt("Base system prompt.")

    assert prompt.count("Shared Skill") == 1
    assert "When to use: When debugging shell state." in prompt
    assert "Allowed tools: read_file" in prompt


def test_context_builder_ignores_disabled_skill_scopes(tmp_path) -> None:
    bundled_root = tmp_path / "bundled"
    bundled_skill = bundled_root / "ops"
    bundled_skill.mkdir(parents=True)
    (bundled_skill / "SKILL.md").write_text(
        "---\nname: Hidden Skill\n---\nBody\n",
        encoding="utf-8",
    )

    prompt = ContextBuilder(
        tmp_path / "workspace",
        skill_scopes=(SkillScope(scope="bundled", root=bundled_root, enabled=False),),
        skills_system_enabled=True,
    ).build_system_prompt("Base system prompt.")

    assert "Hidden Skill" not in prompt


def test_context_builder_skips_invalid_multi_scope_skill_entries(tmp_path) -> None:
    bundled_root = tmp_path / "bundled"
    user_root = tmp_path / "user"
    bundled_skill = bundled_root / "ops"
    broken_skill = user_root / "broken"
    bundled_skill.mkdir(parents=True)
    broken_skill.mkdir(parents=True)
    (bundled_skill / "SKILL.md").write_text(
        "---\nname: Healthy Skill\n---\nBody\n",
        encoding="utf-8",
    )
    (broken_skill / "SKILL.md").write_text(
        "---\nname: Broken Skill\nmetadata:\n  nanobot: [oops\n---\nBody\n",
        encoding="utf-8",
    )

    prompt = ContextBuilder(
        tmp_path / "workspace",
        skill_scopes=(
            SkillScope(scope="bundled", root=bundled_root, enabled=True),
            SkillScope(scope="user", root=user_root, enabled=True),
        ),
        skills_system_enabled=True,
    ).build_system_prompt("Base system prompt.")

    assert "Healthy Skill" in prompt
    assert "Broken Skill" not in prompt


def test_context_builder_filters_skill_tools_against_executable_tools(tmp_path) -> None:
    bundled_root = tmp_path / "bundled"
    bundled_skill = bundled_root / "ops"
    bundled_skill.mkdir(parents=True)
    (bundled_skill / "SKILL.md").write_text(
        (
            "---\n"
            "name: Verify Skill\n"
            "allowedTools:\n"
            "  - read_file\n"
            "  - glob\n"
            "  - web_search\n"
            "---\n"
            "Body\n"
        ),
        encoding="utf-8",
    )

    prompt = ContextBuilder(
        tmp_path / "workspace",
        skill_scopes=(SkillScope(scope="bundled", root=bundled_root, enabled=True),),
        skills_system_enabled=True,
    ).build_system_prompt(
        "Base system prompt.",
        tool_statuses=[
            RuntimeToolStatus(
                name="read_file",
                display_name="Read File",
                available=True,
                description="Read a file from the workspace.",
            ),
            RuntimeToolStatus(
                name="glob_files",
                display_name="Glob Files",
                available=False,
                reason="workspace requirement missing",
            ),
            RuntimeToolStatus(
                name="web_search",
                display_name="Web Search",
                available=False,
                reason="config disabled",
            ),
        ],
    )

    assert "## Executable Tools" in prompt
    assert "Only tools listed as available" in prompt
    assert (
        "Any tool not listed as available in this block is unavailable for this request." in prompt
    )
    assert "Allowed tools: read_file" in prompt
    assert "Allowed tools: read_file, glob_files" not in prompt
    assert "Allowed tools: read_file, web_search" not in prompt
    assert "`web_search`: config disabled" not in prompt
    assert "`glob_files`: workspace requirement missing" not in prompt


def test_context_builder_can_layer_skills_as_separate_runtime_overlay(tmp_path) -> None:
    bundled_root = tmp_path / "bundled"
    bundled_skill = bundled_root / "humanizer"
    bundled_skill.mkdir(parents=True)
    (bundled_skill / "SKILL.md").write_text(
        (
            "---\n"
            "name: Humanizer\n"
            "description: Make text sound natural.\n"
            "whenToUse: When the user asks to humanize text.\n"
            "---\n"
            "Keep facts intact while improving tone.\n"
        ),
        encoding="utf-8",
    )

    message = ContextBuilder(
        tmp_path / "workspace",
        skill_scopes=(SkillScope(scope="bundled", root=bundled_root, enabled=True),),
        skills_system_enabled=True,
    ).build_skills_system_message()

    assert message.startswith("## Runtime Skills Overlay")
    assert "Humanizer" in message
    assert "cache-stable base prompt is not rewritten" in message


def test_skill_index_instruction_advertises_load_skill_when_available(tmp_path) -> None:
    bundled_root = tmp_path / "bundled"
    skill_dir = bundled_root / "ops"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: Ops Skill\ndescription: Operational guidance.\n---\nBody\n",
        encoding="utf-8",
    )

    prompt = ContextBuilder(
        tmp_path / "workspace",
        skill_scopes=(SkillScope(scope="bundled", root=bundled_root, enabled=True),),
        skills_system_enabled=True,
    ).build_system_prompt(
        "Base system prompt.",
        tool_statuses=[
            RuntimeToolStatus(
                name="load_skill",
                display_name="Load Skill",
                available=True,
                description="Load a skill's full SKILL.md.",
            ),
        ],
    )

    assert "Ops Skill" in prompt
    assert (
        "Use a skill by calling the `load_skill` tool with the name and scope "
        "shown below before following its instructions." in prompt
    )


def test_skill_index_instruction_states_load_skill_unavailable_without_impossible_directive(
    tmp_path,
) -> None:
    # Regression: the fallback branch (load_skill not bound/enabled) must not
    # tell the model to take an action no tool lets it perform (loading its
    # own SKILL.md file directly).
    bundled_root = tmp_path / "bundled"
    skill_dir = bundled_root / "ops"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: Ops Skill\ndescription: Operational guidance.\n---\nBody\n",
        encoding="utf-8",
    )

    prompt = ContextBuilder(
        tmp_path / "workspace",
        skill_scopes=(SkillScope(scope="bundled", root=bundled_root, enabled=True),),
        skills_system_enabled=True,
    ).build_system_prompt(
        "Base system prompt.",
        tool_statuses=[
            RuntimeToolStatus(
                name="read_file",
                display_name="Read File",
                available=True,
                description="Read a file.",
            ),
        ],
    )

    assert "Ops Skill" in prompt
    assert (
        "Full skill details are unavailable in this environment because the "
        "`load_skill` tool is not enabled." in prompt
    )
    assert "loading its SKILL.md details before execution" not in prompt


def test_nested_skill_addition_is_visible_within_cache_ttl(monkeypatch, tmp_path) -> None:
    scope_root = tmp_path / "project"
    nested = scope_root / "existing" / "nested"
    nested.mkdir(parents=True)
    now = [100.0]
    monkeypatch.setattr(builder_skills.time, "monotonic", lambda: now[0])
    builder = ContextBuilder(
        tmp_path / "workspace",
        skill_scopes=(SkillScope(scope="project", root=scope_root),),
        skills_system_enabled=True,
    )

    assert "Late Skill" not in builder.build_system_prompt("Base")
    (nested / "SKILL.md").write_text(
        "---\nname: Late Skill\n---\nNew nested guidance.\n",
        encoding="utf-8",
    )
    assert "Late Skill" not in builder.build_system_prompt("Base")

    now[0] += 1.01
    prompt = builder.build_system_prompt("Base")
    assert "Late Skill" in prompt
    assert 'load_skill(name="existing/nested", scope="project")' in prompt


def test_legacy_workspace_skill_is_rendered_inline_without_unloadable_scope(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    skill_dir = workspace / "skills" / "ops"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: Workspace Ops\ndescription: Workspace guidance.\n---\nInline body.\n",
        encoding="utf-8",
    )

    prompt = ContextBuilder(workspace, skills_system_enabled=False).build_system_prompt("Base")

    assert "## Skill: Workspace Ops\nInline body." in prompt
    assert 'scope="workspace"' not in prompt


def test_skill_loader_rejects_link_escape(tmp_path) -> None:
    scope_root = tmp_path / "project"
    linked_dir = scope_root / "linked"
    outside = tmp_path / "outside.md"
    linked_dir.mkdir(parents=True)
    outside.write_text("---\nname: Escaped Secret\n---\nSECRET\n", encoding="utf-8")
    try:
        (linked_dir / "SKILL.md").symlink_to(outside)
    except OSError as error:
        # Unprivileged Windows cannot create symlinks. Keep this skip narrow: it
        # used to also gate the oversized-file assertion now in the test below,
        # which left the size guard with NO coverage on the platform we ship on.
        pytest.skip(f"symlink creation unavailable: {error}")

    prompt = ContextBuilder(
        tmp_path / "workspace",
        skill_scopes=(SkillScope(scope="project", root=scope_root),),
        skills_system_enabled=True,
    ).build_system_prompt("Base")

    assert "Escaped Secret" not in prompt
    assert "SECRET" not in prompt


def test_skill_loader_rejects_oversized_preface(tmp_path) -> None:
    scope_root = tmp_path / "project"
    huge_dir = scope_root / "huge"
    huge_dir.mkdir(parents=True)
    # Valid frontmatter, oversized body: without it the loader rejects this skill
    # for having no frontmatter at all, and the size cap is never what fails.
    header = "---\nname: Huge Skill\ndescription: Oversized.\n---\n"
    padding = "x" * (MAX_SKILL_FILE_BYTES + 1 - len(header.encode("utf-8")))
    (huge_dir / "SKILL.md").write_text(header + padding, encoding="utf-8")

    prompt = ContextBuilder(
        tmp_path / "workspace",
        skill_scopes=(SkillScope(scope="project", root=scope_root),),
        skills_system_enabled=True,
    ).build_system_prompt("Base")

    # Scoped skills render as a CATALOG (name + load hint); the body is fetched
    # later via load_skill and is never inlined here. So asserting on the padding
    # would pass no matter what the size guard did -- the only observable effect
    # of the rejection is that the skill is missing from the catalog entirely.
    assert "Huge Skill" not in prompt
    assert 'load_skill(name="huge"' not in prompt


def test_skill_frontmatter_rejects_yaml_alias_expansion(tmp_path) -> None:
    scope_root = tmp_path / "project"
    skill_dir = scope_root / "alias"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: Alias Skill\nseed: &seed [a, b]\ncopy: *seed\n---\nBody\n",
        encoding="utf-8",
    )

    prompt = ContextBuilder(
        tmp_path / "workspace",
        skill_scopes=(SkillScope(scope="project", root=scope_root),),
        skills_system_enabled=True,
    ).build_system_prompt("Base")

    assert "Alias Skill" not in prompt


def test_skill_discovery_and_rendering_obey_exact_aggregate_caps(tmp_path) -> None:
    scope_root = tmp_path / "project"
    for index in range(MAX_SKILL_FILES + 12):
        skill_dir = scope_root / f"skill_{index:03d}"
        skill_dir.mkdir(parents=True)
        body = "z" * 800 if index < 100 else "short"
        (skill_dir / "SKILL.md").write_text(
            (
                "---\n"
                f"name: Skill {index}\n"
                "metadata:\n  nanobot:\n    always: true\n"
                "---\n"
                f"{body}\n"
            ),
            encoding="utf-8",
        )
    builder = ContextBuilder(
        tmp_path / "workspace",
        skill_scopes=(SkillScope(scope="project", root=scope_root),),
        skills_system_enabled=True,
    )

    entries = builder._load_skills()
    rendered = builder._render_skills()

    assert len(entries) == MAX_SKILL_FILES
    assert len(rendered.encode("utf-8")) == MAX_SKILL_PROMPT_BYTES
    assert "prompt budget reached" in rendered


def test_skill_discovery_honors_depth_and_monotonic_deadline(monkeypatch, tmp_path) -> None:
    scope_root = tmp_path / "project"
    deep = scope_root
    for index in range(10):
        deep = deep / f"d{index}"
    deep.mkdir(parents=True)
    (deep / "SKILL.md").write_text("---\nname: Too Deep\n---\nBody\n", encoding="utf-8")
    depth_discovery = context_io.discover_skill_files(
        scope_root,
        max_depth=8,
        max_entries=2_048,
        max_files=128,
        max_seconds=0.5,
    )
    assert depth_discovery.files == ()
    assert "depth_budget" in depth_discovery.truncation_reasons

    ticks = iter((0.0, 0.0, 1.0))
    monkeypatch.setattr(context_io.time, "monotonic", lambda: next(ticks, 1.0))

    discovery = context_io.discover_skill_files(
        scope_root,
        max_depth=8,
        max_entries=2_048,
        max_files=128,
        max_seconds=0.5,
    )

    assert discovery.files == ()
    assert "time_budget" in discovery.truncation_reasons


def test_workspace_prompt_files_refuse_symlink_escape(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    bootstrap = workspace / "BOOTSTRAP"
    bootstrap.mkdir(parents=True)
    outside = tmp_path / "outside.md"
    outside.write_text("TOP SECRET BOOTSTRAP", encoding="utf-8")
    try:
        (bootstrap / "IDENTITY.md").symlink_to(outside)
        (workspace / "agentj.md").symlink_to(outside)
    except OSError as error:
        pytest.skip(f"symlink creation unavailable: {error}")

    prompt = ContextBuilder(workspace).build_system_prompt("Base")

    assert "TOP SECRET BOOTSTRAP" not in prompt
    assert "Workspace Instructions" not in prompt


def test_bootstrap_files_obey_per_file_and_aggregate_byte_budgets(caplog, tmp_path) -> None:
    workspace = tmp_path / "workspace"
    bootstrap = workspace / "BOOTSTRAP"
    bootstrap.mkdir(parents=True)
    for filename in ("IDENTITY.md", "SOUL.md", "USER.md"):
        (bootstrap / filename).write_text(
            filename + "\n" + ("q" * (MAX_BOOTSTRAP_FILE_BYTES + 4_096)),
            encoding="utf-8",
        )
    with caplog.at_level(logging.WARNING):
        blocks = ContextBuilder(workspace)._load_bootstrap_blocks()

    rendered = "\n\n".join(blocks)
    assert len(rendered.encode("utf-8")) <= MAX_BOOTSTRAP_PROMPT_BYTES
    assert "bootstrap context truncated" in rendered
    assert any(
        getattr(record, "event", "") == "ai.context.workspace_context_partial"
        for record in caplog.records
    )


def test_workspace_context_sources_share_one_exact_aggregate_budget(tmp_path) -> None:
    bounded = context_io.bound_workspace_context_sources(
        ["b" * MAX_BOOTSTRAP_PROMPT_BYTES],
        "s" * MAX_SKILL_PROMPT_BYTES,
        "i" * 8_192,
        max_bytes=MAX_WORKSPACE_CONTEXT_PROMPT_BYTES,
    )
    combined = [
        *bounded.bootstrap_blocks,
        bounded.skills_block,
        bounded.instruction_block,
    ]

    assert sum(len(block.encode("utf-8")) for block in combined) == (
        MAX_WORKSPACE_CONTEXT_PROMPT_BYTES
    )
    assert "aggregate budget reached" in "\n".join(combined)


def test_context_builder_adds_current_info_guidance_and_no_tools_variant(tmp_path) -> None:
    prompt = ContextBuilder(tmp_path / "workspace").build_system_prompt(
        "Base system prompt.",
        tool_statuses=[
            RuntimeToolStatus(
                name="web_search",
                display_name="Web Search",
                available=False,
                reason="config disabled",
            ),
        ],
        latest_user_content="What is the weather in Nashville today?",
    )

    assert "No executable tools are available for this request." in prompt
    assert "This request likely needs up-to-date external information." in prompt
    assert "web_search` is unavailable for this request: config disabled" in prompt


def test_current_info_detection_ignores_repo_local_current_requests() -> None:
    assert looks_like_current_info_request("What is the weather in Nashville today?") is True
    assert looks_like_current_info_request("What is the current branch?") is False
    assert looks_like_current_info_request("Show me the latest migration file.") is False


def test_tool_calling_hint_for_ollama_includes_direct_call_and_required_args_guidance() -> None:
    hint = ContextBuilder._render_tool_calling_format_hint(
        "ollama",
        [
            RuntimeToolStatus(
                name="read_file",
                display_name="Read File",
                available=True,
                description="Read a file.",
                input_schema={
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
            ),
        ],
    )

    assert "How to Call Tools" in hint
    assert "You must call tools directly with a <tool_call> block" in hint
    assert "Do not describe tool usage in prose." in hint
    assert "Do not emit wrapper text such as `function_response`" in hint
    assert "Do not emit `{}` when required fields exist." in hint
    assert "include those required keys in `arguments`" in hint
    assert '"name": "read_file", "arguments": {"path": "<string>"}' in hint
    assert "required_key" not in hint


def test_executable_tools_include_minimal_argument_examples(tmp_path) -> None:
    prompt = ContextBuilder(tmp_path / "workspace").build_system_prompt(
        "Base system prompt.",
        tool_statuses=[
            RuntimeToolStatus(
                name="read_file",
                display_name="Read File",
                available=True,
                description="Read a file from the workspace.",
                input_schema={
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
            )
        ],
    )

    assert '`read_file`: Read a file from the workspace. Example arguments: {"path": "<string>"}' in prompt
    assert "required_key" not in prompt


def test_tool_calling_hint_not_emitted_for_non_ollama_engines() -> None:
    hint = ContextBuilder._render_tool_calling_format_hint(
        "openai",
        [
            RuntimeToolStatus(
                name="read_file",
                display_name="Read File",
                available=True,
                description="Read a file.",
            ),
        ],
    )

    assert hint == ""


def test_context_builder_places_workspace_instructions_after_skills(tmp_path) -> None:
    bundled_root = tmp_path / "bundled"
    bundled_skill = bundled_root / "ops"
    workspace = tmp_path / "workspace"
    bundled_skill.mkdir(parents=True)
    workspace.mkdir(parents=True)
    (bundled_skill / "SKILL.md").write_text(
        ("---\nname: Shared Skill\ndescription: Shared guidance.\n---\nBody\n"),
        encoding="utf-8",
    )
    (workspace / "agentj.md").write_text(
        "Use the workspace-specific engineering norms.",
        encoding="utf-8",
    )

    prompt = ContextBuilder(
        workspace,
        skill_scopes=(SkillScope(scope="bundled", root=bundled_root, enabled=True),),
        skills_system_enabled=True,
    ).build_system_prompt("Base system prompt.")

    skills_index = prompt.index("## Available Skills")
    workspace_index = prompt.index("## Workspace Instructions (agentj.md)")
    assert skills_index < workspace_index
