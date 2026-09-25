from __future__ import annotations

import hashlib
import json
from dataclasses import replace

import pytest

from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_resource_deferral import ToolLoopSuspended
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.runtime.chat_continuation_resume import (
    HydratedBeforeToolDispatchResume,
    resume_before_tool_dispatch,
)
from sidecar.runtime.continuation_checkpoint import _request_params
from sidecar.runtime.continuation_codec import encode_continuation_checkpoint
from tests.sidecar.ai.routing.test_tool_dependency_wait import Checkpoint
from tests.sidecar.ai.routing.test_tool_loop import _build_router, _ToolLoopEngine, _ToolPlan
from tests.sidecar.runtime.test_chat_continuation_resume import (
    _artifacts,
    _canonical,
    _fresh_request,
)


def dependency_artifacts():
    source = _artifacts()
    checkpoint = json.loads(source["checkpoint_body"])
    args = {"child_work_id": "child_1"}
    calls = json.loads(source["tool_batch_bytes"])["calls"][:1]
    calls[0].update(tool_id="session_wait", arguments=args)
    frozen = json.loads(source["frozen_input_bytes"])
    frozen.update(
        tool_name="session_wait",
        visible_tool_arguments=args,
        effective_tool_arguments=args,
        effective_args_fingerprint=hashlib.sha256(_canonical(args)).hexdigest(),
    )
    batch_bytes, frozen_bytes = _canonical({"calls": calls}), _canonical(frozen)
    batch_sha, frozen_sha = (
        hashlib.sha256(batch_bytes).hexdigest(),
        hashlib.sha256(frozen_bytes).hexdigest(),
    )
    checkpoint.update(
        kind="before_dependency_wait",
        completed_spawn_refs=[
            {"call_id": "spawn_1", "child_work_id": "child_1", "result_sha256": "d" * 64}
        ],
    )
    checkpoint["canonical_refs"]["tool_batch_ref"]["sha256"] = batch_sha
    checkpoint["pending_call"].update(
        tool_id="session_wait", effective_args_sha256=frozen["effective_args_fingerprint"]
    )
    checkpoint["pending_call"]["frozen_input_ref"]["sha256"] = frozen_sha
    checkpoint["position"].update(
        completed_iterations=2, current_iteration=2, ordered_call_ids=["call_1"]
    )
    checkpoint["wait"].update(kind="dependency", resource_class=None, dependency_id="child_1")
    checkpoint["eligibility"].update(prior_outcome_count=1, emitted_tool_execution_count=1)
    from sidecar.ai.routing.tool_quotas import ToolQuotaRegistry, policy_from_config
    quota = ToolQuotaRegistry(policy_from_config(_build_router(engine=_ToolLoopEngine([]))._config))
    quota.filter_calls([
        ToolCallRequest(call_id="spawn_1", tool_id="session_spawn", arguments={"task": "Read"}),
        ToolCallRequest(call_id="call_1", tool_id="session_wait", arguments=args),
    ], tool_contract=None)
    checkpoint.update(schema_version=7, base_schema_version=1, quota_state=quota.snapshot())
    encoded = encode_continuation_checkpoint(checkpoint)
    source.update(
        checkpoint_body=encoded.body,
        checkpoint_sha256=encoded.sha256,
        tool_batch_bytes=batch_bytes,
        tool_batch_sha256=batch_sha,
        frozen_input_bytes=frozen_bytes,
        frozen_input_sha256=frozen_sha,
    )
    source["checkpoint_ref"].update(sha256=encoded.sha256, bytes=len(encoded.body))
    return source


def test_real_dependency_resume_executes_wait_once_and_preserves_remaining_budget():
    artifacts = dependency_artifacts()
    with pytest.raises(ValueError, match="boundary_unsupported"):
        HydratedBeforeToolDispatchResume.from_artifacts(**artifacts)
    hydrated = HydratedBeforeToolDispatchResume.from_artifacts(**artifacts, allow_dependency=True)
    request, runtime = _fresh_request()
    request = replace(request, runtime_children_enabled=True, workspace_root_present=True)
    runtime.request_context = request
    engine = _ToolLoopEngine(
        [_ToolPlan(GenerationResult(content="Child answered.", finish_reason="stop"))]
    )
    router = _build_router(engine=engine)
    router._config = replace(router._config, electron_tool_bridge_enabled=True)
    executed = []

    def execute(call, **_kwargs):
        executed.append(call.tool_id)
        assert engine.call_count == 0
        assert runtime.tool_calls_consumed == 2
        return ToolExecutionOutcome(
            tool_name=call.tool_id,
            output='{"status":"completed","result":"Answer"}',
            success=True,
            call_id=call.call_id,
            tool_input=dict(call.arguments),
        )

    router._execute_tool = execute
    runtime.continuation_resume = lambda **kwargs: resume_before_tool_dispatch(
        hydrated=hydrated, **kwargs
    )
    messages = [
        {"role": "user", "content": "Inspect"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "spawn_1",
                    "type": "function",
                    "function": {"name": "session_spawn", "arguments": '{"task":"Read"}'},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "spawn_1", "content": '{"child_work_id":"child_1"}'},
    ]
    decision = router.build_chat_decision(
        request_id=request.request_id,
        session_id=request.session_id,
        request_context=request,
        runtime=runtime,
        messages=messages,
        latest_user_content="Inspect",
        mode="assist",
        approvals_pre_granted=False,
    )
    assert decision.response_text == "Child answered."
    assert executed == ["session_wait"]
    assert engine.call_count == 1
    assert runtime.tool_call_limit == 6
    assert runtime.tool_calls_consumed == 2
    assert runtime.iteration_base == 2
    assert runtime.max_iterations == 3


@pytest.mark.parametrize("next_id", ["wait_2", "call_1", "spawn_1"])
def test_resumed_dependency_can_checkpoint_again_without_replaying_effects_or_reusing_ids(next_id):
    artifacts = dependency_artifacts()
    hydrated = HydratedBeforeToolDispatchResume.from_artifacts(**artifacts, allow_dependency=True)
    request, runtime = _fresh_request()
    request = replace(request, runtime_children_enabled=True, workspace_root_present=True)
    runtime.request_context = request
    runtime.streaming = True
    probe = Checkpoint()
    runtime.continuation_checkpoint = probe
    engine = _ToolLoopEngine(
        [
            _ToolPlan(
                GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            call_id=next_id,
                            tool_id="session_wait",
                            arguments={"child_work_id": "child_1"},
                        ),
                    ),
                )
            )
        ]
    )
    router = _build_router(engine=engine)
    router._config = replace(router._config, electron_tool_bridge_enabled=True)
    executed = []

    def execute(call, **_kwargs):
        executed.append(call.call_id)
        return ToolExecutionOutcome(
            tool_name=call.tool_id,
            success=True,
            call_id=call.call_id,
            tool_input=dict(call.arguments),
            output=json.dumps(
                {
                    "child_work_id": "child_1",
                    "session_id": "child_session",
                    "turn_id": "child_turn",
                    "status": "completed",
                    "result": "Answer Ω🧑",
                    "truncated": False,
                }
            ),
        )

    router._execute_tool = execute
    runtime.continuation_resume = lambda **kwargs: resume_before_tool_dispatch(
        hydrated=hydrated, **kwargs
    )
    with pytest.raises(ToolLoopSuspended):
        router.build_chat_decision(
            request_id=request.request_id,
            session_id=request.session_id,
            request_context=request,
            runtime=runtime,
            messages=[{"role": "user", "content": "Inspect"}],
            latest_user_content="Inspect",
            mode="assist",
            approvals_pre_granted=False,
        )
    assert executed == ["call_1"]
    assert engine.call_count == 1
    value = probe.probes[0]
    assert value.pending.call_id not in {"call_1", "spawn_1"}
    assert value.current_iteration == 3
    assert value.remaining_iterations == 2
    assert value.tool_calls_consumed == 3
    assert value.tool_call_limit == 6
    assert value.prior_effect_count == 1
    assert value.completed_wait_refs[0].call_id == "call_1"
    expected_result = {
        "child_work_id": "child_1",
        "session_id": "child_session",
        "turn_id": "child_turn",
        "status": "completed",
        "result": "Answer Ω🧑",
        "truncated": False,
    }
    assert (
        value.completed_wait_refs[0].result_sha256
        == hashlib.sha256(
            json.dumps(
                expected_result, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ).encode()
        ).hexdigest()
    )
    assert json.loads(value.prior_checkpoint_json) == artifacts["checkpoint_ref"]
    params = _request_params(request.continuation_context, value)
    assert params["eligibility"]["prior_outcome_count"] == 1
    assert params["eligibility"]["emitted_tool_execution_count"] == 1
    assert params["completed_wait_refs"] == [value.completed_wait_refs[0].to_wire()]
    assert runtime.tool_result_emitted_call_ids == {"call_1"}
