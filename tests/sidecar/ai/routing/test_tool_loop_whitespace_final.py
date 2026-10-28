"""A no-tool reply that sanitizes to nothing gets one retry, then ends the turn (C3 #1).

Before the fix the loop appended nothing and re-generated the identical history
until the iteration cap, then reported a misleading tool-iteration-limit ending.
The single retry keeps the existing non-Ollama behaviour (test_router nudge
tests): a sampled model may recover on the second ask.
"""

from __future__ import annotations

import pytest

from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.models import GenerationResult
from tests.sidecar.ai.routing.test_tool_loop import _build_router, _ToolLoopEngine, _ToolPlan

_CANNED = "I could not produce a valid response for that request."


@pytest.mark.parametrize("content", ["   \n", "\n\n\t  "])
def test_repeated_whitespace_only_reply_ends_the_turn_after_two_generations(content: str) -> None:
    engine = _ToolLoopEngine(
        [
            _ToolPlan(GenerationResult(content=content, finish_reason="stop")),
            _ToolPlan(GenerationResult(content=content, finish_reason="stop")),
            _ToolPlan(GenerationResult(content="never asked", finish_reason="stop")),
        ]
    )
    router = _build_router(engine=engine)
    events: list[object] = []

    result = router.build_chat_decision(
        request_id="req_whitespace_final",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_whitespace_final",
            max_iterations=6,
            streaming=True,
        ),
    )

    assert engine.call_count == 2
    assert result.response_text == _CANNED
    assert result.completion_source == "deterministic_tool_fallback"


def test_whitespace_only_reply_is_asked_again_once_and_the_recovery_is_kept() -> None:
    engine = _ToolLoopEngine(
        [
            _ToolPlan(GenerationResult(content="  \n", finish_reason="stop")),
            _ToolPlan(GenerationResult(content="A real answer.", finish_reason="stop")),
        ]
    )
    router = _build_router(engine=engine)

    result = router.build_chat_decision(
        request_id="req_whitespace_recovers",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=lambda _event: None,
            request_id="req_whitespace_recovers",
            max_iterations=6,
            streaming=True,
        ),
    )

    assert engine.call_count == 2
    assert result.response_text == "A real answer."
