from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.tools.policy import (
    MAX_APPROVAL_POLICY_TEXT_CHARS,
    NEUTRAL_APPROVAL_POLICY_TEXT,
    approval_presentation_for_descriptor,
)


def test_approval_presentation_uses_only_stable_descriptor_metadata() -> None:
    descriptor = SimpleNamespace(
        name="write_file",
        tool_family="filesystem",
        side_effecting=True,
        input_schema={"properties": {"path": {"default": "C:/private/file.txt"}}},
    )

    presentation = approval_presentation_for_descriptor(descriptor)

    assert presentation.policy_scope == "Workspace files"
    assert presentation.policy_consequence == "May change data in this scope."
    assert "private" not in presentation.policy_scope
    assert "private" not in presentation.policy_consequence


def test_approval_presentation_uses_neutral_copy_for_unknown_effect_metadata() -> None:
    presentation = approval_presentation_for_descriptor(
        SimpleNamespace(name="future_tool", tool_family="future")
    )

    assert presentation.policy_scope == "Requested tool"
    assert presentation.policy_consequence == NEUTRAL_APPROVAL_POLICY_TEXT
    assert len(presentation.policy_scope) <= MAX_APPROVAL_POLICY_TEXT_CHARS
    assert len(presentation.policy_consequence) <= MAX_APPROVAL_POLICY_TEXT_CHARS


def test_run_command_has_specific_non_assuring_copy() -> None:
    presentation = approval_presentation_for_descriptor(
        SimpleNamespace(name="run_command", tool_family="shell", side_effecting=True)
    )

    assert presentation.policy_scope == "Local command execution"
    assert presentation.policy_consequence == "May run a local command and change local state."
