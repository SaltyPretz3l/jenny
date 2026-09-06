from __future__ import annotations

from sidecar.ai.context.prompt_modes import (
    PLAN_MODE_GUIDANCE,
    append_plan_mode_runtime_overlay,
    build_plan_mode_overlay,
)
from sidecar.ai.context.runtime_message_markers import (
    PLAN_MODE_OVERLAY_HEADING,
    RUNTIME_SYSTEM_MESSAGE_HEADINGS,
)


def test_runtime_message_markers_register_plan_mode_heading() -> None:
    assert PLAN_MODE_OVERLAY_HEADING in RUNTIME_SYSTEM_MESSAGE_HEADINGS


def test_build_plan_mode_overlay_emits_without_legacy_harness_flag() -> None:
    message = build_plan_mode_overlay(plan_mode_active=True)
    assert message.startswith(PLAN_MODE_OVERLAY_HEADING)
    assert PLAN_MODE_GUIDANCE in message
    assert "read-only tools" in message
    assert "exit_plan_mode" in message


def test_build_plan_mode_overlay_inactive_when_plan_mode_off() -> None:
    assert build_plan_mode_overlay(plan_mode_active=False) == ""


def test_append_plan_mode_runtime_overlay_appends_only_when_active() -> None:
    runtime: list[str] = []
    append_plan_mode_runtime_overlay(runtime, plan_mode_active=True)
    append_plan_mode_runtime_overlay(runtime, plan_mode_active=False)
    assert len(runtime) == 1
    assert runtime[0].startswith(PLAN_MODE_OVERLAY_HEADING)
