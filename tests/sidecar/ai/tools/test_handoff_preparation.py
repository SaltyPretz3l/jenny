"""Handoff-only preparation turn: field validation, tool contract, generation budget."""

from __future__ import annotations

import dataclasses
from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.error_codes import CMP_LOOP_MAX_ITERATIONS
from sidecar.ai.routing import tool_resolution
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ChatRouter, ToolExecutionOutcome
from sidecar.ai.routing.tool_call_execution import pre_filter_tool_calls
from sidecar.ai.tools import handoff_preparation as hp
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.runtime.chat import ChatRequestError, build_chat_send_response
from sidecar.runtime.chat_models import ChatRequestContext

PROPOSAL_ID = "proposal_" + "cd" * 32
ATTEMPT_ID = "0b9f2f5e-6f4c-4a3e-9d2a-1c2b3c4d5e6f"
FIELD = {"proposal_id": PROPOSAL_ID, "attempt_id": ATTEMPT_ID}
HANDOFF_ARGS = {"schema_version": 1, "proposal_id": PROPOSAL_ID, "body": "background"}


# --- the trusted field --------------------------------------------------------------------


def test_the_field_parses_to_a_frozen_value() -> None:
    parsed = hp.handoff_preparation_from_params({"handoff_preparation": dict(FIELD)})
    assert parsed == hp.HandoffPreparation(PROPOSAL_ID, ATTEMPT_ID)


@pytest.mark.parametrize("params", [{}, {"handoff_preparation": None}, None, "x", []])
def test_an_absent_field_is_an_ordinary_turn(params: Any) -> None:
    assert hp.handoff_preparation_from_params(params) is None


@pytest.mark.parametrize(
    "value",
    [
        "yes",
        True,
        7,
        [],
        {},
        {"proposal_id": PROPOSAL_ID},
        {"attempt_id": ATTEMPT_ID},
        {**FIELD, "extra": 1},
        {**FIELD, "proposal_id": "proposal_abc"},
        {**FIELD, "proposal_id": PROPOSAL_ID + "\n"},
        {**FIELD, "proposal_id": PROPOSAL_ID.upper()},
        {**FIELD, "proposal_id": 4},
        {**FIELD, "attempt_id": "not-a-uuid"},
        {**FIELD, "attempt_id": ATTEMPT_ID.upper()},
        {**FIELD, "attempt_id": ATTEMPT_ID + "\n"},
        {**FIELD, "attempt_id": None},
    ],
)
def test_a_malformed_field_is_rejected(value: Any) -> None:
    with pytest.raises(ValueError, match="handoff_preparation"):
        hp.handoff_preparation_from_params({"handoff_preparation": value})


def test_chat_send_turns_a_malformed_field_into_invalid_params() -> None:
    with pytest.raises(ChatRequestError) as caught:
        build_chat_send_response(
            "msg-bad-prep",
            {
                "request_id": "req-bad-prep",
                "mode": "assist",
                "messages": [{"role": "user", "content": "hi"}],
                "handoff_preparation": {"proposal_id": "nope", "attempt_id": ATTEMPT_ID},
            },
            approvals_pre_granted=True,
            brain_container=SimpleNamespace(stack=SimpleNamespace(config=SimpleNamespace())),
            invalid_params_code=-32602,
        )
    assert "handoff_preparation" in str(caught.value)
    assert caught.value.rpc_code == -32602


# --- the tool contract ---------------------------------------------------------------------


class _MCP:
    available_tools: list[object] = []

    def tool_descriptor(self, _name: str) -> None:
        return None


def _kernel(workspace_root: str) -> SimpleNamespace:
    return SimpleNamespace(
        _config=RuntimeConfig(
            electron_tool_bridge_enabled=True,
            tools_workspace_root=workspace_root,
            mode="assist",
        ),
        _mcp_client=_MCP(),
        _engine=SimpleNamespace(supports_tool_calling=True),
        _active_cancel_handle=None,
    )


def _context(**overrides: Any) -> ChatRequestContext:
    base: dict[str, Any] = {
        "request_id": "req_prep",
        "trace_id": "trace_prep",
        "session_id": "session_prep",
        "mode": "assist",
        "approvals_pre_granted": True,
        "workspace_root_present": True,
    }
    base.update(overrides)
    return ChatRequestContext(**base)


def _preparing(**overrides: Any) -> ChatRequestContext:
    return _context(
        handoff_preparation=hp.HandoffPreparation(PROPOSAL_ID, ATTEMPT_ID), **overrides
    )


_ENABLE_HANDOFF = {
    "enabled_tools": ("complete_session_handoff",),
    "disabled_tools": (),
    "disabled_tool_families": (),
}


def _names(kernel: Any, context: ChatRequestContext) -> set[str]:
    payload = tool_resolution.build_tool_payload(kernel, None, request_context=context)
    return {str(schema["name"]) for schema in payload}


def test_without_the_field_the_handoff_tool_is_never_offered(tmp_path: Any) -> None:
    names = _names(_kernel(str(tmp_path)), _context())
    assert "complete_session_handoff" not in names
    assert "propose_session" in names  # the ordinary proposal tool stays


def test_an_enabled_tools_preference_cannot_unlock_the_handoff_tool(tmp_path: Any) -> None:
    context = _context(tool_preferences=_ENABLE_HANDOFF)
    assert "complete_session_handoff" not in _names(_kernel(str(tmp_path)), context)


def test_a_preparation_turn_offers_exactly_the_handoff_tool(tmp_path: Any) -> None:
    assert _names(_kernel(str(tmp_path)), _preparing()) == {"complete_session_handoff"}


def test_the_exact_electron_request_shape_offers_only_the_handoff_tool(tmp_path: Any) -> None:
    # Electron sends BOTH the field and tool_preferences.enabled_tools.
    context = _preparing(tool_preferences=_ENABLE_HANDOFF)
    assert _names(_kernel(str(tmp_path)), context) == {"complete_session_handoff"}


def test_a_preparation_turn_offers_no_tool_search_or_deferred_discovery(tmp_path: Any) -> None:
    contract = tool_resolution.assemble_tool_contract(
        _kernel(str(tmp_path)), request_context=_preparing()
    )
    offered = {entry.descriptor.name for entry in contract.entries if entry.available}
    assert offered == {"complete_session_handoff"}
    assert all(not entry.deferred for entry in contract.entries)
    refused = [e for e in contract.entries if e.descriptor.name != "complete_session_handoff"]
    assert refused and all(e.reason == hp.PREPARATION_ONLY_REASON for e in refused)


def test_without_the_field_the_contract_marks_the_tool_unavailable(tmp_path: Any) -> None:
    contract = tool_resolution.assemble_tool_contract(
        _kernel(str(tmp_path)), request_context=_context()
    )
    entry = contract.entry("complete_session_handoff")
    assert entry is not None and entry.available is False
    assert entry.reason == hp.PREPARATION_REQUIRED_REASON


def test_no_request_context_applies_no_restriction(tmp_path: Any) -> None:
    contract = tool_resolution.assemble_tool_contract(_kernel(str(tmp_path)))
    assert contract.entries  # assembly with no context still works unrestricted


def test_a_sub_agent_is_never_offered_a_boundary_tool() -> None:
    @dataclasses.dataclass(frozen=True)
    class _Entry:
        descriptor: Any
        available: bool
        deferred: bool = False
        prompt_schema: Any = None
        reason: str | None = None

    @dataclasses.dataclass(frozen=True)
    class _Contract:
        entries: tuple

    names = ("propose_session", "complete_session_handoff", "read_file")
    contract = _Contract(entries=tuple(_Entry(SimpleNamespace(name=name), True) for name in names))
    child = SimpleNamespace(agent_surface="sub_agent", handoff_preparation=None)
    restricted = {e.descriptor.name: e for e in hp.apply_handoff_preparation(contract, child).entries}
    assert restricted["propose_session"].available is False
    assert restricted["propose_session"].reason == hp.SUB_AGENT_REASON
    assert restricted["complete_session_handoff"].available is False
    assert restricted["read_file"].available is True
    main = SimpleNamespace(agent_surface="main", handoff_preparation=None)
    restricted = {e.descriptor.name: e for e in hp.apply_handoff_preparation(contract, main).entries}
    assert restricted["propose_session"].available is True


def test_session_message_is_offered_only_with_the_latched_grant_and_a_bound_chat() -> None:
    @dataclasses.dataclass(frozen=True)
    class _Entry:
        descriptor: Any
        available: bool
        deferred: bool = False
        prompt_schema: Any = None
        reason: str | None = None

    @dataclasses.dataclass(frozen=True)
    class _Contract:
        entries: tuple

    contract = _Contract(entries=(_Entry(SimpleNamespace(name="session_message"), True),))

    def offered(**fields: Any) -> _Entry:
        context = SimpleNamespace(**{
            "agent_surface": "main", "handoff_preparation": None,
            "session_messages_enabled": True, "session_id": "sess_a", **fields,
        })
        return hp.apply_handoff_preparation(contract, context).entries[0]

    assert offered().available is True
    for fields in ({"session_messages_enabled": False}, {"session_id": None}, {"agent_surface": "sub_agent"}):
        entry = offered(**fields)
        assert entry.available is False, fields
        assert entry.reason == hp.SESSION_MESSAGE_UNAVAILABLE_REASON
        assert entry.prompt_schema is None
    preparing = offered(handoff_preparation=hp.HandoffPreparation(proposal_id="proposal_" + "0" * 64, attempt_id="0" * 8 + "-0000-0000-0000-" + "0" * 12))
    assert preparing.available is False and preparing.reason == hp.PREPARATION_ONLY_REASON


# --- dispatch refusal -----------------------------------------------------------------------


def _prefilter(tmp_path: Any, context: ChatRequestContext, tool_id: str) -> tuple[list, list]:
    kernel = _kernel(str(tmp_path))
    kernel._assert_valid_tool_call = lambda _call: None
    kernel._assistant_tool_call_message = lambda _r, call: {"role": "assistant", "t": call.tool_id}
    kernel._tool_result_message = lambda call, _o: {"role": "tool", "t": call.tool_id}
    contract = tool_resolution.assemble_tool_contract(kernel, request_context=context)
    runtime = LoopRuntime(request_id="req_prep", session_id="session_prep", request_context=context)
    outcomes: list[ToolExecutionOutcome] = []
    remaining, _ = pre_filter_tool_calls(
        [ToolCallRequest(tool_id, dict(HANDOFF_ARGS), "call-1")],
        kernel=kernel,
        runtime=runtime,
        result=SimpleNamespace(),
        request_id="req_prep",
        session_id="session_prep",
        tool_resolution_context=None,
        tool_contract=contract,
        outcomes=outcomes,
        working_messages=[],
        iteration_calls=[],
        streamed_event_types=set(),
        outcome_index=0,
    )
    return remaining, outcomes


def test_the_handoff_tool_is_refused_before_dispatch_without_the_field(tmp_path: Any) -> None:
    remaining, outcomes = _prefilter(tmp_path, _context(), "complete_session_handoff")
    assert remaining == []
    assert len(outcomes) == 1 and outcomes[0].success is False


def test_another_tool_is_refused_before_dispatch_in_a_preparation_turn(tmp_path: Any) -> None:
    remaining, outcomes = _prefilter(tmp_path, _preparing(), "read_file")
    assert remaining == []
    assert len(outcomes) == 1 and outcomes[0].success is False


@pytest.mark.parametrize("tool_id", ["tool_search", "some_bare_mcp_tool"])
def test_tool_search_and_names_without_an_entry_are_refused_in_a_preparation_turn(
    tmp_path: Any, tool_id: str
) -> None:
    remaining, outcomes = _prefilter(tmp_path, _preparing(), tool_id)
    assert remaining == []
    assert len(outcomes) == 1 and outcomes[0].success is False
    assert "only complete_session_handoff" in outcomes[0].output or tool_id in outcomes[0].output


def test_dispatch_never_falls_back_to_an_mcp_descriptor_in_a_preparation_turn(tmp_path: Any) -> None:
    from sidecar.ai.routing.tool_execution import execute_tool

    kernel = _kernel(str(tmp_path))

    class _BareMCP(_MCP):
        def tool_descriptor(self, _name: str) -> None:
            raise AssertionError("a preparation turn must not resolve an MCP descriptor")

    kernel._mcp_client = _BareMCP()
    context = _preparing()
    runtime = LoopRuntime(request_id="req_prep", session_id="session_prep", request_context=context)
    outcome = execute_tool(
        kernel,
        ToolCallRequest("foo", {}, "call-1"),
        request_id="req_prep",
        session_id="session_prep",
        read_snapshot_cache={},
        tool_contract=tool_resolution.assemble_tool_contract(kernel, request_context=context),
        runtime=runtime,
    )
    assert outcome.success is False
    assert outcome.tool_name == "foo"


def test_the_handoff_tool_passes_the_filter_in_a_preparation_turn(tmp_path: Any) -> None:
    remaining, outcomes = _prefilter(tmp_path, _preparing(), "complete_session_handoff")
    assert [call.tool_id for call, _index in remaining] == ["complete_session_handoff"]
    assert outcomes == []


# --- the generation budget ------------------------------------------------------------------


def test_charge_counts_two_generations_and_refuses_the_third() -> None:
    runtime = LoopRuntime(request_id="r", request_context=_preparing())
    hp.charge_preparation_generation(runtime)
    hp.charge_preparation_generation(runtime)
    with pytest.raises(ToolExecutionFailure) as caught:
        hp.charge_preparation_generation(runtime)
    assert caught.value.code == CMP_LOOP_MAX_ITERATIONS
    assert caught.value.retryable is False


def test_an_ordinary_turn_is_never_charged() -> None:
    runtime = LoopRuntime(request_id="r", request_context=_context())
    for _ in range(10):
        hp.charge_preparation_generation(runtime)
    assert not hasattr(runtime, "handoff_preparation_generations")


class _Engine:
    supports_tool_calling = True

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


def _router(tmp_path: Any, engine: _Engine) -> ChatRouter:
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
    return router


def _decide(router: ChatRouter, context: ChatRequestContext) -> Any:
    return router.build_chat_decision(
        request_context=context,
        request_id="req_prep",
        messages=[{"role": "user", "content": "prepare"}],
        latest_user_content="prepare",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(request_id="req_prep", max_iterations=8, request_context=context),
    )


def _wrong_call(index: int) -> GenerationResult:
    return GenerationResult(
        content="", tool_calls=(ToolCallRequest("read_file", {"path": "a.txt"}, f"c{index}"),)
    )


def test_a_turn_that_never_completes_stops_after_two_generations(tmp_path: Any) -> None:
    engine = _Engine([_wrong_call(i) for i in range(4)])

    with pytest.raises(ToolExecutionFailure) as caught:
        _decide(_router(tmp_path, engine), _preparing())

    assert caught.value.code == CMP_LOOP_MAX_ITERATIONS
    assert engine.calls == 2


def test_a_correction_after_a_refused_tool_gets_its_second_generation(tmp_path: Any) -> None:
    engine = _Engine([_wrong_call(0), GenerationResult(content="done")])

    decision = _decide(_router(tmp_path, engine), _preparing())

    assert engine.calls == 2
    assert decision.response_text == "done"
