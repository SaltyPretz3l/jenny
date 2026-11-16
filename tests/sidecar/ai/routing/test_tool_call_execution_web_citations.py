# new-test-file: test_tool_call_execution.py is at 565 lines (cap 600); this is a
# different contract (per-request web citation numbering) with its own small fixture.
"""Web citation markers count across one turn through the sequential tool executor."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_call_execution import execute_tool_calls_sequentially
from sidecar.ai.tools.models import ToolCallRequest


def _web_output(count: int) -> str:
    return json.dumps(
        {
            "sources": [{"url": f"https://e.test/{i}", "title": "t"} for i in range(count)],
            "citations": [
                {"id": f"web:{i + 1}", "url": f"https://e.test/{i}", "title": "t"}
                for i in range(count)
            ],
        }
    )


class _Kernel:
    def __init__(self, outputs: list[str]) -> None:
        self._outputs = outputs
        self._mcp_client = SimpleNamespace(tool_descriptor=lambda _name: None)

    def _assert_valid_tool_call(self, _call: Any) -> None:
        return

    def _assistant_tool_call_message(self, _result: Any, call: Any) -> dict[str, object]:
        return {"role": "assistant", "tool": call.tool_id}

    def _tool_result_message(self, call: Any, outcome: Any) -> dict[str, object]:
        return {"role": "tool", "tool": call.tool_id, "content": outcome.output}

    def _execute_tool(self, call: ToolCallRequest, **_kwargs: Any) -> ToolExecutionOutcome:
        return ToolExecutionOutcome(
            tool_name=call.tool_id,
            output=self._outputs.pop(0),
            success=True,
            tool_input=dict(call.arguments),
            call_id=call.call_id,
        )

    def _update_read_snapshot_cache(self, _cache: dict[str, Any], **_kwargs: Any) -> None:
        return


def _run(
    runtime: LoopRuntime, tool_ids: list[str], outputs: list[str], history: list[Any] | None = None
) -> tuple[list[Any], list[Any]]:
    kernel = _Kernel(list(outputs))
    outcomes: list[Any] = []
    messages: list[Any] = list(history or [])
    calls = [
        ToolCallRequest(tool_id=tid, arguments={"query": "q"}, call_id=f"call-{i}")
        for i, tid in enumerate(tool_ids)
    ]
    execute_tool_calls_sequentially(
        indexed_calls=[(call, i + 1) for i, call in enumerate(calls)],
        runtime=runtime,
        kernel=kernel,
        result=SimpleNamespace(),
        request_id="req-1",
        session_id="session-1",
        tool_resolution_context=None,
        read_snapshot_cache={},
        outcomes=outcomes,
        working_messages=messages,
        iteration_calls=[],
        streamed_event_types=set(),
        tool_payload_ref=[],
        tool_contract=None,
    )
    return outcomes, messages


def _ids(output: str) -> list[str]:
    return [c["id"] for c in json.loads(output)["citations"]]


def _runtime() -> LoopRuntime:
    return LoopRuntime(request_id="req-1", session_id="session-1", tool_call_limit=20)


def test_a_second_web_call_continues_the_numbering_for_the_model_and_the_event() -> None:
    runtime = _runtime()

    outcomes, messages = _run(
        runtime, ["web_search", "web_search"], [_web_output(2), _web_output(2)]
    )

    assert _ids(outcomes[0].output) == ["web:1", "web:2"]
    assert "citation_offset" not in json.loads(outcomes[0].output)
    assert _ids(outcomes[1].output) == ["web:3", "web:4"]
    assert json.loads(outcomes[1].output)["citation_offset"] == 2
    assert _ids(messages[-1]["content"]) == ["web:3", "web:4"]


def test_web_search_then_fetch_url_continues_and_other_tools_do_not_count() -> None:
    runtime = _runtime()

    outcomes, _messages = _run(
        runtime,
        ["web_search", "read_file", "fetch_url", "fetch_url"],
        [_web_output(3), "plain file text", _web_output(1), _web_output(1)],
    )

    assert outcomes[1].output == "plain file text"
    assert _ids(outcomes[2].output) == ["web:4"]
    assert _ids(outcomes[3].output) == ["web:5"]


def test_a_failed_web_call_does_not_move_the_counter() -> None:
    runtime = _runtime()

    outcomes, _messages = _run(
        runtime,
        ["web_search", "web_search", "web_search"],
        [
            _web_output(2),
            json.dumps({"error": "down", "sources": [], "citations": []}),
            _web_output(1),
        ],
    )

    assert _ids(outcomes[2].output) == ["web:3"]


def test_an_approval_resume_continues_after_the_turn_s_earlier_web_results() -> None:
    # chat_resume builds a fresh LoopRuntime mid-turn; the turn's earlier tool results are in its messages.
    earlier = {
        "citations": [
            {"id": "web:1", "url": "https://e.test/a"},
            {"id": "web:2", "url": "https://e.test/b"},
        ]
    }
    before = {"citations": [{"id": "web:9", "url": "https://e.test/old"}]}
    history = [
        {"role": "tool", "content": json.dumps(before)},
        {"role": "user", "content": "next question"},
        {"role": "tool", "content": json.dumps(earlier)},
        {"role": "tool", "content": "plain text"},
    ]

    outcomes, _messages = _run(_runtime(), ["web_search"], [_web_output(2)], history=history)

    assert _ids(outcomes[0].output) == ["web:3", "web:4"], "an earlier turn's web:9 does not count"


def test_a_new_request_starts_again_at_one() -> None:
    first, _ = _run(_runtime(), ["web_search"], [_web_output(2)])
    second, _ = _run(_runtime(), ["web_search"], [_web_output(2)])

    assert _ids(first[0].output) == ["web:1", "web:2"]
    assert _ids(second[0].output) == ["web:1", "web:2"]


def test_a_resume_seeds_from_framed_tool_messages_in_both_formats() -> None:
    # Review 2026-11-14: real history messages are framed (untrusted wrapper, or the result envelope),
    # so the seed must find the turn's earlier web:N ids inside the frame, not only in bare JSON.
    from sidecar.ai.routing.tool_execution_results import tool_result_message

    call = ToolCallRequest(tool_id="web_search", arguments={"query": "q"}, call_id="call-old")
    outcome = ToolExecutionOutcome(
        tool_name="web_search",
        output=_web_output(3),
        success=True,
        tool_input={},
        call_id="call-old",
    )
    for envelope in (False, True):
        framed = tool_result_message(
            call, outcome, SimpleNamespace(tool_result_envelope_enabled=envelope)
        )
        assert not str(framed["content"]).lstrip().startswith("{")
        history = [{"role": "user", "content": "q"}, framed]

        outcomes, _messages = _run(_runtime(), ["web_search"], [_web_output(2)], history=history)

        assert _ids(outcomes[0].output) == ["web:4", "web:5"], f"envelope={envelope}"
