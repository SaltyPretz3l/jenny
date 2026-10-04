"""CMC-002: skills follow the request's captured authority, not the startup config.

One sidecar process serves chats from several projects. ``ContextBuilder`` is
built once from the startup config, so project A's skills used to render into
project B's (or an unbound chat's) prompt while the tool configuration, which is
request-scoped, said otherwise. A ``SkillAuthority`` resolved from the request's
``ExecutionContext`` now owns discovery, the index, the invoked body, the
disabled ids and the legacy ``<root>/skills`` fallback, and keys the cache.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config_models import ToolPolicySnapshot
from sidecar.ai.context.builder import ContextBuilder, SkillScope
from sidecar.ai.context.builder_skills import (
    SkillAuthority,
    request_skill_authority,
    request_skill_config_fields,
    resolve_skill_scopes,
)
from sidecar.ai.context.runtime_overlays import build_dynamic_system_messages
from sidecar.ai.routing.system_messages import build_request_system_messages
from sidecar.ai.routing.tool_resolution import _request_scoped_config
from sidecar.runtime.chat_models import ChatRequestContext
from sidecar.runtime.execution_context import ExecutionContext, SkillsExecutionConfig


def _write_skill(root: Path, slug: str, *, body: str | None = None) -> None:
    skill_dir = root / slug
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {slug}\ndescription: {slug} description\n---\n{body or slug + ' body'}\n",
        encoding="utf-8",
    )


def _project(tmp_path: Path, name: str) -> tuple[Path, Path]:
    root = tmp_path / name
    skills = root / ".jenny" / "skills"
    _write_skill(skills, f"skill-{name}")
    return root, skills


def _skills_config(
    *,
    project_root: Path | None,
    bundled_root: Path | None = None,
    user_root: Path | None = None,
    disabled_ids: tuple[str, ...] = (),
    auto_index: str = "on",
) -> SkillsExecutionConfig:
    return SkillsExecutionConfig(
        bundled_root=str(bundled_root) if bundled_root else None,
        user_root=str(user_root) if user_root else None,
        project_root=str(project_root) if project_root else None,
        bundled_enabled=bundled_root is not None,
        user_enabled=user_root is not None,
        project_enabled=project_root is not None,
        disabled_ids=disabled_ids,
        auto_index=auto_index,
    )


def _execution(
    root: Path | None, skills: SkillsExecutionConfig | None = None
) -> ExecutionContext:
    return ExecutionContext(
        schema_version=1,
        authority_revision="revision",
        project_id="project_audit",
        root_path=str(root) if root else None,
        root_id="root" if root else None,
        root_revision=1 if root else 0,
        device_id=None,
        inode=None,
        tool_policy_snapshot=ToolPolicySnapshot(),
        knowledge_roots=(),
        skills_config=skills,
    )


def _request(execution: ExecutionContext | None) -> ChatRequestContext:
    return ChatRequestContext(
        request_id="request",
        trace_id=None,
        session_id=None,
        mode="chat",
        approvals_pre_granted=False,
        execution_context=execution,
    )


def _startup_config(**overrides: Any) -> SimpleNamespace:
    values: dict[str, Any] = {
        "skills_bundled_root": None,
        "skills_user_root": None,
        "skills_project_root": None,
        "skills_bundled_enabled": True,
        "skills_user_enabled": True,
        "skills_project_enabled": True,
        "skills_disabled_ids": (),
        "skills_auto_index": "auto",
        "tools_workspace_root": None,
        "agent_workspace_root": None,
        "tool_policy_snapshot": None,
        "tools_knowledge_enabled": False,
        "knowledge_roots": (),
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _authority(
    root: Path | None, skills: SkillsExecutionConfig | None, config: Any = None
) -> SkillAuthority:
    authority = request_skill_authority(config or _startup_config(), _execution(root, skills))
    assert authority is not None
    return authority


def _builder(project_a_root: Path, project_a_skills: Path) -> ContextBuilder:
    return ContextBuilder(
        project_a_root,
        skill_scopes=(SkillScope(scope="project", root=project_a_skills, enabled=True),),
        skills_system_enabled=True,
    )


def test_request_authority_replaces_startup_project_scope(tmp_path: Path) -> None:
    root_a, skills_a = _project(tmp_path, "a")
    root_b, skills_b = _project(tmp_path, "b")
    builder = _builder(root_a, skills_a)

    startup = builder.build_skills_system_message()
    in_b = builder.build_skills_system_message(
        skill_authority=_authority(root_b, _skills_config(project_root=skills_b))
    )
    unbound = builder.build_skills_system_message(
        skill_authority=_authority(None, _skills_config(project_root=None))
    )

    assert "skill-a" in startup
    assert "skill-b" in in_b
    assert "skill-a" not in in_b
    assert "skill-a" not in unbound
    assert "skill-b" not in unbound


def test_bundled_and_user_scopes_render_under_request_authority(tmp_path: Path) -> None:
    root_a, skills_a = _project(tmp_path, "a")
    root_b, skills_b = _project(tmp_path, "b")
    bundled = tmp_path / "bundled"
    user = tmp_path / "user"
    _write_skill(bundled, "bundled-skill")
    _write_skill(user, "user-skill")
    builder = _builder(root_a, skills_a)

    authority = _authority(
        root_b,
        _skills_config(project_root=skills_b, bundled_root=bundled, user_root=user),
    )
    message = builder.build_skills_system_message(skill_authority=authority)

    assert "bundled-skill" in message
    assert "user-skill" in message
    assert "skill-b" in message
    assert "skill-a" not in message


def test_alternating_authorities_never_leak_through_the_cache(tmp_path: Path) -> None:
    root_a, skills_a = _project(tmp_path, "a")
    root_b, skills_b = _project(tmp_path, "b")
    builder = _builder(root_a, skills_a)
    authority_a = _authority(root_a, _skills_config(project_root=skills_a))
    authority_b = _authority(root_b, _skills_config(project_root=skills_b))
    authority_unbound = _authority(None, _skills_config(project_root=None))

    for _ in range(2):
        message_a = builder.build_skills_system_message(skill_authority=authority_a)
        message_b = builder.build_skills_system_message(skill_authority=authority_b)
        message_unbound = builder.build_skills_system_message(skill_authority=authority_unbound)
        message_startup = builder.build_skills_system_message()
        assert "skill-a" in message_a and "skill-b" not in message_a
        assert "skill-b" in message_b and "skill-a" not in message_b
        assert message_unbound == ""
        assert "skill-a" in message_startup and "skill-b" not in message_startup


def test_cache_still_notices_a_changed_skill_file_per_authority(tmp_path: Path) -> None:
    root_a, skills_a = _project(tmp_path, "a")
    builder = _builder(root_a, skills_a)
    authority = _authority(root_a, _skills_config(project_root=skills_a))
    assert "skill-a" in builder.build_skills_system_message(skill_authority=authority)

    _write_skill(skills_a, "skill-late")

    assert "skill-late" in builder.build_skills_system_message(skill_authority=authority)


def test_authority_cache_is_bounded_and_correct_past_the_bound(tmp_path: Path) -> None:
    root_a, skills_a = _project(tmp_path, "a")
    builder = _builder(root_a, skills_a)
    authorities = []
    for index in range(12):
        root, skills = _project(tmp_path, f"p{index}")
        authorities.append((index, _authority(root, _skills_config(project_root=skills))))

    for _ in range(2):
        for index, authority in authorities:
            message = builder.build_skills_system_message(skill_authority=authority)
            assert f"skill-p{index}" in message
            assert "skill-a" not in message

    assert len(builder._skill_cache) <= 8  # type: ignore[attr-defined]


def test_invoked_skill_resolves_only_inside_the_request_authority(tmp_path: Path) -> None:
    root_a, skills_a = _project(tmp_path, "a")
    root_b, skills_b = _project(tmp_path, "b")
    builder = _builder(root_a, skills_a)
    authority_a = _authority(root_a, _skills_config(project_root=skills_a))
    authority_b = _authority(root_b, _skills_config(project_root=skills_b))

    invocation_a = {"id": "project/skill-a"}
    assert "skill-a body" in builder.build_invoked_skill_system_message(invocation_a)
    assert "skill-a body" in builder.build_invoked_skill_system_message(
        invocation_a, skill_authority=authority_a
    )
    assert builder.build_invoked_skill_system_message(invocation_a, skill_authority=authority_b) == ""
    assert "skill-b body" in builder.build_invoked_skill_system_message(
        {"id": "project/skill-b"}, skill_authority=authority_b
    )


def test_disabled_ids_come_from_the_authority(tmp_path: Path) -> None:
    root_a, skills_a = _project(tmp_path, "a")
    _write_skill(skills_a, "other")
    builder = _builder(root_a, skills_a)
    authority = _authority(
        root_a,
        _skills_config(project_root=skills_a, disabled_ids=("project/other",)),
    )

    startup = builder.build_skills_system_message()
    scoped = builder.build_skills_system_message(skill_authority=authority)

    assert "other" in startup
    assert "skill-a" in scoped
    assert "other" not in scoped


def test_legacy_workspace_skills_follow_the_authority_root(tmp_path: Path) -> None:
    root_a = tmp_path / "a"
    root_b = tmp_path / "b"
    _write_skill(root_a / "skills", "legacy-a")
    _write_skill(root_b / "skills", "legacy-b")
    builder = ContextBuilder(root_a)  # skills system off: legacy <root>/skills fallback

    authority_b = _authority(root_b, None)
    authority_unbound = _authority(None, None)

    assert "legacy-a body" in builder.build_skills_system_message()
    in_b = builder.build_skills_system_message(skill_authority=authority_b)
    assert "legacy-b body" in in_b
    assert "legacy-a body" not in in_b
    assert builder.build_skills_system_message(skill_authority=authority_unbound) == ""


def test_hosted_policy_keeps_the_request_root_out_of_the_legacy_fallback(tmp_path: Path) -> None:
    """Hosted tools may use the request root; it never becomes prompt context."""
    root = tmp_path / "hosted"
    _write_skill(root / "skills", "legacy-hosted")
    hosted = _startup_config(host_mode="server", host_execution_policy_version=2)

    authority = _authority(root, None, config=hosted)

    assert authority.legacy_root is None
    assert ContextBuilder(None).build_skills_system_message(skill_authority=authority) == ""


def test_no_authority_keeps_startup_behaviour(tmp_path: Path) -> None:
    root_a, skills_a = _project(tmp_path, "a")
    builder = _builder(root_a, skills_a)

    assert builder.build_skills_system_message(skill_authority=None) == (
        builder.build_skills_system_message()
    )
    assert "skill-a" in builder.build_skills_system_message()
    assert request_skill_authority(_startup_config(), None) is None
    assert "skill-a" in str(
        builder.build_system_prompt("Base.", skill_authority=None, request_workspace_root=None)
    )


def test_build_system_prompt_renders_the_request_authority_skills(tmp_path: Path) -> None:
    root_a, skills_a = _project(tmp_path, "a")
    root_b, skills_b = _project(tmp_path, "b")
    builder = _builder(root_a, skills_a)

    prompt = str(
        builder.build_system_prompt(
            "Base.",
            request_workspace_root=str(root_b),
            skill_authority=_authority(root_b, _skills_config(project_root=skills_b)),
        )
    )

    assert "skill-b" in prompt
    assert "skill-a" not in prompt


def test_dynamic_system_messages_use_the_execution_context_authority(tmp_path: Path) -> None:
    root_a, skills_a = _project(tmp_path, "a")
    root_b, skills_b = _project(tmp_path, "b")
    builder = _builder(root_a, skills_a)
    config = _startup_config(assistant_name="Jenny", engine_type="codex-cli")

    def skill_text(execution: ExecutionContext | None) -> str:
        messages = build_dynamic_system_messages(
            context_builder=builder,
            config=config,
            personality_rendered=True,
            execution_context=execution,
        )
        return "\n".join(str(message["content"]) for message in messages)

    in_b = skill_text(_execution(root_b, _skills_config(project_root=skills_b)))
    unbound = skill_text(_execution(None, _skills_config(project_root=None)))
    off = skill_text(_execution(root_b, _skills_config(project_root=skills_b, auto_index="off")))

    assert "skill-b" in in_b and "skill-a" not in in_b
    assert "skill-a" not in unbound and "skill-b" not in unbound
    # The request's auto-index policy wins over the startup "auto".
    assert "skill-b" not in off
    # No execution context: startup scopes and the startup policy, as before.
    assert "skill-a" in skill_text(None)


@pytest.mark.parametrize(
    "skills_present",
    [True, False],
    ids=["skills-config", "no-skills-config"],
)
@pytest.mark.parametrize("bound", [True, False], ids=["bound", "unbound"])
def test_authority_matches_the_tool_configuration(
    tmp_path: Path, skills_present: bool, bound: bool
) -> None:
    root, skills = _project(tmp_path, "a")
    bundled = tmp_path / "bundled"
    user = tmp_path / "user"
    config = _startup_config(
        skills_bundled_root=str(tmp_path / "startup-bundled"),
        skills_user_root=str(tmp_path / "startup-user"),
        skills_project_root=str(tmp_path / "startup-project"),
        skills_disabled_ids=("bundled/startup-off",),
        skills_auto_index="off",
    )
    skills_config = (
        _skills_config(
            project_root=skills if bound else None,
            bundled_root=bundled,
            user_root=user,
            disabled_ids=("user/off",),
            auto_index="on",
        )
        if skills_present
        else None
    )
    execution = _execution(root if bound else None, skills_config)

    scoped = _request_scoped_config(config, _request(execution))
    authority = request_skill_authority(config, execution)

    assert authority is not None
    assert authority.scopes == resolve_skill_scopes(scoped)
    assert authority.disabled_ids == frozenset(scoped.skills_disabled_ids)
    assert authority.auto_index == scoped.skills_auto_index
    assert authority.legacy_root == (root if bound else None)
    assert set(request_skill_config_fields(execution)) <= set(vars(scoped))


def test_authority_is_hashable_and_value_equal(tmp_path: Path) -> None:
    root, skills = _project(tmp_path, "a")
    first = _authority(root, _skills_config(project_root=skills))
    second = _authority(root, _skills_config(project_root=skills))

    assert first == second
    assert hash(first) == hash(second)
    assert len({first, second}) == 1


def test_request_scoped_config_returns_config_without_execution_context() -> None:
    config = _startup_config()

    assert _request_scoped_config(config, _request(None)) is config


def test_request_system_messages_thread_the_execution_context(tmp_path: Path) -> None:
    root_a, skills_a = _project(tmp_path, "a")
    root_b, skills_b = _project(tmp_path, "b")
    kernel = SimpleNamespace(
        _context_builder=_builder(root_a, skills_a),
        _config=_startup_config(assistant_name="Jenny", engine_type="codex-cli"),
    )

    def rendered(execution: ExecutionContext | None) -> str:
        messages = build_request_system_messages(
            kernel,
            base_system_prompt="Base.",
            tool_statuses=(),
            personality_rendered=True,
            execution_context=execution,
        )
        return "\n".join(str(message["content"]) for message in messages)

    in_b = rendered(_execution(root_b, _skills_config(project_root=skills_b)))

    assert "skill-b" in in_b and "skill-a" not in in_b
    assert "skill-a" in rendered(None)
