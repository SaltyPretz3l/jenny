"""F26 (1.2.0 gate B1 attempt 4): a turn resumed after an approval ran its tool
loop with ``budget_tracker=None``. The resumed leg then never compacted mid-turn,
and a context-full stop could not recover (F17), so B1's long turn ended in
"context budget is used up" with ``context_tokens: 0`` after its approvals.
"""

from __future__ import annotations

import dataclasses
from typing import Any

import pytest

from sidecar.ai.context.token_budget import BudgetTracker
from sidecar.ai.feature_flags import FEATURE_TOKEN_BUDGET
from sidecar.ai.routing import tool_loop, tool_loop_compaction
from sidecar.runtime.chat import resume_chat_send_response_from_approval_plan
from tests.sidecar.ai.routing.test_replay_blanket_approval import (
    SimpleNamespace,
    ToolPolicySnapshot,
    _build_replay_router,
    _read_then_write_file_script,
)


@pytest.mark.parametrize("token_budget", [True, False])
def test_approval_resume_gives_the_tool_loop_a_budget_tracker(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch, token_budget: bool,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "notes.md").write_text("before approval", encoding="utf-8")
    router = _build_replay_router(
        tmp_path,
        snapshot=ToolPolicySnapshot.empty(),
        script_path=_read_then_write_file_script(tmp_path),
    )
    prompt = "Read notes.md, then update it with a short greeting."
    messages = [{"role": "user", "content": prompt}]
    decision = router.build_chat_decision(
        request_id="req-resume-budget",
        messages=messages,
        latest_user_content=prompt,
        mode="assist",
        approvals_pre_granted=False,
    )
    assert decision.approval_plan is not None
    config = dataclasses.replace(
        router._config,  # noqa: SLF001 - harness config injection
        feature_flags={**(router._config.feature_flags or {}), FEATURE_TOKEN_BUDGET: token_budget},  # noqa: SLF001
    )
    router._config = config  # noqa: SLF001 - one config object, as in the real stack
    trackers: list[object] = []
    real_run_tool_loop = tool_loop.run_tool_loop

    def _capturing_run_tool_loop(**kwargs: Any) -> Any:
        trackers.append(kwargs["budget_tracker"])
        return real_run_tool_loop(**kwargs)

    monkeypatch.setattr(tool_loop, "run_tool_loop", _capturing_run_tool_loop)

    resume_chat_send_response_from_approval_plan(
        decision.approval_plan,
        brain_container=SimpleNamespace(
            stack=SimpleNamespace(
                config=config,
                engine=router._engine,  # noqa: SLF001
                router=router,
                tool_observations=None,
            ),
            subprocess_manager=None,
        ),
        live_params={"messages": messages},
        canonical_session_messages=[],
    )

    assert len(trackers) == 1
    if token_budget:
        assert isinstance(trackers[0], BudgetTracker)
    else:
        assert trackers[0] is None


def test_approval_resume_checks_context_before_its_first_call(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The approved tools' results are appended before the resumed loop starts,
    so the post-tool compaction check must run before its first generation."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "notes.md").write_text("before approval", encoding="utf-8")
    router = _build_replay_router(
        tmp_path,
        snapshot=ToolPolicySnapshot.empty(),
        script_path=_read_then_write_file_script(tmp_path),
    )
    prompt = "Read notes.md, then update it with a short greeting."
    messages = [{"role": "user", "content": prompt}]
    decision = router.build_chat_decision(
        request_id="req-resume-precheck",
        messages=messages,
        latest_user_content=prompt,
        mode="assist",
        approvals_pre_granted=False,
    )
    assert decision.approval_plan is not None
    config = dataclasses.replace(
        router._config,  # noqa: SLF001 - harness config injection
        feature_flags={**(router._config.feature_flags or {}), FEATURE_TOKEN_BUDGET: True},  # noqa: SLF001
    )
    router._config = config  # noqa: SLF001 - one config object, as in the real stack
    checks: list[int] = []
    real_compact = tool_loop_compaction.compact_tool_loop_context

    def _recording_compact(loop: Any, **kwargs: Any) -> int:
        checks.append(loop.completed_generations)
        return real_compact(loop, **kwargs)

    monkeypatch.setattr(tool_loop_compaction, "compact_tool_loop_context", _recording_compact)

    resume_chat_send_response_from_approval_plan(
        decision.approval_plan,
        brain_container=SimpleNamespace(
            stack=SimpleNamespace(
                config=config,
                engine=router._engine,  # noqa: SLF001
                router=router,
                tool_observations=None,
            ),
            subprocess_manager=None,
        ),
        live_params={"messages": messages},
        canonical_session_messages=[],
    )

    assert checks[:1] == [0]
