"""Turn-survival contract tests for sidecar.ai.routing.tool_loop_recovery.

Pre-dispatch tool blocks (shell disabled, mode gates, security classifier)
must become failed outcomes the model can react to — never a raised
ToolExecutionFailure that kills the turn with a chat.error.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pytest  # noqa: E402
from test_tool_loop import (  # noqa: E402 — shared loop harness.
    _build_router,
    _mermaid_descriptor,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)

from sidecar.ai.error_codes import (  # noqa: E402
    CMP_LOOP_INVALID_TOOL_CALL,
    CMP_LOOP_TOOL_INTERRUPTED,
    CMP_MODE_TOOL_BLOCKED,
    CMP_TOOL_DISABLED,
)
from sidecar.ai.mcp.models import MCPToolDescriptor  # noqa: E402
from sidecar.ai.routing import tool_loop_recovery  # noqa: E402,F401 — coverage map.
from sidecar.ai.routing.loop_events import (  # noqa: E402
    ThinkingEvent,
    ToolExecutingEvent,
    ToolResultEvent,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime  # noqa: E402
from sidecar.ai.routing.tool_call_canonicalization import (  # noqa: E402
    canonicalize_tool_calls,
)
from sidecar.ai.tools.models import (  # noqa: E402
    GenerationResult,
    ToolCallRequest,
)
from sidecar.protocol import CHAT_THINKING_KIND_STATUS  # noqa: E402
from sidecar.runtime.chat_models import TerminalChatStateError  # noqa: E402
from sidecar.runtime.multiplexer import TurnCancellationHandle  # noqa: E402


def _read_file_descriptor() -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name="read_file",
        description="Read a file",
        input_schema={"type": "object"},
        side_effecting=False,
        server_name="tools",
    )


def _tool_plan(*calls: ToolCallRequest) -> _ToolPlan:
    return _ToolPlan(
        result=GenerationResult(
            content="",
            finish_reason="tool_calls",
            tool_calls=tuple(calls),
        )
    )


def test_blocked_shell_call_recovers_and_siblings_execute() -> None:
    """A pre-dispatch block (shell disabled) fails one call, not the turn."""
    engine = _ToolLoopEngine(
        plans=[
            _tool_plan(
                ToolCallRequest(
                    tool_id="run_command",
                    arguments={"command": "echo hello"},
                    call_id="call_shell_blocked",
                ),
                ToolCallRequest(
                    tool_id="mermaid_generate",
                    arguments={"prompt": "flowchart TD\n  a --> b"},
                    call_id="call_mermaid_ok",
                ),
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="The diagram is ready; the shell is unavailable.",
                    finish_reason="stop",
                )
            ),
        ]
    )
    mcp_client = _StubMCPClient((_mermaid_descriptor(),))
    router = _build_router(
        engine=engine,
        mcp_client=mcp_client,
        tools_mermaid_enabled=True,
    )
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_shell_blocked_recovers",
        messages=[{"role": "user", "content": "Run a command and diagram it."}],
        latest_user_content="Run a command and diagram it.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_shell_blocked_recovers",
            max_iterations=3,
            streaming=True,
        ),
    )

    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    blocked = [event for event in result_events if event.error_code == CMP_TOOL_DISABLED]
    succeeded = [event for event in result_events if event.success]
    assert len(blocked) == 1, "shell call must surface as a failed outcome"
    assert len(succeeded) == 1, "sibling mermaid call must still execute"
    assert mcp_client.executions and mcp_client.executions[0][0] == "mermaid_generate"
    # The model saw the failure and produced a normal final response.
    assert decision.response_text == "The diagram is ready; the shell is unavailable."


def test_chat_mode_tool_calls_recover_to_graceful_final_response() -> None:
    """Tool calls in a mode that disallows tools end in text, not chat.error."""
    engine = _ToolLoopEngine(
        plans=[
            _tool_plan(
                ToolCallRequest(
                    tool_id="mermaid_generate",
                    arguments={"prompt": "flowchart TD\n  a --> b"},
                    call_id="call_mode_blocked",
                ),
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="I cannot use tools in this mode, but here is the idea.",
                    finish_reason="stop",
                )
            ),
        ]
    )
    router = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient((_mermaid_descriptor(),)),
        tools_mermaid_enabled=True,
    )
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_chat_mode_recovers",
        messages=[{"role": "user", "content": "Diagram this."}],
        latest_user_content="Diagram this.",
        mode="chat",
        approvals_pre_granted=False,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_chat_mode_recovers",
            max_iterations=3,
            streaming=True,
        ),
    )

    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    assert len(result_events) == 1
    assert result_events[0].error_code == CMP_MODE_TOOL_BLOCKED
    assert result_events[0].success is False
    assert (
        decision.response_text
        == "I cannot use tools in this mode, but here is the idea."
    )


def test_emit_degradation_status_emits_status_thinking_event() -> None:
    """The shared degradation helper emits a user-visible status line."""

    class _FakeRuntime:
        streaming = True

        def __init__(self) -> None:
            self.events: list[object] = []

        def emit(self, event: object) -> None:
            self.events.append(event)

    class _FakeLoop:
        runtime = _FakeRuntime()
        request_id = "req_degraded_status"
        session_id = "sess_degraded_status"
        streamed_event_types: set[str] = set()

    loop = _FakeLoop()
    tool_loop_recovery.emit_degradation_status(
        loop,
        text="Native tool calling unavailable; using text fallback.",
        event="ai.router.tool_transport_degraded",
        data={"iteration": 1},
    )

    assert len(loop.runtime.events) == 1
    event = loop.runtime.events[0]
    assert isinstance(event, ThinkingEvent)
    assert event.kind == CHAT_THINKING_KIND_STATUS
    assert event.thinking_id == "status_degraded_req_degraded_status"
    assert event.delta == "Native tool calling unavailable; using text fallback."
    assert event.persist is False
    assert "chat.thinking" in loop.streamed_event_types


def test_degraded_tool_transport_surfaces_status_once() -> None:
    """A per-request native-tool fallback shows the user one status line."""
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Here is the answer without native tools.",
                    finish_reason="stop",
                    degraded_tool_transport=True,
                )
            ),
        ]
    )
    router = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient((_mermaid_descriptor(),)),
        tools_mermaid_enabled=True,
    )
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_transport_degraded",
        messages=[{"role": "user", "content": "Hello."}],
        latest_user_content="Hello.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_transport_degraded",
            max_iterations=3,
            streaming=True,
        ),
    )

    status_events = [
        event
        for event in events
        if isinstance(event, ThinkingEvent)
        and event.kind == CHAT_THINKING_KIND_STATUS
        and event.thinking_id == "status_degraded_req_transport_degraded"
    ]
    assert len(status_events) == 1
    assert "falling back to text-only output" in status_events[0].delta
    assert decision.response_text == "Here is the answer without native tools."


# ── F6: turn-scoped tool-call id namespace ───────────────────────────────────


def test_turn_scoped_namespace_de_collides_id_less_calls_across_batches() -> None:
    """Two batches of id-less calls at the same ordinal get DISTINCT ids."""
    turn_call_ids: set[str] = set()
    first, _first_aliases, _first_coalesced = canonicalize_tool_calls(
        (ToolCallRequest(tool_id="read_file", arguments={"path": "a.txt"}, call_id=""),),
        used_call_ids=turn_call_ids,
    )
    second, _second_aliases, _second_coalesced = canonicalize_tool_calls(
        (ToolCallRequest(tool_id="read_file", arguments={"path": "b.txt"}, call_id=""),),
        used_call_ids=turn_call_ids,
    )

    assert first[0].call_id != second[0].call_id
    assert [first[0].call_id, second[0].call_id] == ["call_1", "call_1_2"]
    # No randomness: the rename is a deterministic ordinal suffix, so replaying
    # the same generation against a fresh namespace reproduces the same id.
    replay, _replay_aliases, _replay_coalesced = canonicalize_tool_calls(
        (ToolCallRequest(tool_id="read_file", arguments={"path": "a.txt"}, call_id=""),),
        used_call_ids=set(),
    )
    assert replay[0].call_id == first[0].call_id


def test_turn_scoped_namespace_preserves_genuine_provider_call_ids() -> None:
    """A provider-supplied id passes through byte-identical, collision or not."""
    turn_call_ids: set[str] = set()
    canonical, aliases, _coalesced = canonicalize_tool_calls(
        (
            ToolCallRequest(
                tool_id="read_file",
                arguments={"path": "a.txt"},
                call_id="call_provider_1",
            ),
        ),
        used_call_ids=turn_call_ids,
    )
    assert canonical[0].call_id == "call_provider_1"
    assert aliases == []
    assert "call_provider_1" in turn_call_ids


def test_canonicalize_tool_calls_without_namespace_keeps_per_batch_behavior() -> None:
    """Omitting the namespace preserves the legacy single-generation contract."""
    calls = (ToolCallRequest(tool_id="read_file", arguments={"path": "a.txt"}, call_id=""),)
    first, _first_aliases, _first_coalesced = canonicalize_tool_calls(calls)
    second, _second_aliases, _second_coalesced = canonicalize_tool_calls(calls)
    assert first[0].call_id == second[0].call_id == "call_1"


def test_id_less_calls_in_consecutive_iterations_get_distinct_durable_ids() -> None:
    """The 'read file A, then read file B' shape must not overwrite row 1."""
    engine = _ToolLoopEngine(
        plans=[
            _tool_plan(
                ToolCallRequest(tool_id="read_file", arguments={"path": "a.txt"}),
            ),
            _tool_plan(
                ToolCallRequest(tool_id="read_file", arguments={"path": "b.txt"}),
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Both files read.",
                    finish_reason="stop",
                )
            ),
        ]
    )
    mcp_client = _StubMCPClient((_read_file_descriptor(),))
    router = _build_router(engine=engine, mcp_client=mcp_client)
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_idless_two_iterations",
        messages=[{"role": "user", "content": "Read a.txt then b.txt."}],
        latest_user_content="Read a.txt then b.txt.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_idless_two_iterations",
            max_iterations=4,
            streaming=True,
        ),
    )

    executing_ids = [
        event.call_id for event in events if isinstance(event, ToolExecutingEvent)
    ]
    result_ids = [event.call_id for event in events if isinstance(event, ToolResultEvent)]
    assert len(executing_ids) == 2
    assert len(set(executing_ids)) == 2, "iteration 2 reused iteration 1's call id"
    assert result_ids == executing_ids
    outcome_ids = [str(getattr(outcome, "call_id", "") or "") for outcome in decision.tool_results]
    assert len(set(outcome_ids)) == 2, "durable outcome rows collided on one call id"
    assert [arguments["path"] for _tool, arguments in mcp_client.executions] == [
        "a.txt",
        "b.txt",
    ]
    assert decision.response_text == "Both files read."


# ── F7: a committed tool must report its real result ─────────────────────────


class _InterruptAfterCommitMCPClient(_StubMCPClient):
    """Interrupts the turn immediately AFTER a tool has committed its effect."""

    def __init__(self, descriptors: tuple[MCPToolDescriptor, ...], *, trip: Any) -> None:
        super().__init__(descriptors)
        self._trip = trip

    def execute_tool(  # type: ignore[override]
        self,
        tool_name: str,
        arguments: dict[str, object],
        **kwargs: Any,
    ) -> object:
        outcome = _StubMCPClient.execute_tool(
            self,
            tool_name,
            arguments,
            timeout_seconds=kwargs.get("timeout_seconds"),
            cancel_handle=kwargs.get("cancel_handle"),
        )
        self._trip()
        return outcome


def test_tool_committed_before_interruption_reports_real_success() -> None:
    """A tool whose dispatch returned must NOT be reported as CMP-LOOP-0013.

    The interruption lands after ``_dispatch_tool_call`` has already committed
    the effect; the loop must still surface the tool's REAL result before the
    terminal cancellation propagates, never an ``interrupted`` retry stub.
    """
    engine = _ToolLoopEngine(
        plans=[
            _tool_plan(
                ToolCallRequest(
                    tool_id="read_file",
                    arguments={"path": "a.txt"},
                    call_id="call_committed_read",
                ),
            ),
        ]
    )
    cancel_handle = TurnCancellationHandle(request_id="req_committed_before_cancel")
    mcp_client = _InterruptAfterCommitMCPClient(
        (_read_file_descriptor(),),
        trip=lambda: cancel_handle.cancel(reason="user"),
    )
    router = _build_router(engine=engine, mcp_client=mcp_client)
    events: list[object] = []

    with pytest.raises(TerminalChatStateError):
        router.build_chat_decision(
            request_id="req_committed_before_cancel",
            messages=[{"role": "user", "content": "Read a.txt."}],
            latest_user_content="Read a.txt.",
            mode="assist",
            approvals_pre_granted=True,
            runtime=LoopRuntime(
                emit=events.append,
                request_id="req_committed_before_cancel",
                max_iterations=3,
                streaming=True,
                cancel_handle=cancel_handle,
            ),
        )

    assert mcp_client.executions == [("read_file", {"path": "a.txt"})]
    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    assert len(result_events) == 1, "the committed tool must produce exactly one result row"
    assert result_events[0].call_id == "call_committed_read"
    assert result_events[0].success is True
    assert result_events[0].error_code != CMP_LOOP_TOOL_INTERRUPTED
    assert result_events[0].content == "read_file completed"


def test_malformed_tool_arguments_fail_one_call_and_siblings_execute() -> None:
    """F13c: unparseable non-streaming arguments reject PER CALL, not per turn.

    The non-streaming vLLM parser used to swallow a JSON parse failure into
    ``{}`` and dispatch the call anyway, so a truncated payload silently became
    a no-arg invocation -- while the STREAMING path rejected the identical wire
    shape with CMP-LOOP-0002. This pins the non-streaming path to the same
    verdict, delivered through the existing per-call rejection seam so a
    sibling call still runs and the turn still completes.
    """
    engine = _ToolLoopEngine(
        plans=[
            _tool_plan(
                ToolCallRequest(
                    tool_id="read_file",
                    arguments={},
                    call_id="call_bad_args",
                    malformed_arguments=True,
                ),
                ToolCallRequest(
                    tool_id="mermaid_generate",
                    arguments={"prompt": "flowchart TD\n  a --> b"},
                    call_id="call_mermaid_ok",
                ),
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="One call was malformed; here is the diagram.",
                    finish_reason="stop",
                )
            ),
        ]
    )
    mcp_client = _StubMCPClient((_mermaid_descriptor(), _read_file_descriptor()))
    router = _build_router(
        engine=engine,
        mcp_client=mcp_client,
        tools_mermaid_enabled=True,
    )
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_malformed_arguments",
        messages=[{"role": "user", "content": "Read a file and diagram it."}],
        latest_user_content="Read a file and diagram it.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_malformed_arguments",
            max_iterations=3,
            streaming=True,
        ),
    )

    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    blocked = [
        event for event in result_events if event.error_code == CMP_LOOP_INVALID_TOOL_CALL
    ]
    succeeded = [event for event in result_events if event.success]
    assert len(blocked) == 1, "the malformed call must surface as a failed outcome"
    assert blocked[0].call_id == "call_bad_args"
    assert len(succeeded) == 1, "the sibling call must still execute"
    assert mcp_client.executions == [
        ("mermaid_generate", {"prompt": "flowchart TD\n  a --> b", "_jenny_read_only": False})
    ], "the malformed call must never be dispatched"
    # The turn survived: a normal final response, not a turn-fatal chat.error.
    assert decision.response_text == "One call was malformed; here is the diagram."


def test_all_malformed_tool_arguments_still_end_the_turn_gracefully() -> None:
    """Every call malformed: the all-blocked tail runs, the model gets a retry."""
    engine = _ToolLoopEngine(
        plans=[
            _tool_plan(
                ToolCallRequest(
                    tool_id="read_file",
                    arguments={},
                    call_id="call_only_bad",
                    malformed_arguments=True,
                ),
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="Sorry, I sent invalid arguments. Here is a plain answer.",
                    finish_reason="stop",
                )
            ),
        ]
    )
    mcp_client = _StubMCPClient((_read_file_descriptor(),))
    router = _build_router(engine=engine, mcp_client=mcp_client)
    events: list[object] = []

    decision = router.build_chat_decision(
        request_id="req_all_malformed",
        messages=[{"role": "user", "content": "Read a.txt."}],
        latest_user_content="Read a.txt.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_all_malformed",
            max_iterations=3,
            streaming=True,
        ),
    )

    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    assert len(result_events) == 1
    assert result_events[0].error_code == CMP_LOOP_INVALID_TOOL_CALL
    assert result_events[0].success is False
    assert mcp_client.executions == []
    assert decision.response_text == (
        "Sorry, I sent invalid arguments. Here is a plain answer."
    )
