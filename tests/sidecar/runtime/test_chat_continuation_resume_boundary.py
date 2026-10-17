"""A restored batch that raises a session-proposal boundary ends the turn without generating."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

import sidecar.runtime.chat_continuation_resume as resume
from sidecar.ai.routing import auto_checkpoint
from sidecar.ai.routing.turn_boundary import TurnBoundary
from tests.sidecar.runtime.test_chat_continuation_resume import (
    _fresh_request,
    _hydrated,
    _resume_arguments,
)

_PROPOSAL_ID = "proposal_" + "ef" * 32


def test_resume_finishes_at_the_boundary_and_never_reaches_generation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request, runtime = _fresh_request()
    finished: list[Any] = []

    class _FakeRun:
        def __init__(self, **kwargs: Any) -> None:
            self.runtime = kwargs["runtime"]
            self.kernel = kwargs["kernel"]
            self.request_context = kwargs["request_context"]
            self.working_messages = kwargs["working_messages"]
            self.tool_payload = kwargs["tool_payload"]
            self.tool_contract = kwargs["tool_contract"]
            self.tool_resolution_context = kwargs["tool_resolution_context"]
            self.tool_preferences = kwargs["tool_preferences"]
            self.mode_policy = kwargs["mode_policy"]
            self.plan_mode = kwargs["plan_mode"]
            self.read_only = kwargs["read_only"]
            self.request_id = kwargs["request_id"]
            self.session_id = kwargs["session_id"]
            self.outcomes: list[Any] = []
            self.streamed_event_types: set[str] = set()
            self.outcome_index = 0
            self.completed_generations = 0
            self.budget_tracker = kwargs["budget_tracker"]
            self.usage_totals = SimpleNamespace()
            self.thinking_text = None

        def execute(self) -> object:
            raise AssertionError("a boundary must not start another generation")

        def _finish(self, loop_result: Any, *, reason: str) -> Any:
            finished.append((loop_result, reason))
            return loop_result

    boundary = TurnBoundary("awaiting_proposal", _PROPOSAL_ID)
    monkeypatch.setattr(resume, "_ToolLoopRun", _FakeRun)
    monkeypatch.setattr(
        resume,
        "_preflight_pending_batch",
        lambda run, result: (
            [(call, index + 1) for index, call in enumerate(result.tool_calls)],
            {},
            "prompt",
        ),
    )
    monkeypatch.setattr(resume, "execute_tool_calls_sequentially", lambda **_kwargs: boundary)
    monkeypatch.setattr(
        resume,
        "_finish_pending_batch",
        lambda *_args: pytest.fail("the pending-batch finish must not run after a boundary"),
    )
    monkeypatch.setattr(auto_checkpoint, "maybe_create_auto_checkpoint", lambda *_a: None)
    arguments = _resume_arguments(_hydrated(), request, runtime)
    arguments["kernel"]._config = SimpleNamespace(feature_flags={"resource_discipline": False})
    arguments["deferred_budget_initializer"] = lambda: pytest.fail(
        "budget initialisation must not run after a boundary"
    )

    result = resume.resume_before_tool_dispatch(**arguments)

    assert len(finished) == 1
    loop_result, reason = finished[0]
    assert reason == "turn_boundary"
    assert loop_result is result
    assert loop_result.turn_boundary == boundary
    assert loop_result.response_text == ""
    assert loop_result.approval_request is None
