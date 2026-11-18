"""Delegate report metadata stays under the IPC inline budget (finding S1).

A three-child batch with full transcripts exceeded the 64 KB IPC inline
threshold, so the whole report was externalized and the monitor lost every
answer. The report is trimmed in the sidecar instead: transcripts first, then
evidence and steps, never the answers.
"""

import copy
import json
from types import SimpleNamespace

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.routing import loop_events as events
from sidecar.ai.routing.delegate import execute_delegate_tool
from sidecar.ai.routing.delegate_child_steps import (
    REPORT_METADATA_BUDGET_BYTES,
    bound_report_metadata,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ChatDecision, ToolExecutionOutcome
from sidecar.runtime.chat_models import ChatRequestContext
from sidecar.runtime.ipc_payloads import DEFAULT_MAX_INLINE_PAYLOAD_BYTES
from sidecar.runtime.subagent_slots import SubAgentSlotAllocator


def _bytes(value) -> int:
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)
    return len(text.encode("utf-8"))


def _runtime() -> LoopRuntime:
    context = ChatRequestContext(
        request_id="parent", trace_id="trace", session_id="session", mode="assist",
        approvals_pre_granted=False,
    )
    return LoopRuntime(
        request_id="parent", session_id="session", request_context=context,
        notification_writer=lambda _frame: None,
        sub_agent_slot_allocator=SubAgentSlotAllocator(
            max_active_sub_agents=3, max_sub_agents_per_parent=3
        ),
    )


def _run_delegate(tool_calls_per_child: int) -> ToolExecutionOutcome:
    config = parse_runtime_config({"engine_type": "mock"})
    started = []

    def build_chat_decision(**kwargs):
        child = kwargs["runtime"]
        ordinal = len(started)
        started.append(ordinal)
        for index in range(tool_calls_per_child):
            body = f"child output {index} " + ("lorem ipsum " * 160)
            child.emit(events.ToolExecutingEvent(f"c{index}", "read_file", {"path": f"f{index}.md"}))
            child.emit(
                events.ToolResultEvent(f"c{index}", "read_file", True, body, {"path": f"f{index}.md"})
            )
        answer = f"Answer for {ordinal}: " + ("detail " * 400)
        return ChatDecision(
            thinking_text=None, response_text=answer, approval_request=None, tool_results=()
        )

    router = SimpleNamespace(_config=config, build_chat_decision=build_chat_decision)
    return execute_delegate_tool(
        router=router,
        arguments={"tasks": ["Inspect A", "Inspect B", "Inspect C"]},
        runtime=_runtime(),
        outcome_type=ToolExecutionOutcome,
        call_id="call",
    )


def test_three_full_transcripts_stay_under_the_report_budget() -> None:
    outcome = _run_delegate(tool_calls_per_child=40)
    tasks = outcome.metadata["subagent_batch_report"]["tasks"]

    assert REPORT_METADATA_BUDGET_BYTES < DEFAULT_MAX_INLINE_PAYLOAD_BYTES
    assert _bytes(outcome.metadata) <= REPORT_METADATA_BUDGET_BYTES
    assert [task["status"] for task in tasks] == ["completed"] * 3
    for ordinal, task in enumerate(tasks):
        assert task["answer"].startswith(f"Answer for {ordinal}:")
        assert task["answer_truncated"] is False
        assert task["transcript_dropped"] > 0
        assert task["transcript"]


def test_a_small_batch_is_returned_unchanged() -> None:
    outcome = _run_delegate(tool_calls_per_child=2)
    metadata = outcome.metadata
    assert _bytes(metadata) < REPORT_METADATA_BUDGET_BYTES
    tasks = metadata["subagent_batch_report"]["tasks"]
    assert all("transcript_dropped" not in task for task in tasks)
    assert bound_report_metadata(metadata) == metadata


def _task(ordinal: int, *, transcript: int, evidence: int = 0, steps: int = 0) -> dict:
    return {
        "task_id": f"t{ordinal}", "ordinal": ordinal, "label": f"L{ordinal}",
        "status": "completed", "summary": f"summary {ordinal}", "answer": f"answer {ordinal}",
        "answer_truncated": False, "terminal_reason": "done", "error": None,
        "usage": {"total_tokens": 10},
        "evidence": [{"path": f"e{i}.md", "note": "x" * 600} for i in range(evidence)],
        "steps": [{"tool": "read_file", "target": "y" * 600} for _ in range(steps)],
        "transcript": [{"kind": "text", "text": "z" * 900, "ms": i} for i in range(transcript)],
    }


def _batch(*tasks: dict) -> dict:
    return {"result_kind": "subagent_batch_report", "subagent_batch_report": {"tasks": list(tasks)}}


def test_transcripts_drop_oldest_first_evenly_with_counts() -> None:
    metadata = _batch(_task(1, transcript=80), _task(2, transcript=80), _task(3, transcript=40))
    before = copy.deepcopy(metadata)
    assert _bytes(before) > REPORT_METADATA_BUDGET_BYTES

    bounded = bound_report_metadata(metadata)

    assert metadata == before  # the input is never mutated
    assert _bytes(bounded) <= REPORT_METADATA_BUDGET_BYTES
    tasks = bounded["subagent_batch_report"]["tasks"]
    for task, original in zip(tasks, before["subagent_batch_report"]["tasks"], strict=True):
        kept = len(task["transcript"])
        assert task["transcript"] == original["transcript"][len(original["transcript"]) - kept:]
        assert task["transcript_dropped"] == len(original["transcript"]) - kept
        assert task["answer"] == original["answer"]
        assert task["summary"] == original["summary"]
    assert abs(len(tasks[0]["transcript"]) - len(tasks[1]["transcript"])) <= 1


def test_existing_transcript_dropped_count_accumulates() -> None:
    first = _task(1, transcript=80)
    first["transcript_dropped"] = 7
    bounded = bound_report_metadata(
        _batch(first, _task(2, transcript=80), _task(3, transcript=80))
    )
    task = bounded["subagent_batch_report"]["tasks"][0]
    assert task["transcript_dropped"] == 7 + (80 - len(task["transcript"]))


def test_evidence_then_steps_trim_after_transcripts_are_gone() -> None:
    metadata = _batch(
        _task(1, transcript=0, evidence=40, steps=40),
        _task(2, transcript=0, evidence=40, steps=40),
        _task(3, transcript=0, evidence=40, steps=40),
    )
    before = copy.deepcopy(metadata)
    assert _bytes(before) > REPORT_METADATA_BUDGET_BYTES

    bounded = bound_report_metadata(metadata)

    assert _bytes(bounded) <= REPORT_METADATA_BUDGET_BYTES
    for task, original in zip(
        bounded["subagent_batch_report"]["tasks"], before["subagent_batch_report"]["tasks"], strict=True
    ):
        assert task["answer"] == original["answer"]
        kept = len(task["evidence"])
        assert task["evidence"] == original["evidence"][:kept]
        assert task.get("evidence_dropped", 0) == len(original["evidence"]) - kept
        assert "transcript_dropped" not in task
    # Evidence is exhausted before any step is touched.
    tasks = bounded["subagent_batch_report"]["tasks"]
    if any("steps_dropped" in task for task in tasks):
        assert all(not task["evidence"] for task in tasks)


def test_steps_trim_from_the_front_once_evidence_is_gone() -> None:
    metadata = _batch(
        _task(1, transcript=0, evidence=0, steps=100),
        _task(2, transcript=0, evidence=0, steps=100),
    )
    before = copy.deepcopy(metadata)
    bounded = bound_report_metadata(metadata)
    assert _bytes(bounded) <= REPORT_METADATA_BUDGET_BYTES
    for task, original in zip(
        bounded["subagent_batch_report"]["tasks"], before["subagent_batch_report"]["tasks"], strict=True
    ):
        assert task["steps_dropped"] > 0
        assert task["steps"] == original["steps"][task["steps_dropped"]:]


def test_protected_fields_survive_extreme_pressure() -> None:
    protected = (
        "answer", "answer_truncated", "summary", "status", "terminal_reason", "error",
        "task_id", "ordinal", "label", "usage",
    )
    metadata = _batch(
        _task(1, transcript=80, evidence=200, steps=200),
        _task(2, transcript=80, evidence=200, steps=200),
    )
    before = copy.deepcopy(metadata)
    bounded = bound_report_metadata(metadata)
    assert _bytes(bounded) <= REPORT_METADATA_BUDGET_BYTES
    for task, original in zip(
        bounded["subagent_batch_report"]["tasks"], before["subagent_batch_report"]["tasks"], strict=True
    ):
        for key in protected:
            assert task[key] == original[key]


def test_single_task_report_is_bounded_too() -> None:
    task = _task(1, transcript=80, evidence=60, steps=60)
    task["transcript"] = task["transcript"] * 2
    metadata = {"result_kind": "subagent_report", "subagent_report": task}
    assert _bytes(metadata) > REPORT_METADATA_BUDGET_BYTES
    bounded = bound_report_metadata(metadata)
    assert _bytes(bounded) <= REPORT_METADATA_BUDGET_BYTES
    assert bounded["subagent_report"]["answer"] == "answer 1"
    assert bounded["subagent_report"]["transcript_dropped"] > 0


def test_metadata_without_a_report_is_untouched() -> None:
    metadata = {"validation_error": "x" * 100_000}
    assert bound_report_metadata(metadata) is metadata
