from __future__ import annotations

from types import SimpleNamespace

import pytest

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.context.builder import ContextBuilder, SkillScope
from sidecar.ai.context.runtime_overlays import build_dynamic_system_messages


def _builder_with_skills(tmp_path, *, disabled_skill_ids: tuple[str, ...] = ()) -> ContextBuilder:
    bundled_root = tmp_path / "bundled"
    for slug, always in (("hidden-index", False), ("hidden-inline", True), ("visible", False)):
        skill_dir = bundled_root / slug
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            f"---\nname: {slug}\nmetadata:\n  jenny:\n    always: {str(always).lower()}\n---\n{slug} body\n",
            encoding="utf-8",
        )
    return ContextBuilder(
        tmp_path / "workspace",
        skill_scopes=(SkillScope(scope="bundled", root=bundled_root, enabled=True),),
        disabled_skill_ids=disabled_skill_ids,
        skills_system_enabled=True,
    )


def _skills_messages(builder: ContextBuilder, *, engine_type: str, policy: str) -> list[str]:
    messages = build_dynamic_system_messages(
        context_builder=builder,
        config=SimpleNamespace(
            engine_type=engine_type,
            skills_auto_index=policy,
            assistant_name="Jenny",
        ),
    )
    return [
        str(message["content"])
        for message in messages
        if "Runtime Skills Overlay" in str(message["content"])
    ]


def test_disabled_skill_ids_are_excluded_from_inline_and_index(tmp_path) -> None:
    builder = _builder_with_skills(
        tmp_path,
        disabled_skill_ids=("bundled/hidden-index", "bundled/hidden-inline"),
    )

    message = builder.build_skills_system_message()

    assert "visible" in message
    assert "hidden-index" not in message
    assert "hidden-inline" not in message


@pytest.mark.parametrize("engine_type", ["ollama", "vllm", "openai-compatible"])
def test_auto_index_is_suppressed_for_local_engines(tmp_path, engine_type: str) -> None:
    assert _skills_messages(
        _builder_with_skills(tmp_path), engine_type=engine_type, policy="auto"
    ) == []


def test_auto_index_renders_for_remote_engine(tmp_path) -> None:
    assert _skills_messages(
        _builder_with_skills(tmp_path), engine_type="codex-cli", policy="auto"
    )


def test_explicit_on_renders_for_ollama(tmp_path) -> None:
    assert _skills_messages(
        _builder_with_skills(tmp_path), engine_type="ollama", policy="on"
    )


def test_explicit_off_suppresses_codex_cli(tmp_path) -> None:
    assert _skills_messages(
        _builder_with_skills(tmp_path), engine_type="codex-cli", policy="off"
    ) == []


def test_runtime_config_parses_skill_policy_defaults_and_values() -> None:
    assert parse_runtime_config({}).skills_disabled_ids == ()
    assert parse_runtime_config({}).skills_auto_index == "auto"
    config = parse_runtime_config(
        {
            "skills_disabled_ids": ["bundled/one", "bundled/one", "project/team/two"],
            "skills_auto_index": "off",
        }
    )
    assert config.skills_disabled_ids == ("bundled/one", "project/team/two")
    assert config.skills_auto_index == "off"
