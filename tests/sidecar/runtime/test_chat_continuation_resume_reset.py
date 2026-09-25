from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

import sidecar.runtime.chat_continuation_resume as resume
from sidecar.ai.routing.loop_events import StreamResetEvent
from sidecar.ai.routing.router import ToolExecutionOutcome
from tests.sidecar.runtime.test_chat_continuation_resume import (
    _fresh_request,
    _hydrated,
    _resume_arguments,
)

# The in-band tool round follows its tools with a ``tool_continuation``
# stream reset so the Electron capture path closes the pre-tool commentary
# slice before the next generation restarts its token sequence at 1. The
# approval-resume path re-enters after the tools on a fresh worker and used to
# continue straight into ``run.execute()`` without that boundary (seen live
# 2026-09-15: the continuation painted into the pre-approval row).


def _install_fake_loop(monkeypatch: pytest.MonkeyPatch, events: list[object]) -> list[Any]:
    fake_runs: list[Any] = []

    class _FakeRun:
        def __init__(self, **kwargs: Any) -> None:
            self.runtime = kwargs["runtime"]
            self.outcomes: list[Any] = []
            self.streamed_event_types: set[str] = set()
            self.outcome_index = 0
            self.completed_generations = 0
            self.budget_tracker = kwargs["budget_tracker"]
            self.tool_payload = kwargs["tool_payload"]
            fake_runs.append(self)

        def execute(self) -> object:
            events.append(("generate", tuple(item.call_id for item in self.outcomes)))
            return SimpleNamespace(done=True)

    def _execute(**kwargs: Any) -> None:
        for call, _index in kwargs["indexed_calls"]:
            kwargs["outcomes"].append(ToolExecutionOutcome(
                tool_name=call.tool_id, output="ok", success=True, call_id=call.call_id,
            ))
            kwargs["iteration_calls"].append(call)
        events.append(("dispatch", tuple(call.call_id for call, _ in kwargs["indexed_calls"])))

    monkeypatch.setattr(resume, "_ToolLoopRun", _FakeRun)
    monkeypatch.setattr(
        resume, "_preflight_pending_batch",
        lambda run, result: (
            [(call, index + 1) for index, call in enumerate(result.tool_calls)], {}, "prompt",
        ),
    )
    monkeypatch.setattr(resume, "execute_tool_calls_sequentially", _execute)
    monkeypatch.setattr(resume, "_finish_pending_batch", lambda *_args: None)
    return fake_runs


def _arguments(request: Any, runtime: Any) -> dict[str, Any]:
    arguments = _resume_arguments(_hydrated(), request, runtime)
    arguments["kernel"]._config = SimpleNamespace(feature_flags={"resource_discipline": False})
    return arguments


@pytest.mark.parametrize("streaming", [True, False])
def test_resume_emits_tool_continuation_reset_before_next_generation(
    monkeypatch: pytest.MonkeyPatch, streaming: bool,
) -> None:
    events: list[object] = []
    request, runtime = _fresh_request()
    runtime.streaming = streaming
    runtime.emit = lambda event: events.append(("emit", type(event).__name__, getattr(event, "reason", None)))  # type: ignore[method-assign]
    fake_runs = _install_fake_loop(monkeypatch, events)

    result = resume.resume_before_tool_dispatch(**_arguments(request, runtime))

    assert result.done is True
    expected_reset = [("emit", StreamResetEvent.__name__, "tool_continuation")] if streaming else []
    assert events == [("dispatch", ("call_1", "call_2")), *expected_reset, ("generate", ("call_1", "call_2"))]
    assert ("chat.stream_reset" in fake_runs[0].streamed_event_types) is streaming
