"""LoopRuntime hashes an emitted call's arguments once, however often it is audited."""

from __future__ import annotations

import pytest

from sidecar.ai.routing import loop_runtime as loop_runtime_module
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.tool_observation import (
    KIND_TOOL_EXECUTION_OBSERVED,
    KIND_TOOL_EXECUTION_STARTED,
    ToolObservationStore,
    tool_argument_fingerprint,
)


def test_one_fingerprint_computation_per_call(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[object] = []

    def _counting(arguments: object) -> str:
        calls.append(arguments)
        return tool_argument_fingerprint(arguments)

    monkeypatch.setattr(loop_runtime_module, "tool_argument_fingerprint", _counting)
    store = ToolObservationStore()
    store.ensure_turn(request_id="req-1")
    runtime = LoopRuntime(request_id="req-1", observation_store=store)
    arguments = {"path": "README.md"}
    runtime.emitted_tool_calls["c1"] = {"arguments": arguments}

    for kind in (KIND_TOOL_EXECUTION_STARTED, KIND_TOOL_EXECUTION_OBSERVED):
        runtime.audit(kind, tool_call_id="c1", tool_name="read_file")
    assert runtime.argument_fingerprint("c1") == tool_argument_fingerprint(arguments)

    assert len(calls) == 1
    events = store.recent_events(request_id="req-1", limit=10)
    assert {event._argument_fingerprint for event in events} == {
        tool_argument_fingerprint(arguments)
    }


def test_replaced_arguments_are_rehashed_and_unknown_calls_skip() -> None:
    runtime = LoopRuntime(request_id="req-1")
    runtime.emitted_tool_calls["c1"] = {"arguments": {"path": "a"}}
    first = runtime.argument_fingerprint("c1")
    runtime.emitted_tool_calls["c1"] = {"arguments": {"path": "b"}}

    assert runtime.argument_fingerprint("c1") != first
    assert runtime.argument_fingerprint("missing") is None
