"""Read-only grants used by the live delegate scheduler."""

from sidecar.ai.routing.subagent_scheduler import build_subagent_tool_preferences


def test_build_subagent_tool_preferences_disables_nested_subagent_and_ungranted_families() -> None:
    preferences = build_subagent_tool_preferences(("filesystem", "git"))

    assert "subagent_run" in preferences["disabled_tools"]
    assert "subagent_batch" in preferences["disabled_tools"]
    assert "worktree_create" in preferences["disabled_tools"]
    assert "worktree_select" in preferences["disabled_tools"]
    assert "worktree_delete" in preferences["disabled_tools"]
    assert "filesystem" not in preferences["disabled_tool_families"]
    assert "git" not in preferences["disabled_tool_families"]
    assert "runtime" in preferences["disabled_tool_families"]
    assert "browser" in preferences["disabled_tool_families"]
