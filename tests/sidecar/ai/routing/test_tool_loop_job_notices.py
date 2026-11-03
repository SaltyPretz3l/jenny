"""Mid-turn background-job notices: the tool loop announces parked jobs before its next generation."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sidecar.ai.routing.background_job_notices import drain_job_notices, render_job_notice
from sidecar.ai.routing.loop_events import BackgroundJobNoticeConsumedEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.protocol import API_VERSION
from sidecar.runtime.chat_serialization import _serialize_loop_event
from sidecar.runtime.turn_job_notices import PendingJobNoticeQueue, bind_pending_job_notices

from .test_tool_loop import (
    _build_router,
    _mermaid_descriptor,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)

_HARNESS = "[Harness note, not a message from the user]"
_CLOSING = (
    "Its output is not shown here: read it with check_background_job when you need it. "
    "Carry on with your current step if it does not depend on this result."
)


def _job(job_id: str, command: str = "npm test", state: str = "failed", exit_code: int | None = 1) -> dict[str, Any]:
    return {"job_id": job_id, "command": command, "state": state, "exit_code": exit_code}


class _JobDuringToolEngine(_ToolLoopEngine):
    """Parks finished jobs while the first generation (the tool call) is in flight."""

    def __init__(self, plans: list[_ToolPlan], pending: PendingJobNoticeQueue, jobs: list[dict[str, Any]]) -> None:
        super().__init__(plans)
        self._pending = pending
        self._jobs = jobs

    def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
        if self.call_count == 0 and self._jobs:
            self._pending.push(self._jobs)
        return super().generate_with_tools(**kwargs)


def _plans() -> list[_ToolPlan]:
    return [
        _ToolPlan(
            result=GenerationResult(
                content="",
                finish_reason="tool_calls",
                tool_calls=(
                    ToolCallRequest(
                        tool_id="mermaid_generate",
                        arguments={"prompt": "flowchart TD\n  A --> B"},
                        call_id="call_mid_turn_job",
                    ),
                ),
            )
        ),
        _ToolPlan(result=GenerationResult(content="Done.", finish_reason="stop")),
    ]


def _run(jobs: list[dict[str, Any]]) -> tuple[_ToolLoopEngine, list[Any]]:
    pending = PendingJobNoticeQueue()
    engine = _JobDuringToolEngine(_plans(), pending, jobs)
    router = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient((_mermaid_descriptor(),)),
        tools_mermaid_enabled=True,
    )
    events: list[Any] = []
    with bind_pending_job_notices(pending):
        router.build_chat_decision(
            request_id="req_mid_turn_job",
            messages=[{"role": "user", "content": "Generate a diagram."}],
            latest_user_content="Generate a diagram.",
            mode="assist",
            approvals_pre_granted=True,
            runtime=LoopRuntime(request_id="req_mid_turn_job", max_iterations=4, emit=events.append),
        )
    return engine, events


def _texts(request: dict[str, Any]) -> list[tuple[str, str]]:
    return [(str(m.get("role")), str(m.get("content") or "")) for m in request["messages"]]


def test_parked_job_reaches_the_next_generation_after_the_tool_results() -> None:
    engine, events = _run([_job("3f9a1c2b7d10")])

    assert engine.call_count == 2
    first, second = (_texts(request) for request in engine.requests)
    assert not any(_HARNESS in text for _role, text in first)
    note_index = next(i for i, (_role, text) in enumerate(second) if text.startswith(_HARNESS))
    role, text = second[note_index]
    assert role == "user"
    assert text == (
        f"{_HARNESS} A background job you started finished:\n"
        f"- 3f9a1c2b7d10 (`npm test`): failed, exit 1\n{_CLOSING}"
    )
    assert "tool" in [r for r, _t in second[:note_index]], "the note follows the tool results"
    assert note_index == len(second) - 1

    consumed = [event for event in events if isinstance(event, BackgroundJobNoticeConsumedEvent)]
    assert len(consumed) == 1
    assert consumed[0].job_ids == ["3f9a1c2b7d10"]
    assert consumed[0].iteration == 2


def test_empty_queue_changes_nothing() -> None:
    engine, events = _run([])

    assert engine.call_count == 2
    assert not any(_HARNESS in text for request in engine.requests for _r, text in _texts(request))
    assert not any(isinstance(event, BackgroundJobNoticeConsumedEvent) for event in events)


def test_singular_and_plural_note_text() -> None:
    one = render_job_notice([_job("aaaaaaaaaaaa", exit_code=None, state="completed")])
    assert one == (
        f"{_HARNESS} A background job you started finished:\n- aaaaaaaaaaaa (`npm test`): completed\n{_CLOSING}"
    )
    two = render_job_notice([_job("aaaaaaaaaaaa", exit_code=0, state="completed"), _job("bbbbbbbbbbbb", "pytest -q")])
    assert two == (
        f"{_HARNESS} Background jobs you started finished:\n"
        "- aaaaaaaaaaaa (`npm test`): completed, exit 0\n"
        "- bbbbbbbbbbbb (`pytest -q`): failed, exit 1\n"
        f"{_CLOSING}"
    )


def _fake_loop(outcomes: list[Any] | None = None, *, sub_agent: bool = False) -> tuple[Any, list[Any]]:
    emitted: list[Any] = []
    loop = SimpleNamespace(
        is_sub_agent_request=sub_agent,
        outcomes=outcomes or [],
        working_messages=[],
        runtime=SimpleNamespace(emit=emitted.append),
        request_id="req-1",
        session_id="session-1",
    )
    return loop, emitted


def _outcome(tool_name: str, job_id: str, output: str) -> ToolExecutionOutcome:
    return ToolExecutionOutcome(tool_name=tool_name, output=output, success=True, tool_input={"job_id": job_id})


def test_already_read_jobs_are_acked_but_not_announced() -> None:
    pending = PendingJobNoticeQueue()
    pending.push([_job("aaaaaaaaaaaa"), _job("bbbbbbbbbbbb", "pytest -q"), _job("cccccccccccc")])
    loop, emitted = _fake_loop(
        [
            _outcome("check_background_job", "aaaaaaaaaaaa", '{"job_id": "aaaaaaaaaaaa", "state": "failed"}'),
            _outcome("check_background_job", "bbbbbbbbbbbb", '{"job_id": "bbbbbbbbbbbb", "state": "running"}'),
            _outcome("run_command", "cccccccccccc", '{"state": "completed"}'),
        ]
    )
    with bind_pending_job_notices(pending):
        drain_job_notices(loop, 3)

    assert len(loop.working_messages) == 1
    text = loop.working_messages[0]["content"]
    assert "aaaaaaaaaaaa" not in text
    assert "bbbbbbbbbbbb" in text and "cccccccccccc" in text
    assert [(e.job_ids, e.iteration) for e in emitted] == [(["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"], 3)]


def test_all_read_jobs_append_no_message_but_still_ack() -> None:
    pending = PendingJobNoticeQueue()
    pending.push([_job("aaaaaaaaaaaa"), _job("bbbbbbbbbbbb")])
    loop, emitted = _fake_loop(
        [
            _outcome("check_background_job", "aaaaaaaaaaaa", '{"state":"completed"}'),
            _outcome("stop_background_job", "bbbbbbbbbbbb", '{"state": "failed"}'),
        ]
    )
    with bind_pending_job_notices(pending):
        drain_job_notices(loop, 2)

    assert loop.working_messages == []
    assert [e.job_ids for e in emitted] == [["aaaaaaaaaaaa", "bbbbbbbbbbbb"]]
    assert pending.drain() == []


def test_a_state_marker_past_the_scan_window_does_not_count_as_read() -> None:
    pending = PendingJobNoticeQueue()
    pending.push([_job("aaaaaaaaaaaa")])
    padded = '{"output": "' + "x" * 5000 + '", "state": "completed"}'
    loop, _emitted = _fake_loop([_outcome("check_background_job", "aaaaaaaaaaaa", padded)])
    with bind_pending_job_notices(pending):
        drain_job_notices(loop, 2)

    assert len(loop.working_messages) == 1


def test_sub_agent_request_does_not_drain() -> None:
    pending = PendingJobNoticeQueue()
    pending.push([_job("aaaaaaaaaaaa")])
    loop, emitted = _fake_loop(sub_agent=True)
    with bind_pending_job_notices(pending):
        drain_job_notices(loop, 2)

    assert loop.working_messages == [] and emitted == []
    assert [entry["job_id"] for entry in pending.drain()] == ["aaaaaaaaaaaa"]


def test_no_bound_queue_is_a_no_op() -> None:
    loop, emitted = _fake_loop()
    drain_job_notices(loop, 2)

    assert loop.working_messages == [] and emitted == []


def test_job_notice_consumed_serializes_as_the_ephemeral_notification() -> None:
    event = BackgroundJobNoticeConsumedEvent(job_ids=["3f9a1c2b7d10"], iteration=3)
    frame = _serialize_loop_event(event, "req-1", trace_id=None, session_id="session-dst")

    assert frame is not None
    assert frame["method"] == "session.job_notice_consumed"
    assert frame["params"] == {
        "api_version": API_VERSION,
        "request_id": "req-1",
        "session_id": "session-dst",
        "job_ids": ["3f9a1c2b7d10"],
        "iteration": 3,
    }
