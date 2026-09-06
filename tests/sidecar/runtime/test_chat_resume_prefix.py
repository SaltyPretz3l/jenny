"""Focused tests for ``sidecar.runtime.chat_resume_prefix`` helpers."""

from __future__ import annotations

from types import SimpleNamespace

from sidecar.runtime.chat_resume_prefix import plan_personality_block_present


def test_plan_personality_block_present_reads_recorded_field() -> None:
    assert plan_personality_block_present(SimpleNamespace(personality_rendered=True)) is True
    assert plan_personality_block_present(SimpleNamespace(personality_rendered=False)) is False


def test_plan_personality_block_present_missing_plan_is_false() -> None:
    """chat_resume passes ``plan=None`` on resumes without a cached plan
    (it null-checks the plan only AFTER this call), so a missing plan must
    read as "no personality block" rather than raising."""
    assert plan_personality_block_present(None) is False
