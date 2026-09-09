"""Focused tests for ``sidecar.runtime.chat_resume_prefix`` helpers."""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace

import pytest

from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.context.runtime_message_markers import PLAN_MODE_OVERLAY_HEADING
from sidecar.runtime.chat import _validate_approval_plan_live_context
from sidecar.runtime.chat_resume_prefix import plan_personality_block_present
from sidecar.runtime.turn_retry import InnerRetryableTurnError
from tests.sidecar.runtime.test_chat import (
    _approval_validation_brain_container,
    _ApprovalResumeRouter,
    _build_approval_plan_for_chat_tests,
)


def test_plan_personality_block_present_reads_recorded_field() -> None:
    assert plan_personality_block_present(SimpleNamespace(personality_rendered=True)) is True
    assert plan_personality_block_present(SimpleNamespace(personality_rendered=False)) is False


def test_plan_personality_block_present_missing_plan_is_false() -> None:
    """chat_resume passes ``plan=None`` on resumes without a cached plan
    (it null-checks the plan only AFTER this call), so a missing plan must
    read as "no personality block" rather than raising."""
    assert plan_personality_block_present(None) is False


@pytest.mark.parametrize("typed_context", ["## Active File\nnotes.md", "## Personality\nOwner note"])
@pytest.mark.parametrize("changed_request", [False, True])
def test_budget_relocated_plan_overlay_does_not_self_drift(typed_context, changed_request):
    plan = _build_approval_plan_for_chat_tests()
    # Budget assembly reinserts runtime overlays after the entire system run,
    # including Electron's typed context. Reproduce that production operation.
    prefix = [*plan.working_messages[:-1], {"role": "system", "content": typed_context}]
    messages = ContextBuilder.insert_runtime_system_messages(
        SimpleNamespace(is_runtime_system_message=ContextBuilder.is_runtime_system_message),
        [*prefix, plan.working_messages[-1]],
        [f"{PLAN_MODE_OVERLAY_HEADING}\nInspect only"],
    )
    plan = replace(
        plan, working_messages=tuple(messages),
        request_context=replace(plan.request_context, plan_mode=True, read_only=True),
        personality_rendered=typed_context.startswith("## Personality"),
    )
    if plan.personality_rendered:
        # A typed personality replaces (not supplements) the bare overlay.
        plan = replace(plan, working_messages=tuple(
            row for i, row in enumerate(plan.working_messages) if i != 1
        ))
    router = _ApprovalResumeRouter(frozen_inputs=plan.frozen_inputs)
    params = {"messages": [{"role": "user", "content": "changed" if changed_request else "write notes.md"}]}
    if changed_request:
        with pytest.raises(InnerRetryableTurnError) as caught:
            _validate_approval_plan_live_context(
                plan, brain_container=_approval_validation_brain_container(router),
                live_params=params, canonical_session_messages=[],
            )
        assert caught.value.diagnostic_components == ("request_messages",)
    else:
        _validate_approval_plan_live_context(
            plan, brain_container=_approval_validation_brain_container(router),
            live_params=params, canonical_session_messages=[],
        )
