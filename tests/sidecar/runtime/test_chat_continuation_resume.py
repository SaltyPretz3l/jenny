from __future__ import annotations

import base64
import copy
import hashlib
import json
from types import SimpleNamespace
from typing import Any

import pytest

import sidecar.runtime.chat_continuation_batch as resume_batch
import sidecar.runtime.chat_continuation_resume as resume
from sidecar.ai.config import ToolPolicySnapshot
from sidecar.ai.feature_flags import FEATURE_AGENT_EXECUTOR
from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.mode_policy import policy_for_mode
from sidecar.ai.routing import chat_decision as chat_decision_module
from sidecar.ai.routing import loop_runtime
from sidecar.ai.routing.router import ChatDecision, ToolExecutionOutcome
from sidecar.ai.routing.tool_loop import ToolLoopResult
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import GenerationResult
from sidecar.runtime import chat_resume_admission as admission_module
from sidecar.runtime.approval_input_bundle import encode_approval_inputs
from sidecar.runtime.approval_plan import stable_hash
from sidecar.runtime.chat import build_chat_send_response
from sidecar.runtime.chat_continuation_input import runtime_continuation_resume_from_params
from sidecar.runtime.chat_models import ChatRequestContext
from sidecar.runtime.continuation_codec import encode_continuation_checkpoint
from sidecar.runtime.continuation_context import (
    AuthorityReference,
    ContinuationContext,
    RouteReference,
    SourceAttempt,
)
from sidecar.runtime.execution_context import ExecutionContext
from tests.sidecar.ai.routing.test_tool_loop import _build_router, _ToolLoopEngine
from tests.sidecar.runtime.test_chat import _build_brain_container

_CHECKPOINT_ID = "checkpoint_" + ("1" * 64)
_SESSION_ID = "session_1"
_TURN_ID = "turn_1"
_WORK_ID = "work_1"
_SOURCE_A = {
    "attempt_id": "attempt_a",
    "stream_id": "stream_a",
    "incarnation": "incarnation_a",
    "authority_revision": "authority_a",
}
_AUTHORITY = {
    "project_id": "project_1",
    "root_id": "root_1",
    "root_revision": 4,
    "sha256": "a" * 64,
}
_ROUTE = {
    "route_id": "route_1",
    "route_revision": "provider:4",
    "sha256": "b" * 64,
}


def _ref(name: str, sha256: str = "c" * 64) -> dict[str, object]:
    return {"ref_id": name, "revision": 1, "sha256": sha256}


def _canonical(value: object) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")


def _artifacts() -> dict[str, Any]:
    calls = [
        {
            "call_id": "call_1",
            "tool_id": "read_metric",
            "arguments": {"value": 1.0},
            "idempotency_key": "idem_1",
            "coerced": False,
            "malformed_arguments": False,
            "argument_repairs": [],
        },
        {
            "call_id": "call_2",
            "tool_id": "read_metric",
            "arguments": {"value": 2},
            "idempotency_key": "idem_2",
            "coerced": False,
            "malformed_arguments": False,
            "argument_repairs": [],
        },
    ]
    tool_batch = _canonical({"calls": calls})
    tool_batch_sha = hashlib.sha256(tool_batch).hexdigest()
    effective = {"value": 1.0}
    frozen = {
        "call_id": "call_1",
        "effective_args_fingerprint": stable_hash(effective),
        "effective_tool_arguments": effective,
        "execution_context_payload": {
            "session_id": _SESSION_ID,
            "logical_turn_id": _TURN_ID,
            "authority_revision": "authority_a",
            "project_id": "project_1",
            "root_id": "root_1",
            "root_revision": 4,
        },
        "injected_arg_keys": [],
        "tool_name": "read_metric",
        "visible_tool_arguments": {"value": 1.0},
    }
    frozen_body = _canonical(frozen)
    frozen_sha = hashlib.sha256(frozen_body).hexdigest()
    checkpoint_value = {
        "schema_version": 1,
        "kind": "before_tool_dispatch",
        "identity": {
            "checkpoint_id": _CHECKPOINT_ID,
            "work_id": _WORK_ID,
            "turn_id": _TURN_ID,
            "request_id": "stream_a",
            "trace_id": None,
            "session_id": _SESSION_ID,
        },
        "source_attempt": dict(_SOURCE_A),
        "authority": dict(_AUTHORITY),
        "route": dict(_ROUTE),
        "canonical_refs": {
            "request_ref": _ref("request_ref_1"),
            "message_ref": _ref("message_ref_1"),
            "turn_ref": {
                **_ref("turn_ref_1"),
                "stream_id": "stream_a",
                "through_seq": 7,
            },
            "tool_batch_ref": _ref("tool_batch_ref_1", tool_batch_sha),
            "history_ref": _ref("history_ref_1"),
        },
        "position": {
            "completed_iterations": 1,
            "remaining_iterations": 3,
            "current_iteration": 1,
            "tool_call_limit": 6,
            "tool_calls_consumed": 2,
            "active_budget_ms_remaining": 5_000,
            "ordered_call_ids": ["call_1", "call_2"],
        },
        "pending_call": {
            "call_id": "call_1",
            "tool_id": "read_metric",
            "effective_args_sha256": stable_hash(effective),
            "frozen_input_ref": _ref("frozen_input_ref_1", frozen_sha),
        },
        "wait": {
            "kind": "resource",
            "resource_class": "tool_operations",
            "dependency_id": None,
            "operation_id": "call_1",
        },
        "eligibility": {
            "pending_call_index": 0,
            "prior_outcome_count": 0,
            "emitted_tool_execution_count": 0,
            "preview_count": 0,
            "approval_pending": False,
            "mutation_started": False,
        },
    }
    encoded = encode_continuation_checkpoint(checkpoint_value)
    return {
        "checkpoint_body": encoded.body,
        "checkpoint_sha256": encoded.sha256,
        "checkpoint_ref": {
            "schema_version": 1,
            "checkpoint_id": _CHECKPOINT_ID,
            "sha256": encoded.sha256,
            "bytes": len(encoded.body),
            "source_attempt": dict(_SOURCE_A),
        },
        "resolved_source_attempt": dict(_SOURCE_A),
        "tool_batch_bytes": tool_batch,
        "tool_batch_sha256": tool_batch_sha,
        "frozen_input_bytes": frozen_body,
        "frozen_input_sha256": frozen_sha,
    }


def _hydrated() -> resume.HydratedBeforeToolDispatchResume:
    return resume.HydratedBeforeToolDispatchResume.from_artifacts(**_artifacts())


def _wire_resume() -> dict[str, Any]:
    artifacts = _artifacts()
    for key in ("checkpoint_body", "tool_batch_bytes", "frozen_input_bytes"):
        artifacts[key] = base64.b64encode(artifacts[key]).decode("ascii")
    return artifacts


def _fresh_request() -> tuple[ChatRequestContext, loop_runtime.LoopRuntime]:
    execution = ExecutionContext(
        schema_version=1,
        authority_revision="authority_b",
        project_id="project_1",
        root_path="G:\\workspace",
        root_id="root_1",
        root_revision=4,
        device_id=None,
        inode=None,
        tool_policy_snapshot=ToolPolicySnapshot.empty(),
        knowledge_roots=(),
    )
    continuation = ContinuationContext(
        schema_version=1,
        work_id=_WORK_ID,
        turn_id=_TURN_ID,
        source_attempt=SourceAttempt(
            attempt_id="attempt_b",
            stream_id="stream_b",
            incarnation="incarnation_b",
            authority_revision="authority_b",
        ),
        authority=AuthorityReference(
            project_id="project_1",
            root_id="root_1",
            root_revision=4,
            sha256="a" * 64,
        ),
        route=RouteReference(**_ROUTE),
        enclosing_session_id=_SESSION_ID,
    )
    request = ChatRequestContext(
        request_id="stream_b",
        trace_id=None,
        session_id=_SESSION_ID,
        mode="assist",
        approvals_pre_granted=False,
        logical_turn_id=_TURN_ID,
        continuation_context=continuation,
        execution_context=execution,
    )
    runtime = loop_runtime.LoopRuntime(
        request_id="stream_b",
        logical_turn_id=_TURN_ID,
        session_id=_SESSION_ID,
        request_context=request,
        max_iterations=8,
        wall_clock_deadline=20.0,
        clock=lambda: 10.0,
    )
    return request, runtime


def _descriptor(*, required: bool = True) -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name="read_metric",
        description="Read one metric",
        input_schema={
            "type": "object",
            "properties": {"value": {"type": "number"}},
            "required": ["value"] if required else [],
            "additionalProperties": False,
        },
        side_effecting=False,
        server_name="tools",
    )


def _preflight_run(monkeypatch: pytest.MonkeyPatch, descriptor: Any) -> Any:
    contract = SimpleNamespace(
        entry=lambda _name: SimpleNamespace(
            descriptor=descriptor,
            available=True,
            reason="",
            deferred=False,
        )
    )

    def _policy(calls: tuple[Any, ...], **_kwargs: Any) -> Any:
        return SimpleNamespace(
            denied=(),
            allowed=calls,
            decisions_by_call={},
            audit_metadata_by_call={},
        )

    kernel = SimpleNamespace(
        _config=SimpleNamespace(tools_enabled=True),
        _mcp_client=SimpleNamespace(tool_descriptor=lambda _name: descriptor),
        _filter_tool_calls_by_policy=_policy,
        _assert_valid_tool_call=lambda _call: None,
    )
    run = SimpleNamespace(
        outcomes=[],
        working_messages=[],
        kernel=kernel,
        mode_policy=policy_for_mode("assist"),
        request_id="stream_b",
        session_id=_SESSION_ID,
        request_context=SimpleNamespace(
            execution_context=SimpleNamespace(tool_policy_snapshot=ToolPolicySnapshot.empty()),
            approval_mode="prompt",
        ),
        tool_payload=[],
        tool_contract=contract,
        tool_resolution_context=None,
        request_disabled_tools=frozenset(),
        quota_registry=None,
        plan_mode=False,
        read_only=False,
    )
    monkeypatch.setattr(
        resume_batch,
        "apply_route_policy_pre_dispatch",
        lambda **kwargs: (SimpleNamespace(blocked=False, result=kwargs["result"]), 0),
    )
    monkeypatch.setattr(
        resume_batch._tool_loop,
        "_partition_unknown_tool_calls",
        lambda _kernel, calls, **_kwargs: (list(calls), []),
    )
    monkeypatch.setattr(
        resume_batch._tool_loop.tool_loop_recovery,
        "approval_with_recovery",
        lambda _run, result, **_kwargs: (None, result),
    )
    monkeypatch.setattr(
        resume_batch,
        "pre_filter_tool_calls",
        lambda calls, **_kwargs: (
            [(call, index + 1) for index, call in enumerate(calls)],
            len(calls),
        ),
    )
    return run


def test_hydration_preserves_exact_numeric_input_and_rejects_foreign_source() -> None:
    source = _artifacts()
    hydrated = resume.HydratedBeforeToolDispatchResume.from_artifacts(**source)
    source["resolved_source_attempt"]["attempt_id"] = "mutated"
    source["tool_batch_bytes"] = b"{}"

    calls = hydrated.tool_calls()
    restored = hydrated.restored_input().source_frozen_inputs()

    assert calls[0].arguments == {"value": 1.0}
    assert isinstance(calls[0].arguments["value"], float)
    assert restored.effective_tool_arguments == {"value": 1.0}

    foreign = _artifacts()
    foreign["resolved_source_attempt"] = {
        **foreign["resolved_source_attempt"],
        "attempt_id": "other_attempt",
    }
    with pytest.raises(resume.ContinuationResumeError, match="continuation_artifact_mismatch"):
        resume.HydratedBeforeToolDispatchResume.from_artifacts(**foreign)

    stale_scope = _artifacts()
    frozen = json.loads(stale_scope["frozen_input_bytes"])
    frozen["execution_context_payload"]["authority_revision"] = "foreign_authority"
    frozen_body = _canonical(frozen)
    frozen_sha = hashlib.sha256(frozen_body).hexdigest()
    checkpoint = json.loads(stale_scope["checkpoint_body"])
    checkpoint["pending_call"]["frozen_input_ref"]["sha256"] = frozen_sha
    encoded = encode_continuation_checkpoint(checkpoint)
    stale_scope.update(
        checkpoint_body=encoded.body,
        checkpoint_sha256=encoded.sha256,
        frozen_input_bytes=frozen_body,
        frozen_input_sha256=frozen_sha,
    )
    stale_scope["checkpoint_ref"].update(
        sha256=encoded.sha256,
        bytes=len(encoded.body),
    )
    with pytest.raises(resume.ContinuationResumeError, match="continuation_artifact_mismatch"):
        resume.HydratedBeforeToolDispatchResume.from_artifacts(**stale_scope)


def test_fresh_attempt_requires_same_turn_authority_route_and_new_stream() -> None:
    request, runtime = _fresh_request()
    changed_route = copy.copy(request.continuation_context)
    assert changed_route is not None
    object.__setattr__(
        changed_route,
        "route",
        RouteReference(route_id="route_2", route_revision="provider:4", sha256="d" * 64),
    )
    changed_request = copy.copy(request)
    object.__setattr__(changed_request, "continuation_context", changed_route)
    runtime.request_context = changed_request

    with pytest.raises(resume.ContinuationResumeError, match="fresh_context_mismatch"):
        resume.resume_before_tool_dispatch(
            **_resume_arguments(_hydrated(), changed_request, runtime)
        )


def test_private_wire_decoder_requires_exact_canonical_payload_and_identity() -> None:
    request, _runtime = _fresh_request()
    hydrated = runtime_continuation_resume_from_params(
        {"runtime_continuation_resume": _wire_resume()},
        request_id=request.request_id,
        session_id=request.session_id,
        logical_turn_id=_TURN_ID,
        continuation_context=request.continuation_context,
        execution_context=request.execution_context,
    )
    assert hydrated is not None
    assert tuple(call.call_id for call in hydrated.tool_calls()) == ("call_1", "call_2")

    malformed = _wire_resume()
    malformed["tool_batch_bytes"] += "="
    with pytest.raises(ValueError, match="canonical base64"):
        runtime_continuation_resume_from_params(
            {"runtime_continuation_resume": malformed},
            request_id=request.request_id,
            session_id=request.session_id,
            logical_turn_id=_TURN_ID,
            continuation_context=request.continuation_context,
            execution_context=request.execution_context,
        )


def test_chat_decision_uses_resume_callback_before_any_model_generation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = _ToolLoopEngine([])
    router = _build_router(engine=engine)
    request = ChatRequestContext(
        request_id="stream_b",
        trace_id=None,
        session_id=_SESSION_ID,
        mode="assist",
        approvals_pre_granted=False,
        logical_turn_id=_TURN_ID,
    )
    callback_calls: list[dict[str, Any]] = []
    budget_events: list[str] = []

    def _resume_callback(**kwargs: Any) -> ToolLoopResult:
        callback_calls.append(kwargs)
        kwargs["working_messages"].append({"role": "tool", "content": "x" * 20_000})
        budget_result = kwargs["deferred_budget_initializer"]()
        assert budget_result.budget_tracker == "restored_budget_guard"
        return ToolLoopResult(
            thinking_text=None,
            thinking_kind="status",
            persist_thinking=False,
            response_text="resumed",
            approval_request=None,
            approval_plan=None,
            outcomes=[],
            usage_totals=None,
            streamed_event_types=set(),
            completion_source="continuation_resume",
        )

    runtime = loop_runtime.LoopRuntime(
        request_id="stream_b",
        logical_turn_id=_TURN_ID,
        session_id=_SESSION_ID,
        request_context=request,
        continuation_resume=_resume_callback,
    )

    def _prepare_budget(*_args: Any, **kwargs: Any) -> Any:
        assert kwargs["working_messages"][-1] == {
            "role": "tool",
            "content": "x" * 20_000,
        }
        budget_events.append("after_pending_tool")
        return chat_decision_module._BudgetPreflightResult(
            kwargs["working_messages"], "restored_budget_guard"
        )

    monkeypatch.setattr(chat_decision_module, "_prepare_context_budget", _prepare_budget)
    decision = router.build_chat_decision(
        request_context=request,
        request_id="stream_b",
        messages=[{"role": "user", "content": "resume"}],
        latest_user_content="resume",
        mode="assist",
        approvals_pre_granted=False,
        session_id=_SESSION_ID,
        runtime=runtime,
    )

    assert decision.response_text == "resumed"
    assert decision.completion_source == "continuation_resume"
    assert engine.call_count == 0
    assert len(callback_calls) == 1
    assert callback_calls[0]["runtime"] is runtime
    assert callback_calls[0]["approvals_pre_granted"] is False
    assert callback_calls[0]["initial_thinking_text"] == (
        "Assembling semantic context and evaluating tool opportunities."
    )
    assert callable(callback_calls[0]["deferred_budget_initializer"])
    assert budget_events == ["after_pending_tool"]


def test_chat_request_decodes_and_injects_private_resume_before_executor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    decision = ChatDecision(None, "captured", None, ())
    brain = _build_brain_container(decision, feature_flags={FEATURE_AGENT_EXECUTOR: True})
    captured: dict[str, Any] = {}

    class _FakeExecutor:
        def __init__(self, **_kwargs: Any) -> None:
            pass

        def execute(self, **kwargs: Any) -> ChatDecision:
            captured.update(kwargs)
            return decision

    monkeypatch.setattr("sidecar.runtime.chat.AgentExecutor", _FakeExecutor)
    params = {
        "request_id": "stream_b",
        "session_id": _SESSION_ID,
        "logical_turn_id": _TURN_ID,
        "messages": [{"role": "user", "content": "resume"}],
        "execution_context": {
            "schema_version": 1,
            "authority_revision": "authority_b",
            "project_id": "project_1",
            "root_path": "G:\\workspace",
            "root_id": "root_1",
            "root_revision": 4,
            "device_id": None,
            "inode": None,
            "tool_policy_snapshot": {"version": 1, "legacy_policies": {}},
            "knowledge_roots": [],
        },
        "continuation_context": {
            "schema_version": 1,
            "work_id": _WORK_ID,
            "turn_id": _TURN_ID,
            "source_attempt": {
                "attempt_id": "attempt_b",
                "stream_id": "stream_b",
                "incarnation": "incarnation_b",
                "authority_revision": "authority_b",
            },
            "authority": dict(_AUTHORITY),
            "route": dict(_ROUTE),
        },
        "runtime_continuation_resume": _wire_resume(),
    }

    response = build_chat_send_response(
        "message_resume",
        params,
        approvals_pre_granted=False,
        brain_container=brain,
        invalid_params_code=-32602,
        stream_notifications=True,
        notification_writer=lambda _message: None,
    )

    assert response.result["status"] == "completed"
    runtime = captured["runtime"]
    assert callable(runtime.continuation_resume)
    assert runtime.request_context.runtime_continuation_resume is not None


def _resume_arguments(
    hydrated: resume.HydratedBeforeToolDispatchResume,
    request: ChatRequestContext,
    runtime: loop_runtime.LoopRuntime,
) -> dict[str, Any]:
    return {
        "hydrated": hydrated,
        "runtime": runtime,
        "kernel": SimpleNamespace(),
        "request_context": request,
        "working_messages": [{"role": "user", "content": "read the metrics"}],
        "tool_contract": SimpleNamespace(),
        "tool_payload": [],
        "tool_resolution_context": None,
        "tool_preferences": None,
        "mode_policy": policy_for_mode("assist"),
        "plan_mode": False,
        "read_only": False,
        "approvals_pre_granted": False,
        "request_id": "stream_b",
        "session_id": _SESSION_ID,
        "latest_user_content": "read the metrics",
        "reasoning_effort": None,
        "prompt_cache_enabled": False,
        "cache_source_key": "",
        "system_prompt": None,
        "cache_break_detector": None,
        "budget_tracker": None,
        "read_snapshot_cache": {},
        "tool_statuses": (),
        "initial_thinking_text": "already emitted on source attempt",
        "deferred_budget_initializer": lambda: SimpleNamespace(
            working_messages=[], budget_tracker=None, terminal_decision=None
        ),
        "request_messages_hash": "e" * 64,
    }


def test_resume_executes_saved_batch_before_generation_without_rereserving(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[object] = []
    fake_runs: list[Any] = []
    request, runtime = _fresh_request()
    original_reserve = runtime.reserve_tool_calls

    def _reserve_forbidden(_requested: int) -> int:
        raise AssertionError("restored batch must not reserve its tool budget again")

    runtime.reserve_tool_calls = _reserve_forbidden  # type: ignore[assignment]

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
            fake_runs.append(self)

        def execute(self) -> object:
            assert self.budget_tracker.restored is True
            events.append(("generate", tuple(item.call_id for item in self.outcomes)))
            return SimpleNamespace(done=True)

    def _execute(**kwargs: Any) -> None:
        restored = kwargs["restored_first_input"]
        first_call = kwargs["indexed_calls"][0][0]
        frozen = restored.bind_for_attempt(
            call=first_call,
            session_id=_SESSION_ID,
            logical_turn_id=_TURN_ID,
            execution_context=request.execution_context,
        )
        events.append(("dispatch", first_call.call_id, frozen.effective_tool_arguments))
        for call, _index in kwargs["indexed_calls"]:
            kwargs["outcomes"].append(
                ToolExecutionOutcome(
                    tool_name=call.tool_id,
                    output="x" * 20_000,
                    success=True,
                    call_id=call.call_id,
                )
            )
            kwargs["iteration_calls"].append(call)

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
    monkeypatch.setattr(resume, "execute_tool_calls_sequentially", _execute)
    monkeypatch.setattr(resume, "_finish_pending_batch", lambda *_args: None)
    arguments = _resume_arguments(_hydrated(), request, runtime)
    rejected_request, rejected_runtime = _fresh_request()
    with pytest.raises(resume.ContinuationResumeError, match="quota_state_unavailable"):
        resume.resume_before_tool_dispatch(**_resume_arguments(_hydrated(), rejected_request, rejected_runtime))
    assert not events and not fake_runs
    # Legacy bodies are readable, but executable only with discipline explicitly disabled.
    arguments["kernel"]._config = SimpleNamespace(feature_flags={"resource_discipline": False})

    def _initialize_budget() -> Any:
        assert len(fake_runs) == 1
        assert [outcome.call_id for outcome in fake_runs[0].outcomes] == [
            "call_1",
            "call_2",
        ]
        assert all(len(outcome.output) == 20_000 for outcome in fake_runs[0].outcomes)
        events.append(("budget", tuple(outcome.call_id for outcome in fake_runs[0].outcomes)))
        return SimpleNamespace(
            working_messages=arguments["working_messages"],
            budget_tracker=SimpleNamespace(restored=True),
            terminal_decision=None,
        )

    arguments["deferred_budget_initializer"] = _initialize_budget
    result = resume.resume_before_tool_dispatch(**arguments)

    assert result.done is True
    assert events == [
        ("dispatch", "call_1", {"value": 1.0}),
        ("budget", ("call_1", "call_2")),
        ("generate", ("call_1", "call_2")),
    ]
    assert runtime.tool_call_limit == 6
    assert runtime.tool_calls_consumed == 2
    assert runtime.max_iterations == 3
    assert runtime.iteration_base == 1
    runtime.reserve_tool_calls = original_reserve  # type: ignore[assignment]


def test_resume_rejects_pregranted_approval_before_pending_dispatch() -> None:
    request, runtime = _fresh_request()
    arguments = _resume_arguments(_hydrated(), request, runtime)
    arguments["approvals_pre_granted"] = True

    with pytest.raises(
        resume.ContinuationResumeError,
        match="continuation_approval_grant_forbidden",
    ):
        resume.resume_before_tool_dispatch(**arguments)


def test_current_approval_requirement_stops_whole_batch_before_dispatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run = _preflight_run(monkeypatch, _descriptor())
    result = GenerationResult(content="", tool_calls=_hydrated().tool_calls())
    monkeypatch.setattr(
        resume_batch._tool_loop.tool_loop_recovery,
        "approval_with_recovery",
        lambda _run, generated, **_kwargs: (object(), generated),
    )

    with pytest.raises(ToolExecutionFailure) as exc_info:
        resume._preflight_pending_batch(run, result)

    assert exc_info.value.to_error_data() == {"failed_phase": "current_approval_required"}


def test_later_call_schema_drift_rejects_batch_before_any_producer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    descriptor = _descriptor()
    run = _preflight_run(monkeypatch, descriptor)
    calls = list(_hydrated().tool_calls())
    calls[1] = copy.copy(calls[1])
    object.__setattr__(calls[1], "arguments", {"stale": 2})
    result = GenerationResult(content="", tool_calls=tuple(calls))

    with pytest.raises(ToolExecutionFailure) as exc_info:
        resume._preflight_pending_batch(run, result)

    assert exc_info.value.to_error_data() == {"failed_phase": "tool_schema_changed"}


def test_partial_prefilter_rejects_batch_instead_of_executing_subset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run = _preflight_run(monkeypatch, _descriptor())
    calls = _hydrated().tool_calls()
    monkeypatch.setattr(
        resume_batch,
        "pre_filter_tool_calls",
        lambda *_args, **_kwargs: ([(calls[0], 1)], 2),
    )

    with pytest.raises(ToolExecutionFailure) as exc_info:
        resume._preflight_pending_batch(run, GenerationResult(content="", tool_calls=calls))

    assert exc_info.value.to_error_data() == {"failed_phase": "tool_prefilter_changed"}


def test_decision_hydration_preserves_failed_effect_metadata_and_rejects_event_tampering():
    artifacts = _artifacts()
    checkpoint = json.loads(artifacts["checkpoint_body"])
    output = "  failed Ω\n"
    metadata = {"effects": "none", "failure_class": "validation", "failed_phase": "preflight"}
    events = [
        {
            "event_id": "stream_a:canonical:1",
            "turn_id": _TURN_ID,
            "kind": "tool_result",
            "tool_call_id": "completed_1",
            "payload": {
                "tool_name": "read_file",
                "success": False,
                "tool_output_summary": output,
                "error_code": "CMP-TOOL-0001",
                "metadata": metadata,
                "tool_input": {"path": "x"},
            },
        }
    ]
    event_bytes = _canonical(events)
    checkpoint.update(
        schema_version=3,
        kind="before_decision_wait",
        decision={
            "kind": "approval",
            "decision_id": "decision_1",
            "call_id": "call_1",
            "execution_started": False,
        },
        completed_effect_refs=[
            {
                "call_id": "completed_1",
                "tool_id": "read_file",
                "success": False,
                "result_sha256": hashlib.sha256(output.encode()).hexdigest(),
            }
        ],
        prior_effect_count=0,
        prior_checkpoint_ref=None,
    )
    checkpoint["wait"]["kind"] = "explicit_pause"
    checkpoint["wait"]["resource_class"] = None
    checkpoint["eligibility"]["prior_outcome_count"] = 1
    checkpoint["canonical_refs"]["turn_ref"]["sha256"] = hashlib.sha256(event_bytes).hexdigest()
    encoded = encode_continuation_checkpoint(checkpoint)
    artifacts.update(
        checkpoint_body=encoded.body,
        checkpoint_sha256=encoded.sha256,
        canonical_events_bytes=event_bytes,
    )
    artifacts["checkpoint_ref"].update(sha256=encoded.sha256, bytes=len(encoded.body))
    hydrated = resume.HydratedBeforeToolDispatchResume.from_artifacts(**artifacts)
    outcome = hydrated.completed_outcomes()[0]
    assert outcome.output == output
    assert outcome.success is False
    assert outcome.metadata == metadata
    assert outcome.error_code == "CMP-TOOL-0001"
    outcome.metadata["effects"] = "unknown"
    assert hydrated.completed_outcomes()[0].metadata == metadata
    events[0]["payload"]["metadata"]["effects"] = "unknown"
    artifacts["canonical_events_bytes"] = _canonical(events)
    with pytest.raises(ValueError, match="decision_canonical_events_invalid"):
        resume.HydratedBeforeToolDispatchResume.from_artifacts(**artifacts)



def _approval_bundle_artifacts():
    artifacts = _artifacts()
    first = json.loads(artifacts["frozen_input_bytes"])
    later = {**first, "call_id": "call_2", "visible_tool_arguments": {"value": 2},
             "effective_tool_arguments": {"value": 2}, "effective_args_fingerprint": stable_hash({"value": 2})}
    bundle, digest = encode_approval_inputs((artifacts["frozen_input_bytes"], _canonical(later)))
    checkpoint = json.loads(artifacts["checkpoint_body"])
    checkpoint.update(schema_version=4, kind="before_decision_wait",
        decision={"kind": "approval", "decision_id": "decision_1", "call_id": "call_1", "execution_started": False},
        completed_effect_refs=[], prior_effect_count=0, prior_checkpoint_ref=None,
        approval_inputs_ref=_ref("approval_inputs_1", digest))
    checkpoint["wait"].update(kind="explicit_pause", resource_class=None)
    checkpoint["canonical_refs"]["turn_ref"]["sha256"] = hashlib.sha256(b"[]").hexdigest()
    encoded = encode_continuation_checkpoint(checkpoint)
    artifacts.update(checkpoint_body=encoded.body, checkpoint_sha256=encoded.sha256,
                     canonical_events_bytes=b"[]", approval_inputs_bytes=base64.b64decode(bundle))
    artifacts["checkpoint_ref"].update(sha256=encoded.sha256, bytes=len(encoded.body))
    return artifacts


def test_approval_bundle_hydrates_every_input_without_altering_legacy_bytes():
    artifacts = _approval_bundle_artifacts()
    hydrated = resume.HydratedBeforeToolDispatchResume.from_artifacts(**artifacts)
    inputs = hydrated.restored_inputs()
    assert [item.source_frozen_inputs().call_id for item in inputs] == ["call_1", "call_2"]
    assert inputs[1].source_frozen_inputs().effective_tool_arguments == {"value": 2}
    inputs[1].source_frozen_inputs().effective_tool_arguments["value"] = 7
    assert hydrated.restored_inputs()[1].source_frozen_inputs().effective_tool_arguments == {"value": 2}
    assert _hydrated().checkpoint()["schema_version"] == 1


@pytest.mark.parametrize("mutation", ["missing", "reordered", "first", "digest", "scope", "call", "arguments", "extra", "mutation", "oversized"])
def test_approval_bundle_hydration_rejects_invalid_later_inputs(mutation):
    artifacts = _approval_bundle_artifacts()
    bundle = json.loads(artifacts["approval_inputs_bytes"])
    if mutation == "missing":
        bundle["inputs"].pop()
    elif mutation == "reordered":
        bundle["inputs"].reverse()
    elif mutation == "first":
        bundle["inputs"][0] = bundle["inputs"][1]
    elif mutation == "digest":
        bundle["inputs"][1]["frozen_input_sha256"] = "f" * 64
    elif mutation == "extra":
        bundle["extra"] = True
    elif mutation == "oversized":
        bundle["inputs"][1]["frozen_input_bytes"] = "x" * (2 * 1024 * 1024)
    else:
        later = json.loads(base64.b64decode(bundle["inputs"][1]["frozen_input_bytes"]))
        if mutation == "scope":
            later["execution_context_payload"]["root_revision"] += 1
        elif mutation == "call":
            later["call_id"] = "other"
        elif mutation == "arguments":
            later["visible_tool_arguments"]["value"] = 4
        else:
            later["execution_context_payload"]["_jenny_change_set_id"] = "change_1"
        body = _canonical(later)
        bundle["inputs"][1] = {"frozen_input_bytes": base64.b64encode(body).decode(),
                               "frozen_input_sha256": hashlib.sha256(body).hexdigest()}
    body = _canonical(bundle)
    checkpoint = json.loads(artifacts["checkpoint_body"])
    checkpoint["approval_inputs_ref"]["sha256"] = hashlib.sha256(body).hexdigest()
    encoded = encode_continuation_checkpoint(checkpoint)
    artifacts.update(checkpoint_body=encoded.body, checkpoint_sha256=encoded.sha256, approval_inputs_bytes=body)
    artifacts["checkpoint_ref"].update(sha256=encoded.sha256, bytes=len(encoded.body))
    with pytest.raises(ValueError):
        resume.HydratedBeforeToolDispatchResume.from_artifacts(**artifacts)


@pytest.mark.parametrize("has_context", [True, False])
def test_resume_admission_enables_continuation_when_context_present(
    monkeypatch: pytest.MonkeyPatch, has_context: bool
) -> None:
    captured: dict[str, Any] = {}

    def fake_operation_admission(**kwargs: Any) -> None:
        captured.update(kwargs)

    monkeypatch.setattr(
        admission_module, "build_operation_admission_callback", fake_operation_admission
    )
    monkeypatch.setattr(
        admission_module, "build_continuation_checkpoint_callback", lambda **_kwargs: None
    )
    monkeypatch.setattr(
        admission_module, "build_inference_admission_callback", lambda **_kwargs: None
    )
    plan = SimpleNamespace(
        request_id="req-resume-admission",
        session_id="sess-resume-admission",
        request_context=SimpleNamespace(
            continuation_context=object() if has_context else None,
            execution_context=None,
            inference_budget_required=False,
        ),
    )

    admission_module.build_resume_admission(
        plan=plan,
        engine_type="ollama",
        write_message=None,
        response_reader_factory=None,
        cancel_handle=None,
    )

    # Resume must keep continuation admission in step with the ordinary chat path:
    # a saved continuation context enables it, its absence leaves it off.
    assert captured["continuation_enabled"] is has_context
