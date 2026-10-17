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
            self.kernel = kwargs["kernel"]
            self.request_id = kwargs["request_id"]
            self.session_id = kwargs["session_id"]
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


def test_construction_failure_settles_already_claimed_owner(tmp_path, monkeypatch):
    from sidecar.ai.tools import workspace_mutation_live_owner as live
    from sidecar.ai.tools.workspace_mutation_journal_contract import workspace_identity
    from sidecar.runtime import mutation_continuation
    from tests.sidecar.runtime.test_mutation_terminal_cleanup import CHANGE_SET, _paused_edit
    workspace, store, config, run, _plan = _paused_edit(tmp_path)
    request, runtime = _fresh_request()
    arguments = _arguments(request, runtime)
    config.feature_flags = {"resource_discipline": False}
    arguments["kernel"]._config = config
    path = store.live_owner_path(workspace_identity(workspace).workspace_id, CHANGE_SET)
    live.release_live_owner(path, session_id="session", turn_id="turn")
    live.acquire_live_owner(path, session_id=arguments["session_id"], turn_id=request.logical_turn_id)
    # A genuine owner was acquired by the prior turn; isolate the construction
    # fault from checkpoint serialization already covered by the handoff test.
    monkeypatch.setattr(mutation_continuation, "claim_mutation_checkpoint", lambda *_a, **_k: CHANGE_SET)
    monkeypatch.setattr("sidecar.ai.routing.mutation_run_settlement.run_journal_owner",
                        lambda _run: (store, str(workspace)))
    def fail(**_kwargs):
        raise RuntimeError("run construction failed")
    monkeypatch.setattr(resume, "_ToolLoopRun", fail)
    with pytest.raises(RuntimeError, match="construction failed"):
        resume.resume_before_tool_dispatch(**arguments)
    path = store.live_owner_path(workspace_identity(workspace).workspace_id, CHANGE_SET)
    with live.recovery_ownership(path) as abandoned:
        assert abandoned
    assert store.load(workspace_identity(workspace).workspace_id, CHANGE_SET).record["state"] == "interrupted"



def test_real_constructor_failure_does_not_publish_mutation_context(monkeypatch):
    from sidecar.ai.routing import mutation_change_set_lifecycle as lifecycle
    request, runtime = _fresh_request()
    arguments = _arguments(request, runtime)
    def fail(*_args):
        raise RuntimeError("request tool set failed")
    arguments["kernel"]._request_tool_set = fail
    previous = lifecycle._CURRENT_RUN.get()
    try:
        with pytest.raises(RuntimeError, match="request tool set failed"):
            resume.resume_before_tool_dispatch(**arguments)
        assert lifecycle._CURRENT_RUN.get() is previous
    finally:
        lifecycle._CURRENT_RUN.set(previous)
