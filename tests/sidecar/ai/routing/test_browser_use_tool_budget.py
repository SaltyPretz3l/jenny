"""One browser step is one tool call: the turn's budget and its checkpoints (roadmap row 114)."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.routing import tool_loop_recovery
from sidecar.ai.routing.iteration_limits import (
    BROWSER_USE_TURN_STEPS,
    COMPUTER_USE_TURN_STEPS,
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


def test_a_turn_with_the_computer_tool_gets_its_steps_on_top_too() -> None:
    config = _config(20)
    assert turn_tool_call_limit(config, _contract("computer")) == 20 + COMPUTER_USE_TURN_STEPS
    both = _contract("browser", "computer")
    assert turn_tool_call_limit(config, both) == 20 + BROWSER_USE_TURN_STEPS + COMPUTER_USE_TURN_STEPS
    assert turn_tool_call_limit(_config(500), both) == 530


def test_the_raised_limit_stays_within_what_a_checkpoint_can_hold() -> None:
    browsing = _contract("browser")
    assert turn_tool_call_limit(_config(240), browsing) == 270
    assert turn_tool_call_limit(_config(500), browsing) == 530
    assert turn_tool_call_limit(_config(510), browsing) == 530


def test_an_approval_plan_from_a_browsing_turn_resumes_on_the_same_limit() -> None:
    limit = turn_tool_call_limit(_config(20), _contract("browser"))
    plan = SimpleNamespace(tool_call_limit=limit, remaining_tool_calls=limit - 3)

    assert _approval_resume_tool_budget(plan, configured_limit=limit) == (limit, limit - 3, True)
    assert _approval_resume_tool_budget(plan, configured_limit=20)[2] is False


def test_leaving_plan_mode_mid_turn_widens_the_budget_so_the_next_approval_resumes() -> None:
    # Plan Mode is read-only, so the side-effecting browser is not offered and the turn starts on
    # the bare limit. Build offers it: the budget must follow, or the next approval plan records
    # the old limit and the resume check (which reads the Build tools) calls it drift.
    from sidecar.ai.routing.iteration_limits import widen_turn_tool_budget

    config = _config(20)
    runtime = LoopRuntime(request_id="req-plan-exit")
    runtime.ensure_tool_call_budget(turn_tool_call_limit(config, _contract("read_file")))
    runtime.reserve_tool_calls(4)
    build_tools = _contract("browser", "read_file")

    widen_turn_tool_budget(runtime, config, build_tools)

    plan = SimpleNamespace(
        tool_call_limit=runtime.tool_call_limit, remaining_tool_calls=runtime.remaining_tool_calls
    )
    resume_limit = turn_tool_call_limit(config, build_tools)
    assert (runtime.tool_call_limit, runtime.tool_calls_consumed) == (20 + BROWSER_USE_TURN_STEPS, 4)
    assert _approval_resume_tool_budget(plan, configured_limit=resume_limit)[2] is True


def test_widening_never_shrinks_the_budget_or_starts_one() -> None:
    from sidecar.ai.routing.iteration_limits import widen_turn_tool_budget

    config = _config(20)
    runtime = LoopRuntime(request_id="req-widen", tool_call_limit=50, tool_calls_consumed=7)
    widen_turn_tool_budget(runtime, config, _contract("read_file"))
    assert (runtime.tool_call_limit, runtime.tool_calls_consumed) == (50, 7)

    unstarted = LoopRuntime(request_id="req-unstarted")
    widen_turn_tool_budget(unstarted, config, _contract("browser"))
    assert unstarted.tool_call_limit is None


def test_every_plan_mode_exit_site_widens_the_budget_with_the_build_tools() -> None:
    # The three places that swap in the Build tools after exit_plan_mode (the loop, a checkpoint
    # continuation, an approval resume) must each widen the budget in the same block.
    import ast
    from pathlib import Path

    root = Path(__file__).resolve().parents[4]
    sites = (
        "sidecar/ai/routing/tool_loop_calls.py",
        "sidecar/runtime/chat_continuation_resume.py",
        "sidecar/runtime/chat_resume.py",
    )

    def called(node: ast.AST) -> set[str]:
        names = set()
        for child in ast.walk(node):
            if isinstance(child, ast.Call):
                func = child.func
                names.add(func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", ""))
        return names

    for site in sites:
        tree = ast.parse((root / site).read_text(encoding="utf-8"))
        blocks = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.If) and "apply_restored_tool_contract" in called(
                ast.Module(body=node.body, type_ignores=[]))
        ]
        assert blocks, f"{site}: no Plan Mode exit block found"
        for block in blocks:
            body = called(ast.Module(body=block.body, type_ignores=[]))
            assert "widen_turn_tool_budget" in body, f"{site}:{block.lineno} does not widen the budget"
