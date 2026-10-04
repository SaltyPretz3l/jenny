"""Per-request safety mode and auto-approve streak cap (owner decision D3).

Electron sends ``safety_mode`` and ``auto_approve_streak_cap`` on every
``chat.send`` so a Settings change applies from the next turn without a
sidecar config refresh. The request value wins over ``RuntimeConfig``;
omitted or invalid values fall back to the config and never fail the turn.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.routing import route_policy_runtime
from sidecar.ai.routing.tool_execution import approval_if_needed
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.runtime import turn_state


class _Contract:
    def __init__(self, descriptor: object) -> None:
        self._descriptor = descriptor

    def entry(self, tool_name: str) -> object | None:
        if tool_name != getattr(self._descriptor, "name", ""):
            return None
        return SimpleNamespace(available=True, descriptor=self._descriptor)


def _kernel(descriptor: object, config: RuntimeConfig) -> SimpleNamespace:
    return SimpleNamespace(
        _config=config,
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )


def _read_file_approval(config: RuntimeConfig) -> Any:
    descriptor = SimpleNamespace(
        name="read_file",
        side_effecting=False,
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
    )
    return approval_if_needed(
        _kernel(descriptor, config),
        (ToolCallRequest(tool_id="read_file", arguments={"path": "README.md"}, call_id="read-1"),),
        mode="assist",
        mode_allows_side_effecting=True,
        require_approval=True,
        approvals_pre_granted=False,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
    )


def _auto_run_write_approval(config: RuntimeConfig, state: turn_state.LiveRunModeState) -> Any:
    descriptor = SimpleNamespace(
        name="write_file",
        side_effecting=True,
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
        source_kind="mcp",
        tool_family="filesystem",
        server_name="tools",
    )
    with turn_state.bind_live_run_mode_state(state):
        return approval_if_needed(
            _kernel(descriptor, config),
            (ToolCallRequest(tool_id="write_file", arguments={"path": "a.md"}, call_id="w-1"),),
            mode="assist",
            mode_allows_side_effecting=True,
            require_approval=True,
            approvals_pre_granted=False,
            resolution_context=None,
            tool_contract=_Contract(descriptor),
            approval_mode="auto_run",
        )


def _in_chat_send(params: Any, run: Any) -> Any:
    """Run *run* the way request_dispatch_chat binds a chat.send request."""

    @route_policy_runtime.with_request_safety
    def process(*, params: Any) -> Any:
        del params
        return run()

    return process(params=params)


def test_request_paranoid_mode_prompts_while_config_is_normal() -> None:
    config = RuntimeConfig(safety_mode="normal")

    approval = _in_chat_send({"safety_mode": "paranoid"}, lambda: _read_file_approval(config))

    assert approval is not None
    assert "paranoid safety mode" in approval.reason.lower()
    assert _read_file_approval(config) is None, "the binding must not outlive its request"


def test_request_normal_mode_relaxes_a_paranoid_config() -> None:
    config = RuntimeConfig(safety_mode="paranoid")

    assert _in_chat_send({"safety_mode": "normal"}, lambda: _read_file_approval(config)) is None


def test_request_streak_cap_prompts_after_one_auto_approval() -> None:
    config = RuntimeConfig(safety_mode="normal", auto_approve_streak_cap=50)
    state = turn_state.LiveRunModeState(approval_mode="auto_run", auto_approvals=1)

    approval = _in_chat_send(
        {"auto_approve_streak_cap": 1}, lambda: _auto_run_write_approval(config, state)
    )

    assert approval is not None
    assert approval.reason == "1 consecutive automatic approvals in this turn. Approve to continue."
    assert approval.one_off_only is True
    assert state.auto_approvals == 1


def test_omitted_fields_use_the_config_values() -> None:
    paranoid = RuntimeConfig(safety_mode="paranoid", auto_approve_streak_cap=2)
    normal = RuntimeConfig(safety_mode="normal", auto_approve_streak_cap=2)
    state = turn_state.LiveRunModeState(approval_mode="auto_run", auto_approvals=1)

    assert _in_chat_send({}, lambda: _read_file_approval(paranoid)) is not None
    assert _in_chat_send({}, lambda: _auto_run_write_approval(normal, state)) is None
    assert state.auto_approvals == 2
    approval = _in_chat_send({}, lambda: _auto_run_write_approval(normal, state))
    assert approval is not None
    assert approval.reason.startswith("2 consecutive automatic approvals")


@pytest.mark.parametrize("safety_mode", ["loud", "", None, 3, ["paranoid"]])
def test_invalid_request_safety_mode_falls_back_to_config(safety_mode: object) -> None:
    normal = RuntimeConfig(safety_mode="normal")
    paranoid = RuntimeConfig(safety_mode="paranoid")
    params = {"safety_mode": safety_mode}

    assert _in_chat_send(params, lambda: _read_file_approval(normal)) is None
    assert _in_chat_send(params, lambda: _read_file_approval(paranoid)) is not None


@pytest.mark.parametrize("cap", ["1", True, None, float("nan"), float("inf"), {"cap": 1}])
def test_invalid_request_streak_cap_falls_back_to_config(cap: object) -> None:
    config = RuntimeConfig(safety_mode="normal", auto_approve_streak_cap=50)
    state = turn_state.LiveRunModeState(approval_mode="auto_run", auto_approvals=1)

    approval = _in_chat_send(
        {"auto_approve_streak_cap": cap}, lambda: _auto_run_write_approval(config, state)
    )

    assert approval is None
    assert state.auto_approvals == 2


def test_request_values_count_only_when_the_config_parser_accepts_them_unchanged() -> None:
    config = RuntimeConfig(safety_mode="normal", auto_approve_streak_cap=50)

    def resolved(params: dict[str, Any]) -> tuple[str, int]:
        def read() -> tuple[str, int]:
            context = route_policy_runtime.current_request_safety()
            return (
                route_policy_runtime.resolve_safety_mode(context, config),
                route_policy_runtime.resolve_streak_cap(context, config),
            )

        return _in_chat_send(params, read)

    # A clamped value never lowers the guard: fractional, negative and oversized
    # caps fall back to the config instead of becoming 7, 0 or 500.
    assert resolved({"safety_mode": " PARANOID ", "auto_approve_streak_cap": 7.9}) == (
        "paranoid",
        50,
    )
    assert resolved({"safety_mode": "strict", "auto_approve_streak_cap": -3}) == ("strict", 50)
    assert resolved({"auto_approve_streak_cap": 900}) == ("normal", 50)
    assert resolved({"auto_approve_streak_cap": 0}) == ("normal", 0)
    assert resolved({"auto_approve_streak_cap": 12.0}) == ("normal", 12)
    assert route_policy_runtime.resolve_safety_mode(None, config) == "normal"
    assert route_policy_runtime.resolve_streak_cap(None, config) == 50


def test_non_dict_params_bind_nothing() -> None:
    config = RuntimeConfig(safety_mode="paranoid")

    def current() -> Any:
        return route_policy_runtime.current_request_safety()

    assert _in_chat_send(None, current) is None
    assert _in_chat_send(["safety_mode", "normal"], current) is None
    assert route_policy_runtime.resolve_safety_mode(_in_chat_send(None, current), config) == (
        "paranoid"
    )

def test_parallel_delegate_children_run_inside_the_request_safety_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ThreadPoolExecutor.submit starts on a bare context; the scheduler copies ours."""

    import time

    from sidecar.ai.routing import subagent_scheduler
    from sidecar.ai.routing.delegate_contracts import DelegateTask
    from sidecar.ai.routing.sub_agent_invocation import SubAgentIdentity
    from sidecar.runtime.subagent_slots import SubAgentSlotAllocator

    seen: dict[int, Any] = {}

    def fake_invoke(**kwargs: Any) -> Any:
        seen[kwargs["task"].ordinal] = route_policy_runtime.current_request_safety()
        return kwargs["task"].ordinal

    monkeypatch.setattr(subagent_scheduler, "_invoke_task", fake_invoke)
    ordinals = (1, 2)
    tasks = tuple(DelegateTask(ordinal=n, prompt=f"task {n}") for n in ordinals)
    identities = {
        n: SubAgentIdentity(
            invocation_id=f"inv-{n}", task_id=f"task-{n}", agent_id=f"agent-{n}", parent_agent_id="parent"
        )
        for n in ordinals
    }
    runtime = SimpleNamespace(
        sub_agent_slot_allocator=SubAgentSlotAllocator(max_active_sub_agents=4, max_sub_agents_per_parent=4)
    )

    def run() -> Any:
        return subagent_scheduler._run_parallel(
            router=None,
            parent_context=None,
            runtime=runtime,
            tasks=tasks,
            identities=identities,
            effective_runtime_ms=1000,
            delegate_deadline=time.monotonic() + 10,
            task_iteration_limit=3,
            on_task_started=None,
            on_task_settled=None,
        )

    invocations, failed = _in_chat_send({"safety_mode": "paranoid"}, run)

    assert failed is False
    assert invocations == (1, 2)
    assert [context.safety_mode for context in seen.values()] == ["paranoid", "paranoid"]
