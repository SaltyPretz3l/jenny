from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace

import pytest

from sidecar.ai.routing.tool_execution import freeze_effective_execution_inputs
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.runtime.approval_plan import (
    SIDECAR_HISTORY_HASH_FIELDS,
    ApprovalPlan,
    ApprovalPlanCache,
    ApprovalPlanCacheCapacityError,
    FrozenExecutionInputs,
    build_approval_plan,
    build_message_history_hash,
    clamp_approval_plan_ttl,
    describe_approval_plan_changes,
)
from sidecar.runtime.chat_resume import _approval_resume_deadline


def _stub_plan(
    call_id: str = "call-1",
    *,
    request_id: str = "req-1",
    session_id: str = "session-1",
) -> ApprovalPlan:
    return ApprovalPlan(
        call_id=call_id,
        approved_call_id=call_id,
        request_id=request_id,
        trace_id="trace-1",
        session_id=session_id,
        request_context=SimpleNamespace(
            request_id=request_id,
            trace_id="trace-1",
            session_id=session_id,
            mode="chat",
            reasoning_effort="medium",
            tool_preferences=None,
            plan_mode=False,
        ),
        latest_user_content="hello",
        working_messages=({"role": "system", "content": "System"},),
        generation_result=SimpleNamespace(content="Calling write_file"),
        tool_calls=(
            ToolCallRequest(
                tool_id="write_file",
                arguments={"path": "notes.txt", "content": "hi"},
                call_id=call_id,
            ),
        ),
        frozen_inputs=(),
        tool_contract=SimpleNamespace(prompt_schemas=(), status_entries=()),
        tool_resolution_context=None,
        read_snapshot_cache={},
        outcomes=(),
        usage_totals=None,
        streamed_event_types=frozenset(),
        system_prompt="System",
        prompt_cache_enabled=False,
        cache_source_key="req-1",
        remaining_iterations=2,
        request_messages_hash="request-history-hash",
        tool_payload=(),
        tool_statuses=(),
        tool_contract_hash="tool-contract-hash",
        effective_args_fingerprint="effective-hash",
        execution_context_fingerprint="context-hash",
        model_identity_fingerprint="model-hash",
        system_prompt_hash="prompt-hash",
        sampling_params_hash="sampling-hash",
        message_history_hash="history-hash",
        parent_approval_plan_hash="",
        approval_plan_hash="plan-hash",
    )


def test_clamp_approval_plan_ttl_bounds_values() -> None:
    assert clamp_approval_plan_ttl(1.0) == 60.0
    assert clamp_approval_plan_ttl(120.0) == 120.0
    assert clamp_approval_plan_ttl(10_000.0) == 600.0


def test_approval_plan_cache_put_consume_and_expire() -> None:
    clock = {"now": 100.0}
    cache = ApprovalPlanCache(now_fn=lambda: clock["now"])
    plan = _stub_plan()

    cache.put(plan, ttl_seconds=120.0)
    assert cache.consume("req-1", "call-1") == plan
    assert cache.consume("req-1", "call-1") is None

    cache.put(plan, ttl_seconds=120.0)
    clock["now"] = 1000.0
    assert cache.consume("req-1", "call-1") is None


def test_approval_plan_cache_evict_removes_denied_plan_without_consuming() -> None:
    cache = ApprovalPlanCache()
    plan = _stub_plan()

    cache.put(plan, ttl_seconds=120.0)

    assert cache.evict("req-1", "call-1") == plan
    assert cache.consume("req-1", "call-1") is None


def test_approval_plan_cache_isolates_concurrent_same_call_id() -> None:
    cache = ApprovalPlanCache()
    plan_a = _stub_plan(call_id="call-shared", request_id="req-A")
    plan_b = _stub_plan(call_id="call-shared", request_id="req-B")

    cache.put(plan_a, ttl_seconds=120.0)
    cache.put(plan_b, ttl_seconds=120.0)

    assert cache.consume("req-A", "call-shared") is plan_a
    assert cache.consume("req-A", "call-shared") is None

    assert cache.consume("req-B", "call-shared") is plan_b
    assert cache.consume("req-B", "call-shared") is None


def test_approval_plan_cache_evicts_oldest_global_entry() -> None:
    cache = ApprovalPlanCache(
        max_entries=2,
        max_session_entries=2,
        max_bytes=1_000,
        size_fn=lambda _plan: 10,
    )
    plans = [
        _stub_plan(call_id=f"call-{index}", request_id=f"req-{index}", session_id=f"s-{index}")
        for index in range(3)
    ]

    for plan in plans:
        cache.put(plan, ttl_seconds=120.0)

    assert cache.consume("req-0", "call-0") is None
    assert cache.consume("req-1", "call-1") is plans[1]
    assert cache.consume("req-2", "call-2") is plans[2]


def test_approval_plan_cache_evicts_oldest_session_entry() -> None:
    cache = ApprovalPlanCache(
        max_entries=10,
        max_session_entries=2,
        max_bytes=1_000,
        size_fn=lambda _plan: 10,
    )
    plans = [
        _stub_plan(call_id=f"call-{index}", request_id=f"req-{index}")
        for index in range(3)
    ]

    for plan in plans:
        cache.put(plan, ttl_seconds=120.0)

    assert cache.consume("req-0", "call-0") is None
    assert cache.consume("req-1", "call-1") is plans[1]
    assert cache.consume("req-2", "call-2") is plans[2]


def test_approval_plan_cache_evicts_oldest_entry_to_byte_bound() -> None:
    cache = ApprovalPlanCache(
        max_entries=10,
        max_session_entries=10,
        max_bytes=100,
        size_fn=lambda _plan: 60,
    )
    first = _stub_plan(call_id="call-first", request_id="req-first", session_id="one")
    second = _stub_plan(call_id="call-second", request_id="req-second", session_id="two")

    cache.put(first, ttl_seconds=120.0)
    cache.put(second, ttl_seconds=120.0)

    assert cache.consume("req-first", "call-first") is None
    assert cache.consume("req-second", "call-second") is second


def test_approval_plan_cache_rejects_single_oversized_plan() -> None:
    cache = ApprovalPlanCache(max_bytes=50, size_fn=lambda _plan: 51)

    with pytest.raises(ApprovalPlanCacheCapacityError) as exc_info:
        cache.put(_stub_plan(), ttl_seconds=120.0)

    assert exc_info.value.size_bytes == 51
    assert exc_info.value.limit_bytes == 50
    assert cache.consume("req-1", "call-1") is None


def test_approval_plan_cache_rejects_missing_request_id() -> None:
    cache = ApprovalPlanCache()
    plan = _stub_plan(request_id="")

    with pytest.raises(ValueError):
        cache.put(plan, ttl_seconds=120.0)


def test_describe_approval_plan_changes_groups_user_facing_buckets() -> None:
    plan = _stub_plan()

    changes = describe_approval_plan_changes(
        plan,
        tool_contract_hash="new-tool-contract",
        effective_args_fingerprint="new-effective-args",
        execution_context_fingerprint="new-context",
        model_identity_fingerprint="new-model",
        system_prompt_hash="new-prompt",
        sampling_params_hash="new-sampling",
        message_history_hash="new-history",
        request_messages_hash="new-request-history",
        parent_approval_plan_hash="new-parent-hash",
        remaining_iterations=99,
        tool_call_limit=4,
        remaining_tool_calls=2,
    )

    by_bucket = {str(item["bucket"]): item for item in changes}
    assert by_bucket["what_you_approved_changed"]["label"] == "What you approved changed"
    assert by_bucket["what_you_approved_changed"]["expanded_by_default"] is True
    assert by_bucket["what_you_approved_changed"]["components"] == (
        "tool_contract",
        "tool_arguments",
        "execution_context",
    )
    assert by_bucket["conversation_context_changed"]["label"] == (
        "Conversation context changed"
    )
    assert by_bucket["conversation_context_changed"]["components"] == (
        "system_prompt",
        "conversation_history",
    )
    assert by_bucket["internal_state_changed"]["label"] == "Internal state changed"
    assert by_bucket["internal_state_changed"]["expanded_by_default"] is False
    assert by_bucket["internal_state_changed"]["components"] == (
        "model_identity",
        "sampling_params",
        "parent_approval_plan",
        "remaining_iterations",
        "tool_budget",
    )


def test_build_message_history_hash_changes_only_for_tracked_fields() -> None:
    base_message = {
        "role": "assistant",
        "content": "hello",
        "tool_calls": [{"id": "call-1", "name": "read_file", "arguments": {"path": "a.txt"}}],
        "timestamp": "ignored",
    }
    original_hash = build_message_history_hash([base_message])

    changed = dict(base_message)
    changed["content"] = "hello again"
    assert build_message_history_hash([changed]) != original_hash

    ignored_only = dict(base_message)
    ignored_only["timestamp"] = "2026-04-13T00:00:00Z"
    assert build_message_history_hash([ignored_only]) == original_hash
    assert "content" in SIDECAR_HISTORY_HASH_FIELDS


def test_freeze_effective_execution_inputs_keeps_visible_args_and_freezes_snapshot() -> None:
    kernel = SimpleNamespace(
        _normalize_snapshot_lookup_path=lambda raw_path: str(raw_path or "").strip(),
    )
    call = ToolCallRequest(
        tool_id="write_file",
        arguments={"path": "notes.txt", "content": "updated"},
        call_id="call-write-1",
    )

    frozen = freeze_effective_execution_inputs(
        kernel,
        call,
        session_id="session-1",
        read_snapshot_cache={
            "notes.txt": {
                "path": "notes.txt",
                "scope": "full",
                "size_bytes": 10,
                "mtime_ns": 123,
                "sha256": "abc",
            }
        },
    )

    assert frozen.visible_tool_arguments == {"path": "notes.txt", "content": "updated"}
    assert "expected_read_snapshot" not in frozen.visible_tool_arguments
    assert frozen.effective_tool_arguments["expected_read_snapshot"]["sha256"] == "abc"
    assert frozen.effective_tool_arguments["_jenny_session_id"] == "session-1"
    assert frozen.injected_arg_keys == ("_jenny_session_id", "expected_read_snapshot")


@pytest.mark.parametrize(
    "tool_id",
    [
        "edit_file",
        "delete_file",
        "run_command",
        "workspace_change_baseline",
        "workspace_change_delta",
    ],
)
def test_freeze_effective_execution_inputs_injects_session_for_worktree_tracking(
    tool_id: str,
) -> None:
    kernel = SimpleNamespace(_normalize_snapshot_lookup_path=lambda value: str(value or ""))
    frozen = freeze_effective_execution_inputs(
        kernel,
        ToolCallRequest(tool_id=tool_id, arguments={}, call_id=f"call-{tool_id}"),
        session_id="session-track",
        read_snapshot_cache={},
    )
    assert frozen.visible_tool_arguments == {}
    assert frozen.effective_tool_arguments["_jenny_session_id"] == "session-track"


def test_freeze_effective_execution_inputs_injects_session_marker_without_mutating_visible_args() -> (
    None
):
    kernel = SimpleNamespace(
        _normalize_snapshot_lookup_path=lambda raw_path: str(raw_path or "").strip(),
    )
    call = ToolCallRequest(
        tool_id="todo_write",
        arguments={"items": ["one"]},
        call_id="call-todo-1",
    )

    frozen = freeze_effective_execution_inputs(
        kernel,
        call,
        session_id="session-xyz",
        read_snapshot_cache={},
    )

    assert frozen.visible_tool_arguments == {"items": ["one"]}
    assert "_jenny_session_id" not in frozen.visible_tool_arguments
    assert frozen.effective_tool_arguments["_jenny_session_id"] == "session-xyz"
    assert frozen.injected_arg_keys == ("_jenny_session_id",)


def test_freeze_effective_execution_inputs_injects_turn_context_for_mermaid() -> None:
    kernel = SimpleNamespace(
        _normalize_snapshot_lookup_path=lambda raw_path: str(raw_path or "").strip(),
    )
    call = ToolCallRequest(
        tool_id="mermaid_generate",
        arguments={"diagram_type": "flowchart", "prompt": "graph TD\nA --> B"},
        call_id="call-mermaid-1",
    )

    frozen = freeze_effective_execution_inputs(
        kernel,
        call,
        session_id="session-xyz",
        read_snapshot_cache={},
        read_only=True,
    )

    assert frozen.visible_tool_arguments == {
        "diagram_type": "flowchart",
        "prompt": "graph TD\nA --> B",
    }
    assert "_jenny_session_id" not in frozen.visible_tool_arguments
    assert "_jenny_read_only" not in frozen.visible_tool_arguments
    assert frozen.effective_tool_arguments["_jenny_session_id"] == "session-xyz"
    assert frozen.effective_tool_arguments["_jenny_read_only"] is True
    assert frozen.injected_arg_keys == ("_jenny_read_only", "_jenny_session_id")
    assert frozen.execution_context_payload["read_only"] is True


def test_build_approval_plan_uses_explicit_approved_call_id() -> None:
    class _MockEngine:
        pass

    tool_calls = (
        ToolCallRequest(
            tool_id="read_file",
            arguments={"path": "notes.txt"},
            call_id="call-read-1",
        ),
        ToolCallRequest(
            tool_id="write_file",
            arguments={"path": "notes.txt", "content": "updated"},
            call_id="call-write-2",
        ),
    )
    frozen_inputs = (
        FrozenExecutionInputs(
            call_id="call-read-1",
            tool_name="read_file",
            visible_tool_arguments={"path": "notes.txt"},
            effective_tool_arguments={"path": "notes.txt"},
            injected_arg_keys=(),
            effective_args_fingerprint="effective-read",
            execution_context_payload={"session_id": "session-1"},
        ),
        FrozenExecutionInputs(
            call_id="call-write-2",
            tool_name="write_file",
            visible_tool_arguments={"path": "notes.txt", "content": "updated"},
            effective_tool_arguments={"path": "notes.txt", "content": "updated"},
            injected_arg_keys=(),
            effective_args_fingerprint="effective-write",
            execution_context_payload={"session_id": "session-1"},
        ),
    )

    plan = build_approval_plan(
        approved_call_id="call-write-2",
        request_context=SimpleNamespace(
            request_id="req-1",
            trace_id="trace-1",
            session_id="session-1",
            mode="chat",
            reasoning_effort="medium",
            tool_preferences=None,
            plan_mode=False,
        ),
        latest_user_content="update the note",
        request_messages_hash="request-history-hash",
        working_messages=[{"role": "system", "content": "System"}],
        generation_result=SimpleNamespace(content="calling tools"),
        tool_calls=tool_calls,
        frozen_inputs=frozen_inputs,
        tool_contract=SimpleNamespace(prompt_schemas=(), status_entries=()),
        tool_resolution_context=None,
        read_snapshot_cache={},
        outcomes=(),
        usage_totals=None,
        streamed_event_types=frozenset(),
        system_prompt="System",
        prompt_cache_enabled=False,
        cache_source_key="req-1",
        remaining_iterations=1,
        wall_clock_deadline=1234.5,
        tool_call_limit=3,
        remaining_tool_calls=1,
        tool_payload=[],
        tool_statuses=(),
        parent_approval_plan_hash="parent-plan-hash",
        config=SimpleNamespace(
            engine_type="mock",
            model="mock-v1",
            model_tier="",
            fallback_model="",
            temperature=0.0,
            top_p=1.0,
            stop_sequences=None,
        ),
        engine=_MockEngine(),
        resolved_max_tokens=256,
    )

    assert plan.call_id == "call-write-2"
    assert plan.approved_call_id == "call-write-2"
    assert plan.parent_approval_plan_hash == "parent-plan-hash"
    assert plan.tool_call_limit == 3
    assert plan.remaining_tool_calls == 1
    assert plan.wall_clock_deadline == 1234.5


def test_approval_resume_reuses_original_request_deadline() -> None:
    assert (
        _approval_resume_deadline(
            SimpleNamespace(wall_clock_deadline=9876.5),
            max_loop_wall_seconds=120.0,
        )
        == 9876.5
    )


def test_describe_approval_plan_changes_reports_tool_budget_drift() -> None:
    base = _stub_plan()
    first = replace(base, tool_call_limit=4, remaining_tool_calls=2)
    second = replace(base, tool_call_limit=4, remaining_tool_calls=1)

    changes = describe_approval_plan_changes(
        first,
        tool_call_limit=second.tool_call_limit,
        remaining_tool_calls=second.remaining_tool_calls,
    )

    assert changes == (
        {
            "bucket": "internal_state_changed",
            "label": "Internal state changed",
            "expanded_by_default": False,
            "components": ("tool_budget",),
        },
    )


def test_build_approval_plan_parent_hash_changes_security_fingerprint() -> None:
    class _MockEngine:
        pass

    def _build(parent_hash: str) -> ApprovalPlan:
        return build_approval_plan(
            approved_call_id="call-write-1",
            request_context=SimpleNamespace(
                request_id="req-parent-hash",
                trace_id="trace-1",
                session_id="session-1",
                mode="assist",
                reasoning_effort="medium",
                tool_preferences={"disabled": ("python_execute",)},
                plan_mode=False,
            ),
            latest_user_content="verify the edit",
            request_messages_hash="request-history-hash",
            working_messages=[{"role": "system", "content": "System"}],
            generation_result=SimpleNamespace(content="calling tools"),
            tool_calls=(
                ToolCallRequest(
                    tool_id="write_file",
                    arguments={"path": "notes.txt", "content": "updated"},
                    call_id="call-write-1",
                ),
            ),
            frozen_inputs=(
                FrozenExecutionInputs(
                    call_id="call-write-1",
                    tool_name="write_file",
                    visible_tool_arguments={"path": "notes.txt", "content": "updated"},
                    effective_tool_arguments={"path": "notes.txt", "content": "updated"},
                    injected_arg_keys=(),
                    effective_args_fingerprint="effective-write",
                    execution_context_payload={"session_id": "session-1"},
                ),
            ),
            tool_contract=SimpleNamespace(prompt_schemas=(), status_entries=()),
            tool_resolution_context=None,
            read_snapshot_cache={},
            outcomes=(),
            usage_totals=None,
            streamed_event_types=frozenset(),
            system_prompt="System",
            prompt_cache_enabled=False,
            cache_source_key="req-parent-hash",
            remaining_iterations=1,
            tool_payload=[],
            tool_statuses=(),
            parent_approval_plan_hash=parent_hash,
            config=SimpleNamespace(
                engine_type="mock",
                model="mock-v1",
                model_tier="",
                fallback_model="",
                temperature=0.0,
                top_p=1.0,
                stop_sequences=None,
            ),
            engine=_MockEngine(),
            resolved_max_tokens=256,
        )

    root = _build("")
    child = _build("parent-anchor")

    assert root.parent_approval_plan_hash == ""
    assert child.parent_approval_plan_hash == "parent-anchor"
    assert root.approval_plan_hash != child.approval_plan_hash
