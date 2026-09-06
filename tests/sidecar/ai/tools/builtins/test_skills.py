"""Tests for the load_skill builtin tool."""

from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH, CMP_TOOL_SKILL_NOT_FOUND
from sidecar.ai.tools.builtins import skills as skills_module
from sidecar.ai.tools.builtins.skills import (
    MAX_AVAILABLE_SKILL_HINTS,
    MAX_SKILL_FILE_BYTES,
    _reset_skill_tool_state,
    configure_skill_tool,
    load_skill_tool,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


@pytest.fixture(autouse=True)
def _clean_skill_tool_state() -> None:
    """Reset module state between tests -- configure_skill_tool caches roots."""
    _reset_skill_tool_state()
    yield
    _reset_skill_tool_state()


def _guard() -> WorkspaceGuard:
    return WorkspaceGuard(None)  # load_skill doesn't use the tools workspace


def _write_skill(root: Path, scope_dir_name: str, *, body: str = "Do the thing.\n") -> Path:
    skill_dir = root / scope_dir_name
    skill_dir.mkdir(parents=True, exist_ok=True)
    skill_path = skill_dir / "SKILL.md"
    skill_path.write_text(
        f"---\nname: {scope_dir_name} title\ndescription: test skill\n---\n\n{body}",
        encoding="utf-8",
    )
    return skill_path


# ── Happy path ───────────────────────────────────────────────────────


def test_load_bundled_skill_happy_path(tmp_path: Path) -> None:
    bundled_root = tmp_path / "bundled"
    _write_skill(bundled_root, "mermaid-artifact-workflow", body="Follow these steps.\n")
    configure_skill_tool({"skills_bundled_root": str(bundled_root)})

    result = load_skill_tool({"name": "mermaid-artifact-workflow"}, _guard())

    assert result.success is True
    assert "Follow these steps." in result.output
    assert result.metadata["scope"] == "bundled"
    assert result.metadata["name"] == "mermaid-artifact-workflow"
    assert result.metadata["truncated"] is False


def test_load_skill_explicit_scope(tmp_path: Path) -> None:
    bundled_root = tmp_path / "bundled"
    _write_skill(bundled_root, "web_navigator", body="Bundled body.\n")
    configure_skill_tool({"skills_bundled_root": str(bundled_root)})

    result = load_skill_tool({"name": "web_navigator", "scope": "bundled"}, _guard())

    assert "Bundled body." in result.output


# ── Unknown name lists available skills ─────────────────────────────


def test_unknown_name_lists_available_skills(tmp_path: Path) -> None:
    bundled_root = tmp_path / "bundled"
    _write_skill(bundled_root, "brain_dump")
    _write_skill(bundled_root, "humanizer")
    configure_skill_tool({"skills_bundled_root": str(bundled_root)})

    with pytest.raises(ToolExecutionFailure) as excinfo:
        load_skill_tool({"name": "does_not_exist"}, _guard())

    assert excinfo.value.code == CMP_TOOL_SKILL_NOT_FOUND
    assert "bundled/brain_dump" in excinfo.value.message
    assert "bundled/humanizer" in excinfo.value.message


def test_disabled_skill_is_not_loadable_or_listed_in_hint(tmp_path: Path) -> None:
    bundled_root = tmp_path / "bundled"
    _write_skill(bundled_root, "hidden")
    _write_skill(bundled_root, "visible")
    configure_skill_tool(
        {
            "skills_bundled_root": str(bundled_root),
            "skills_disabled_ids": ("bundled/hidden",),
        }
    )

    with pytest.raises(ToolExecutionFailure) as excinfo:
        load_skill_tool({"name": "hidden", "scope": "bundled"}, _guard())

    assert excinfo.value.code == CMP_TOOL_SKILL_NOT_FOUND
    assert "bundled/hidden" not in excinfo.value.message
    assert "bundled/visible" in excinfo.value.message


def test_unknown_name_hint_is_bounded(tmp_path: Path) -> None:
    bundled_root = tmp_path / "bundled"
    for index in range(MAX_AVAILABLE_SKILL_HINTS + 10):
        _write_skill(bundled_root, f"skill_{index:03d}")
    configure_skill_tool({"skills_bundled_root": str(bundled_root)})

    with pytest.raises(ToolExecutionFailure) as excinfo:
        load_skill_tool({"name": "missing"}, _guard())

    assert excinfo.value.message.count("bundled/skill_") == MAX_AVAILABLE_SKILL_HINTS


def test_unknown_name_with_no_configured_scopes(tmp_path: Path) -> None:
    configure_skill_tool({})  # no scope roots configured at all

    with pytest.raises(ToolExecutionFailure) as excinfo:
        load_skill_tool({"name": "anything"}, _guard())

    assert excinfo.value.code == CMP_TOOL_SKILL_NOT_FOUND
    assert "No skills are currently indexed" in excinfo.value.message


# ── Traversal / malformed name rejected ──────────────────────────────


@pytest.mark.parametrize(
    "bad_name",
    [
        "../secrets",
        "..",
        ".",
        "a//b",
        "a\\b",
        "",
        "   ",
        ".hidden",
    ],
)
def test_traversal_and_malformed_names_rejected(tmp_path: Path, bad_name: str) -> None:
    bundled_root = tmp_path / "bundled"
    _write_skill(bundled_root, "safe_skill")
    configure_skill_tool({"skills_bundled_root": str(bundled_root)})

    with pytest.raises(ToolExecutionFailure) as excinfo:
        load_skill_tool({"name": bad_name}, _guard())

    assert excinfo.value.code == CMP_TOOL_INVALID_PATH


def test_nested_skill_id_resolves_exact_advertised_path(tmp_path: Path) -> None:
    project_root = tmp_path / "project"
    _write_skill(project_root, "group/nested", body="Nested body.\n")
    configure_skill_tool({"skills_project_root": str(project_root)})

    result = load_skill_tool(
        {"name": "group/nested", "scope": "project"},
        _guard(),
    )

    assert "Nested body." in result.output
    assert result.metadata["name"] == "group/nested"


def test_traversal_cannot_escape_scope_root_via_symlink(tmp_path: Path) -> None:
    # A symlinked "skill directory" pointing outside the scope root must not
    # be readable even though its name passes the plain-segment regex.
    bundled_root = tmp_path / "bundled"
    bundled_root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "SKILL.md").write_text("---\nname: outside\n---\nsecret\n", encoding="utf-8")
    try:
        (bundled_root / "escape").symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation not permitted in this environment")
    configure_skill_tool({"skills_bundled_root": str(bundled_root)})

    with pytest.raises(ToolExecutionFailure) as excinfo:
        load_skill_tool({"name": "escape"}, _guard())

    assert excinfo.value.code == CMP_TOOL_SKILL_NOT_FOUND


def test_invalid_scope_rejected(tmp_path: Path) -> None:
    bundled_root = tmp_path / "bundled"
    _write_skill(bundled_root, "safe_skill")
    configure_skill_tool({"skills_bundled_root": str(bundled_root)})

    with pytest.raises(ToolExecutionFailure) as excinfo:
        load_skill_tool({"name": "safe_skill", "scope": "not_a_scope"}, _guard())

    assert excinfo.value.code == CMP_TOOL_INVALID_PATH


# ── Scope disambiguation ─────────────────────────────────────────────


def test_scope_disambiguation_precedence_and_explicit_selection(tmp_path: Path) -> None:
    bundled_root = tmp_path / "bundled"
    user_root = tmp_path / "user"
    _write_skill(bundled_root, "shared_name", body="Bundled version.\n")
    _write_skill(user_root, "shared_name", body="User version.\n")
    configure_skill_tool(
        {
            "skills_bundled_root": str(bundled_root),
            "skills_user_root": str(user_root),
        }
    )

    # Omitted scope defaults to bundled -> user -> project precedence.
    default_result = load_skill_tool({"name": "shared_name"}, _guard())
    assert "Bundled version." in default_result.output
    assert default_result.metadata["scope"] == "bundled"

    # Explicit scope selects the other match.
    user_result = load_skill_tool({"name": "shared_name", "scope": "user"}, _guard())
    assert "User version." in user_result.output
    assert user_result.metadata["scope"] == "user"


def test_disabled_scope_is_never_read(tmp_path: Path) -> None:
    bundled_root = tmp_path / "bundled"
    _write_skill(bundled_root, "gated_skill")
    configure_skill_tool(
        {
            "skills_bundled_root": str(bundled_root),
            "skills_bundled_enabled": False,
        }
    )

    with pytest.raises(ToolExecutionFailure) as excinfo:
        load_skill_tool({"name": "gated_skill"}, _guard())

    assert excinfo.value.code == CMP_TOOL_SKILL_NOT_FOUND
    assert "No skills are currently indexed" in excinfo.value.message


# ── Size bound ────────────────────────────────────────────────────────


def test_oversized_skill_is_truncated_not_rejected(tmp_path: Path) -> None:
    bundled_root = tmp_path / "bundled"
    huge_body = "x" * (MAX_SKILL_FILE_BYTES + 4096)
    _write_skill(bundled_root, "huge_skill", body=huge_body)
    configure_skill_tool({"skills_bundled_root": str(bundled_root)})

    result = load_skill_tool({"name": "huge_skill"}, _guard())

    assert result.success is True
    assert result.metadata["truncated"] is True
    assert "[skill content truncated at" in result.output
    assert len(result.output.encode("utf-8")) <= MAX_SKILL_FILE_BYTES + 200


# ── configure_skill_tool reads both dict and attr-style config ───────


def test_configure_skill_tool_accepts_object_style_config(tmp_path: Path) -> None:
    bundled_root = tmp_path / "bundled"
    _write_skill(bundled_root, "attr_skill", body="Attr body.\n")

    class _FakeConfig:
        skills_bundled_root = str(bundled_root)
        skills_bundled_enabled = True
        skills_user_root = None
        skills_user_enabled = True
        skills_project_root = None
        skills_project_enabled = True

    configure_skill_tool(_FakeConfig())

    result = load_skill_tool({"name": "attr_skill"}, _guard())
    assert "Attr body." in result.output


def test_configure_skill_tool_with_none_config_clears_scopes(tmp_path: Path) -> None:
    bundled_root = tmp_path / "bundled"
    _write_skill(bundled_root, "some_skill")
    configure_skill_tool({"skills_bundled_root": str(bundled_root)})
    assert skills_module._scope_roots  # sanity: configured

    configure_skill_tool(None)

    with pytest.raises(ToolExecutionFailure) as excinfo:
        load_skill_tool({"name": "some_skill"}, _guard())
    assert excinfo.value.code == CMP_TOOL_SKILL_NOT_FOUND
