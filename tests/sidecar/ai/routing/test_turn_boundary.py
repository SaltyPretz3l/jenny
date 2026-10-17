"""End-of-turn session-proposal boundaries: detection, batch settlement, wire, callers."""

from __future__ import annotations

import dataclasses
from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.error_codes import CMP_TOOL_APPROVAL_WINDOW_DROPPED
from sidecar.ai.routing import turn_boundary as tb
from sidecar.ai.routing.loop_events import ToolExecutingEvent, ToolResultEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ChatRouter, ToolExecutionOutcome
from sidecar.ai.routing.tool_call_execution import execute_tool_calls_sequentially
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.protocol import CHAT_DONE_METHOD
from sidecar.runtime.chat_decision_render import _chat_response_from_decision
from sidecar.runtime.chat_models import ChatRequestContext
from tests.sidecar.ai.routing.test_tool_call_execution import _call, _contract, _Kernel, _runtime

PROPOSAL_ID = "proposal_" + "ab" * 32
OFFER_METADATA = {
    "result_kind": "session_proposal",
    "proposal_id": PROPOSAL_ID,
    "turn_boundary": "awaiting_proposal",
}
HANDOFF_METADATA = {
    "result_kind": "session_handoff",
    "proposal_id": PROPOSAL_ID,
    "turn_boundary": "session_handoff_completed",
}


def _outcome(tool: str, *, success: bool = True, **metadata: Any) -> ToolExecutionOutcome:
    return ToolExecutionOutcome(
        tool_name=tool,
        output="ok",
        success=success,
        tool_input={},
        call_id=f"call-{tool}",
        metadata=dict(metadata),
    )


# --- detection ----------------------------------------------------------------------------


def test_detects_exactly_the_two_tool_boundary_pairs() -> None:
    offer = tb.detect_turn_boundary(_outcome("propose_session", **OFFER_METADATA))
    assert offer == tb.TurnBoundary("awaiting_proposal", PROPOSAL_ID)
    handoff = tb.detect_turn_boundary(_outcome("complete_session_handoff", **HANDOFF_METADATA))
    assert handoff == tb.TurnBoundary("session_handoff_completed", PROPOSAL_ID)
    assert offer.done_params() == {
        "completion_reason": "awaiting_proposal",
        "proposal_id": PROPOSAL_ID,
    }


@pytest.mark.parametrize(
    "outcome",
    [
        _outcome("propose_session", success=False, **OFFER_METADATA),
        _outcome("propose_command", **OFFER_METADATA),
        _outcome("read_file", **OFFER_METADATA),
        # a tool may only raise its own boundary value
        _outcome("propose_session", **{**HANDOFF_METADATA}),
        _outcome("complete_session_handoff", **{**OFFER_METADATA}),
        _outcome("propose_session", **{**OFFER_METADATA, "turn_boundary": "other"}),
        _outcome("propose_session", **{**OFFER_METADATA, "turn_boundary": None}),
        _outcome("propose_session", result_kind="session_proposal", proposal_id=PROPOSAL_ID),
        _outcome("propose_session", **{**OFFER_METADATA, "proposal_id": "proposal_abc"}),
        _outcome("propose_session", **{**OFFER_METADATA, "proposal_id": PROPOSAL_ID + "\n"}),
        _outcome("propose_session", **{**OFFER_METADATA, "proposal_id": PROPOSAL_ID.upper()}),
        _outcome("propose_session", **{**OFFER_METADATA, "proposal_id": 7}),
        _outcome("propose_session", turn_boundary="awaiting_proposal"),
    ],
)
def test_everything_else_is_not_a_boundary(outcome: ToolExecutionOutcome) -> None:
    assert tb.detect_turn_boundary(outcome) is None


def test_a_non_dict_metadata_is_not_a_boundary() -> None:
    outcome = SimpleNamespace(tool_name="propose_session", success=True, metadata="x")
    assert tb.detect_turn_boundary(outcome) is None


# --- the batch executor -------------------------------------------------------------------


class _BoundaryKernel(_Kernel):
    """Kernel whose boundary tools return the given metadata; everything else is ordinary."""

    def __init__(
        self, metadata_by_tool: dict[str, dict[str, Any]], failing: frozenset[str] = frozenset()
    ) -> None:
        super().__init__()
        self.metadata_by_tool = metadata_by_tool
        self.failing = failing

    def _execute_tool(self, call: ToolCallRequest, **_kwargs: Any) -> ToolExecutionOutcome:
        self.executed.append(call.tool_id)
        return ToolExecutionOutcome(
            tool_name=call.tool_id,
            output=f"result:{call.tool_id}",
            success=call.tool_id not in self.failing,
            tool_input=dict(call.arguments),
            call_id=call.call_id,
            metadata=dict(self.metadata_by_tool.get(call.tool_id, {})),
        )


def _run(
    kernel: _Kernel, tool_ids: list[str], *, streaming: bool = True
) -> tuple[Any, list[ToolExecutionOutcome], list[Any], list[Any], list[dict[str, object]], set[str]]:
    runtime, events = _runtime(streaming=streaming)
    calls = [_call(tool_id) for tool_id in tool_ids]
    outcomes: list[ToolExecutionOutcome] = []
    iteration_calls: list[Any] = []
    messages: list[dict[str, object]] = []
    streamed: set[str] = set()
    boundary = execute_tool_calls_sequentially(
        indexed_calls=[(call, index + 1) for index, call in enumerate(calls)],
        runtime=runtime,
        kernel=kernel,
        result=SimpleNamespace(),
        request_id="req-1",
        session_id="session-1",
        tool_resolution_context=None,
        read_snapshot_cache={},
        outcomes=outcomes,
        working_messages=messages,
        iteration_calls=iteration_calls,
        streamed_event_types=streamed,
        tool_payload_ref=[],
        tool_contract=_contract({}),
    )
    return boundary, outcomes, iteration_calls, events, messages, streamed


def test_a_batch_without_a_boundary_returns_none_and_runs_everything() -> None:
    boundary, outcomes, *_rest = _run(_Kernel(), ["read_file", "glob_files"])
    assert boundary is None
    assert [o.success for o in outcomes] == [True, True]


def test_the_boundary_keeps_earlier_calls_and_settles_the_unstarted_suffix() -> None:
    kernel = _BoundaryKernel({"propose_session": OFFER_METADATA})
    boundary, outcomes, iteration_calls, events, messages, streamed = _run(
        kernel, ["read_file", "propose_session", "glob_files", "write_file"]
    )

    assert boundary == tb.TurnBoundary("awaiting_proposal", PROPOSAL_ID)
    assert kernel.executed == ["read_file", "propose_session"]  # later calls never dispatch
    assert [o.tool_name for o in outcomes] == [
        "read_file", "propose_session", "glob_files", "write_file",
    ]
    assert [o.success for o in outcomes] == [True, True, False, False]
    for dropped in outcomes[2:]:
        assert dropped.error_code == CMP_TOOL_APPROVAL_WINDOW_DROPPED
        assert dropped.metadata["turn_boundary_not_executed"] is True
        assert dropped.metadata["reason"] == "awaiting_proposal"
        assert "not executed" in dropped.output
        assert "waiting for the user's choice" in dropped.output
    # every call owns an executing + result pair, in order, so nothing is orphaned
    assert [type(e) for e in events] == [ToolExecutingEvent, ToolResultEvent] * 4
    assert [e.call_id for e in events if isinstance(e, ToolResultEvent)] == [
        c.call_id for c in iteration_calls
    ]
    assert len(iteration_calls) == 4 and len(messages) == 8
    assert {"tool.executing", "tool.result"} <= streamed


def test_a_boundary_on_the_last_call_has_nothing_to_settle() -> None:
    kernel = _BoundaryKernel({"propose_session": OFFER_METADATA})
    boundary, outcomes, *_rest = _run(kernel, ["read_file", "propose_session"])
    assert boundary is not None and len(outcomes) == 2 and all(o.success for o in outcomes)


def test_the_first_boundary_wins() -> None:
    kernel = _BoundaryKernel(
        {"propose_session": OFFER_METADATA, "complete_session_handoff": HANDOFF_METADATA}
    )
    boundary, outcomes, *_rest = _run(kernel, ["propose_session", "complete_session_handoff"])
    assert boundary is not None and boundary.completion_reason == "awaiting_proposal"
    assert kernel.executed == ["propose_session"]
    assert outcomes[1].metadata["turn_boundary_not_executed"] is True


def test_the_handoff_boundary_stops_the_batch_too() -> None:
    kernel = _BoundaryKernel({"complete_session_handoff": HANDOFF_METADATA})
    boundary, outcomes, *_rest = _run(kernel, ["complete_session_handoff", "read_file"])
    assert boundary == tb.TurnBoundary("session_handoff_completed", PROPOSAL_ID)
    assert "handoff that is already complete" in outcomes[1].output


def test_a_failed_proposal_does_not_end_the_turn() -> None:
    # A failed propose_session carrying the boundary metadata still leaves the batch running.
    kernel = _BoundaryKernel({"propose_session": OFFER_METADATA}, failing=frozenset({"propose_session"}))
    boundary, outcomes, *_rest = _run(kernel, ["propose_session", "read_file"])
    assert boundary is None
    assert kernel.executed == ["propose_session", "read_file"]
    assert outcomes[1].success is True


def test_a_boundary_value_the_tool_may_not_raise_does_not_end_the_turn() -> None:
    kernel = _BoundaryKernel({"propose_session": HANDOFF_METADATA})
    boundary, outcomes, *_rest = _run(kernel, ["propose_session", "read_file"])
    assert boundary is None and len(kernel.executed) == 2


# --- the model loop -----------------------------------------------------------------------


class _Engine:
    def __init__(self, results: list[GenerationResult]) -> None:
        self.results = list(results)
        self.calls = 0

    def generate_with_tools(self, **_kwargs: Any) -> GenerationResult:
        self.calls += 1
        return self.results.pop(0)

    def get_model_max_output_tokens(self) -> int | None:
        return None

    def get_model_context_length(self) -> int | None:
        return None

    supports_tool_calling = True


class _MCP:
    available_tools: list[Any] = []

    def tool_descriptor(self, _name: str) -> None:
        return None


def _router(tmp_path: Any, engine: _Engine, metadata_by_tool: dict[str, dict[str, Any]]) -> Any:
    config = replace(
        RuntimeConfig(
            engine_type="ollama",
            model="qwen",
            tools_workspace_root=str(tmp_path),
            electron_tool_bridge_enabled=True,
        ),
        mode="assist",
    )
    router = ChatRouter(
        config=config, engine=engine, mcp_client=_MCP(), context_builder=ContextBuilder(None)
    )
    router.set_harness_snapshot_provider(lambda **_kwargs: {"tools": {"items": []}})
    executed: list[str] = []

    def _fake_execute(call: ToolCallRequest, **_kwargs: Any) -> ToolExecutionOutcome:
        executed.append(call.tool_id)
        return ToolExecutionOutcome(
            tool_name=call.tool_id,
            output="ok",
            success=True,
            tool_input=dict(call.arguments),
            call_id=call.call_id,
            metadata=dict(metadata_by_tool.get(call.tool_id, {})),
        )

    router._execute_tool = _fake_execute  # type: ignore[method-assign]
    router.executed = executed  # type: ignore[attr-defined]
    return router


def _decide(router: Any, **kwargs: Any) -> Any:
    return router.build_chat_decision(
        request_id="req_boundary",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="assist",
        approvals_pre_granted=False,
        runtime=LoopRuntime(request_id="req_boundary", max_iterations=4),
        **kwargs,
    )


def _offer_calls() -> tuple[ToolCallRequest, ...]:
    args = {"schema_version": 1, "initiation": "offer", "title": "t"}
    return (
        ToolCallRequest("propose_session", dict(args), "c1"),
        ToolCallRequest("propose_session", dict(args), "c2"),
    )


def test_the_loop_stops_without_another_generation_and_keeps_the_preamble(tmp_path: Any) -> None:
    engine = _Engine(
        [
            GenerationResult(content="Offering a choice.", tool_calls=_offer_calls()),
            GenerationResult(content="MUST NOT BE GENERATED"),
        ]
    )
    router = _router(tmp_path, engine, {"propose_session": OFFER_METADATA})

    decision = _decide(router)

    assert engine.calls == 1
    assert router.executed == ["propose_session"]
    assert decision.turn_boundary == tb.TurnBoundary("awaiting_proposal", PROPOSAL_ID)
    assert decision.response_text == "Offering a choice."
    assert decision.resumable_stop is None
    assert [o.success for o in decision.tool_results] == [True, False]


def test_a_turn_may_end_at_the_boundary_with_no_visible_text(tmp_path: Any) -> None:
    engine = _Engine([GenerationResult(content="", tool_calls=_offer_calls()[:1])])
    router = _router(tmp_path, engine, {"propose_session": OFFER_METADATA})

    decision = _decide(router)

    assert decision.turn_boundary is not None and decision.response_text == ""


def test_a_proposal_without_the_boundary_metadata_lets_the_model_continue(tmp_path: Any) -> None:
    engine = _Engine(
        [
            GenerationResult(content="", tool_calls=_offer_calls()[:1]),
            GenerationResult(content="Carrying on in this chat."),
        ]
    )
    router = _router(tmp_path, engine, {"propose_session": {"result_kind": "session_proposal"}})

    decision = _decide(router)

    assert engine.calls == 2
    assert decision.turn_boundary is None
    assert decision.response_text == "Carrying on in this chat."


# --- chat.done ----------------------------------------------------------------------------


def _render(decision: Any) -> dict[str, Any]:
    brain = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                background_runtime_root=None,
                engine_type="ollama",
                feature_flags={},
                max_inline_payload_bytes=65_536,
                model="qwen",
            ),
            engine=_Engine([]),
            tool_observations=None,
            turn_diagnostics=None,
        )
    )
    response = _chat_response_from_decision(
        request_context=ChatRequestContext(
            request_id="req_boundary_render",
            trace_id=None,
            session_id=None,
            mode="chat",
            approvals_pre_granted=False,
        ),
        latest_user_content="hello",
        canonical_session_messages=[],
        session_title="",
        brain_container=brain,
        decision=decision,
    )
    return next(n for n in response.notifications if n.get("method") == CHAT_DONE_METHOD)


def _decision(tmp_path: Any, content: str, metadata: dict[str, Any]) -> Any:
    engine = _Engine([GenerationResult(content=content, tool_calls=_offer_calls()[:1])])
    return _decide(_router(tmp_path, engine, {"propose_session": metadata}))


def test_chat_done_carries_both_completion_fields_and_no_synthetic_text(tmp_path: Any) -> None:
    done = _render(_decision(tmp_path, "", OFFER_METADATA))["params"]

    assert done["completion_reason"] == "awaiting_proposal"
    assert done["proposal_id"] == PROPOSAL_ID
    assert done["response_text"] == ""  # no "tool work" fallback sentence
    assert done["completion_source"] == "model"
    assert done["stop_reason"] == "end_turn"
    assert "resumable_stop" not in done


def test_chat_done_keeps_the_visible_preamble(tmp_path: Any) -> None:
    done = _render(_decision(tmp_path, "Here is a choice.", OFFER_METADATA))["params"]
    assert done["response_text"] == "Here is a choice."
    assert done["completion_reason"] == "awaiting_proposal"


def test_an_ordinary_empty_turn_still_gets_the_fallback_and_no_completion_fields(
    tmp_path: Any,
) -> None:
    engine = _Engine(
        [
            GenerationResult(content="", tool_calls=_offer_calls()[:1]),
            GenerationResult(content="", finish_reason="stop"),
        ]
    )
    decision = _decide(_router(tmp_path, engine, {"propose_session": {"result_kind": "x"}}))
    done = _render(dataclasses.replace(decision, response_text=""))["params"]
    assert done["response_text"].strip() != ""
    assert done["completion_source"] == "deterministic_tool_fallback"
    assert "completion_reason" not in done and "proposal_id" not in done


def test_a_non_boundary_object_on_the_decision_is_ignored() -> None:
    decision = SimpleNamespace(turn_boundary="awaiting_proposal")
    assert not isinstance(getattr(decision, "turn_boundary", None), tb.TurnBoundary)


# --- the other callers --------------------------------------------------------------------


def test_the_approval_resume_ends_the_turn_at_a_boundary_without_generating(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sidecar.ai import feature_flags as _feature_flags
    from sidecar.ai.routing import tool_call_execution as _tce
    from sidecar.ai.routing import tool_loop as _tool_loop
    from sidecar.runtime.chat import resume_chat_send_response_from_approval_plan
    from tests.sidecar.ai.routing.test_replay_blanket_approval import (
        ToolPolicySnapshot,
        _build_replay_router,
        _read_then_write_file_script,
    )

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
        request_id="req-resume-boundary",
        messages=messages,
        latest_user_content=prompt,
        mode="assist",
        approvals_pre_granted=False,
    )
    assert decision.approval_plan is not None
    resume_config = dataclasses.replace(
        router._config,  # harness config injection
        feature_flags={
            **(router._config.feature_flags or {}),
            _feature_flags.FEATURE_CANONICAL_TURN_EVENTS: True,
        },
    )
    brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=resume_config,
            engine=router._engine,
            router=router,
            tool_observations=None,
        ),
        subprocess_manager=None,
    )

    def _boundary_executor(**_kwargs: Any) -> tb.TurnBoundary:
        return tb.TurnBoundary("awaiting_proposal", PROPOSAL_ID)

    def _no_generation(**_kwargs: Any) -> Any:
        raise AssertionError("a boundary must not start another generation")

    monkeypatch.setattr(_tce, "execute_tool_calls_sequentially", _boundary_executor)
    monkeypatch.setattr(_tool_loop, "run_tool_loop", _no_generation)
    from sidecar.ai.routing import mutation_run_settlement as _settlement

    settled: list[tuple[Any, str]] = []
    monkeypatch.setattr(
        _settlement, "settle_run_change_set",
        lambda run, *, reason: settled.append((run, reason)),
    )

    response = resume_chat_send_response_from_approval_plan(
        decision.approval_plan,
        brain_container=brain_container,
        live_params={"messages": messages},
        canonical_session_messages=[],
        stream_notifications=False,
    )

    done = next(n for n in response.notifications if n.get("method") == CHAT_DONE_METHOD)
    assert done["params"]["completion_reason"] == "awaiting_proposal"
    assert done["params"]["proposal_id"] == PROPOSAL_ID
    assert done["params"]["response_text"] == ""
    # The skipped run_tool_loop normally settles the change set; the boundary branch must.
    assert [reason for _run, reason in settled] == ["turn_boundary"]
    assert settled[0][0].session_id == decision.approval_plan.session_id
