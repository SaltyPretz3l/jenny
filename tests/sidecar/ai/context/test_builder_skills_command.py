from __future__ import annotations

from sidecar.ai.context.builder import ContextBuilder, SkillScope


def test_skill_entry_command_uses_explicit_value_and_directory_fallback(tmp_path) -> None:
    bundled_root = tmp_path / "bundled"
    explicit_dir = bundled_root / "explicit_name"
    fallback_dir = bundled_root / "fallback_name"
    explicit_dir.mkdir(parents=True)
    fallback_dir.mkdir(parents=True)
    (explicit_dir / "SKILL.md").write_text(
        "---\nname: Explicit\ncommand: Verify-Now\n---\nBody\n",
        encoding="utf-8",
    )
    (fallback_dir / "SKILL.md").write_text(
        "---\nname: Fallback\n---\nBody\n",
        encoding="utf-8",
    )

    builder = ContextBuilder(
        tmp_path / "workspace",
        skill_scopes=(SkillScope(scope="bundled", root=bundled_root, enabled=True),),
        skills_system_enabled=True,
    )

    entries = {entry.name: entry for entry in builder._load_skills()}  # noqa: SLF001
    assert entries["Explicit"].command == "verify-now"
    assert entries["Fallback"].command == "fallback-name"
