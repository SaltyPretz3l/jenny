"""One browser step is one tool call: the turn's budget and its checkpoints (roadmap row 114)."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.routing import tool_loop_recovery
from sidecar.ai.routing.iteration_limits import (
    BROWSER_USE_TURN_STEPS,
    effective_max_tools_per_turn,
    turn_tool_call_limit,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.tool_resource_deferral import (
    PreparedToolDeferral,
    build_before_tool_dispatch_continuation,
)
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.runtime.approval_plan import FrozenExecutionInputs, stable_hash
from sidecar.runtime.chat_resume import _approval_resume_tool_budget


def _call(tool_id: str, call_id: str) -> ToolCallRequest:
    return ToolCallRequest(call_id=call_id, tool_id=tool_id, arguments={"action": "read"})


def _browser(call_id: str) -> ToolCallRequest:
    return _call("browser", call_id)


def _admit(
    monkeypatch: pytest.MonkeyPatch, limit: int, calls: list[ToolCallRequest], consumed: int = 0
) -> tuple[SimpleNamespace, list[str], list[str]]:
    runtime = LoopRuntime(
        request_id="req-budget", tool_call_limit=limit, tool_calls_consumed=consumed
    )
    loop = SimpleNamespace(
        runtime=runtime, request_id="req-budget", working_messages=[],
        tool_payload=[{"name": "browser"}], tool_cap_tools_stripped=False,
        tool_budget_exhausted_notified=False,
    )
    rejected: list[str] = []
    monkeypatch.setattr(
        tool_loop_recovery, "record_failed_tool_calls",
        lambda _loop, _result, dropped, **_kw: rejected.extend(c.call_id for c in dropped),
    )
    monkeypatch.setattr(tool_loop_recovery, "emit_degradation_status", lambda *_a, **_k: None)
    monkeypatch.setattr(tool_loop_recovery, "finish_all_blocked_iteration", lambda *_a, **_k: None)
    admitted, _blocked = tool_loop_recovery.admit_tool_calls_for_turn(
        loop, GenerationResult(content="", tool_calls=tuple(calls)), last_error_output=None
    )
    return loop, [c.call_id for c in admitted.tool_calls], rejected


def _contract(*names: str) -> SimpleNamespace:
    return SimpleNamespace(executable_descriptor=lambda name: object() if name in names else None)


def _config(limit: int) -> Any:
    return RuntimeConfig(engine_type="replay", max_tools_per_turn=limit)


def test_a_browser_batch_can_be_checkpointed(monkeypatch: pytest.MonkeyPatch) -> None:
    # Every chat with a checkpoint callback builds this before the first tool runs, so a browser
    # call that is not counted fails the whole turn with invalid_tool_calls_consumed.
    call = _browser("b1")
    loop, admitted, rejected = _admit(monkeypatch, 50, [call])
    effective = {"action": "read"}
    frozen = FrozenExecutionInputs(
        call_id="b1", tool_name="browser", visible_tool_arguments=effective,
        effective_tool_arguments=effective, injected_arg_keys=(),
        effective_args_fingerprint=stable_hash(effective), execution_context_payload={},
    )
    prepared = PreparedToolDeferral.freeze(
        wait=None, call_id="b1", tool_id="browser", frozen_inputs=frozen
    )

    continuation = build_before_tool_dispatch_continuation(
        prepared, ordered_call_ids=("b1",), current_iteration=1, remaining_iterations=3,
        tool_call_limit=loop.runtime.tool_call_limit,
        tool_calls_consumed=loop.runtime.tool_calls_consumed,
        active_budget_ms_remaining=None, tool_calls=(call,),
    )

    assert (admitted, rejected) == (["b1"], [])
    assert continuation.tool_calls_consumed == 1


def test_browser_calls_spend_the_budget_like_any_other_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = [_browser("b1"), _call("read_file", "r1"), _browser("b2")]

    loop, admitted, rejected = _admit(monkeypatch, 2, calls)

    assert (admitted, rejected) == (["b1", "r1"], ["b2"])
    assert (loop.runtime.tool_call_limit, loop.runtime.tool_calls_consumed) == (2, 2)


def test_a_turn_that_can_browse_gets_the_browser_steps_on_top() -> None:
    config = _config(20)
    assert effective_max_tools_per_turn(config) == 20
    assert turn_tool_call_limit(config, _contract("browser", "read_file")) == 20 + BROWSER_USE_TURN_STEPS
    assert turn_tool_call_limit(config, _contract("read_file")) == 20
    assert turn_tool_call_limit(config, _contract("mcp__x__browser_click")) == 20
    assert turn_tool_call_limit(config, None) == 20


def test_the_raised_limit_stays_within_what_a_checkpoint_can_hold() -> None:
    browsing = _contract("browser")
    assert turn_tool_call_limit(_config(226), browsing) == 256
    assert turn_tool_call_limit(_config(240), browsing) == 256
    assert turn_tool_call_limit(_config(300), browsing) == 300


def test_an_approval_plan_from_a_browsing_turn_resumes_on_the_same_limit() -> None:
    limit = turn_tool_call_limit(_config(20), _contract("browser"))
    plan = SimpleNamespace(tool_call_limit=limit, remaining_tool_calls=limit - 3)

    assert _approval_resume_tool_budget(plan, configured_limit=limit) == (limit, limit - 3, True)
    assert _approval_resume_tool_budget(plan, configured_limit=20)[2] is False
