from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.context.builder import ContextBuilder, SkillScope
from sidecar.ai.context.runtime_overlays import build_dynamic_system_messages


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


@pytest.mark.parametrize("disabled", [False, True])
def test_bundled_po_review_invocation_respects_enablement_with_index_off(tmp_path, disabled) -> None:
    bundled_root = Path(__file__).resolve().parents[4] / "skills"
    builder = ContextBuilder(
        tmp_path,
        skill_scopes=(SkillScope(scope="bundled", root=bundled_root, enabled=True),),
        disabled_skill_ids=("bundled/po-review",) if disabled else (),
        skills_system_enabled=True,
    )
    messages = build_dynamic_system_messages(
        context_builder=builder,
        config=SimpleNamespace(engine_type="ollama", skills_auto_index="off"),
        skill_invocation={"id": "bundled/po-review"},
    )
    invoked = [str(row["content"]) for row in messages if "## Invoked Skill:" in str(row["content"])]
    assert not any("Runtime Skills Overlay" in str(row["content"]) for row in messages)
    if disabled:
        assert invoked == []
    else:
        assert len(invoked) == 1
        assert "Product Owner Review" in invoked[0]
        assert "Keep product code read-only" in invoked[0]
        assert "A later request to implement is separate authorization." in invoked[0]
