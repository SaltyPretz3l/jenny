"""The canonical turn event for a ``browser`` result keeps the step summary, never the page text."""

from __future__ import annotations

import hashlib
from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.routing.loop_events import ToolResultEvent
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.tools.models import GenerationResult
from sidecar.ai.tools.tool_families import BROWSER_STEP_FALLBACK, saved_tool_output
from sidecar.protocol import TURN_EVENT_METHOD
from sidecar.runtime.chat_decision_render import _chat_response_from_decision
from sidecar.runtime.chat_models import ChatRequestContext
from sidecar.runtime.chat_serialization import _serialize_turn_event
from sidecar.runtime.continuation_outcomes import outcome_refs
from sidecar.runtime.decision_checkpoint import _completed
from tests.sidecar.ai.routing.test_stream_incomplete_surfacing import _decision_for, _Engine
from tests.sidecar.runtime.test_chat_decision_render_plan_usage import _brain

MARKER = "PAGETEXT-7f3a9c"
PAGE = f"Page: Shop\nURL: https://shop.example/\n\n[r1] link \"{MARKER}\"\n" + (f"{MARKER} text. " * 300)
STEP = "Opened shop.example. Now on Shop (https://shop.example/)"
TOOL_INPUT = {"action": "navigate", "url": "https://shop.example/"}


def _serialized(tool_name: str, metadata: dict[str, Any] | None, success: bool = True) -> dict[str, Any]:
    event = ToolResultEvent(
        call_id="call-1",
        tool_name=tool_name,
        success=success,
        content=PAGE,
        tool_input=dict(TOOL_INPUT),
        metadata=metadata,
    )
    canonical = _serialize_turn_event(event, "req", trace_id=None, session_id="sess", seq=1)
    assert canonical is not None
    return canonical["params"]["payload"]


def _rendered(tool_name: str, metadata: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    engine = _Engine(GenerationResult(content="", finish_reason="stop"))
    decision = replace(
        _decision_for("stop"),
        tool_results=(
            ToolExecutionOutcome(
                tool_name=tool_name,
                output=PAGE,
                success=True,
                tool_input=dict(TOOL_INPUT),
                metadata=metadata,
                call_id="call-1",
            ),
        ),
    )
    response = _chat_response_from_decision(
        request_context=ChatRequestContext(
            request_id="req_render",
            trace_id=None,
            session_id="sess_render",
            mode="chat",
            approvals_pre_granted=False,
        ),
        latest_user_content="open shop.example",
        canonical_session_messages=[],
        session_title="",
        brain_container=_brain(engine=engine, feature_flags={"canonical_turn_events": True}),
        decision=decision,
    )
    turn_events = [n["params"] for n in response.notifications if n.get("method") == TURN_EVENT_METHOD]
    completed = next(e for e in turn_events if e["type"] == "tool_execution_completed")
    live = next(n["params"] for n in response.notifications if n.get("method") == "tool.result")
    return completed["payload"], live


def test_helper_keeps_the_step_summary_for_browser_and_the_output_for_others() -> None:
    assert saved_tool_output("browser", PAGE, {"step_summary": STEP}) == STEP
    for metadata in (None, {}, {"step_summary": ""}, {"step_summary": "   "}, {"step_summary": 7}, "text"):
        assert saved_tool_output("browser", PAGE, metadata) == BROWSER_STEP_FALLBACK
    assert BROWSER_STEP_FALLBACK == "Browser step finished."
    assert saved_tool_output("read_file", PAGE, {"step_summary": STEP}) == PAGE


def test_serialized_loop_event_holds_the_summary_and_not_the_page() -> None:
    payload = _serialized("browser", {"result_kind": "browser", "step_summary": STEP})
    assert payload["tool_output_summary"] == STEP
    assert MARKER not in repr(payload)


def test_a_missing_summary_gives_the_fixed_text() -> None:
    payload = _serialized("browser", {"result_kind": "browser"})
    assert payload["tool_output_summary"] == "Browser step finished."
    assert MARKER not in repr(payload)
    assert _serialized("browser", None)["tool_output_summary"] == "Browser step finished."


def test_a_failed_browser_result_is_summarised_the_same_way() -> None:
    payload = _serialized("browser", {"step_summary": "The user did not allow that."}, success=False)
    assert payload["tool_output_summary"] == "The user did not allow that."


def test_another_tool_is_unchanged() -> None:
    payload = _serialized("read_file", {"step_summary": STEP})
    assert payload["tool_output_summary"].startswith("Page: Shop")
    assert MARKER in payload["tool_output_summary"]


def test_decision_render_holds_the_summary_in_the_canonical_event_and_the_page_only_live() -> None:
    canonical, live = _rendered("browser", {"result_kind": "browser", "step_summary": STEP})
    assert canonical["tool_output_summary"] == STEP
    assert MARKER not in repr(canonical)
    # The live notification still carries the page so the model can read it this turn; Electron saves the summary.
    assert live["output"] == PAGE


def test_decision_render_keeps_other_tools_whole() -> None:
    canonical, _live = _rendered("read_file", {"step_summary": STEP})
    assert MARKER in canonical["tool_output_summary"]


@pytest.mark.parametrize("tool_name", ["browser", "read_file"])
def test_the_two_serializers_agree(tool_name: str) -> None:
    metadata = {"step_summary": STEP}
    from_event = _serialized(tool_name, metadata)["tool_output_summary"]
    from_decision, _live = _rendered(tool_name, metadata)
    assert from_event[:16384] == from_decision["tool_output_summary"][:16384]


def test_a_resume_reference_hashes_what_the_turn_log_keeps() -> None:
    """A browser result in a deferred batch must still verify after the page text is gone."""
    outcome = ToolExecutionOutcome(
        call_id="call-1", tool_name="browser", output=PAGE, success=True, tool_input=dict(TOOL_INPUT),
        metadata={"step_summary": STEP},
    )
    other = replace(outcome, call_id="call-2", tool_name="read_file", metadata={})
    refs = {ref["call_id"]: ref["result_sha256"] for ref in outcome_refs([outcome, other])}
    assert refs["call-1"] == hashlib.sha256(STEP.encode()).hexdigest()
    assert refs["call-2"] == hashlib.sha256(PAGE.encode()).hexdigest()


def test_a_decision_snapshot_hashes_what_the_turn_log_keeps() -> None:
    """A snapshot taken after a browser step must agree with the reference a resume checks."""
    outcome = ToolExecutionOutcome(
        call_id="call-1", tool_name="browser", output=PAGE, success=True, tool_input=dict(TOOL_INPUT),
        metadata={"step_summary": STEP},
    )
    plan = SimpleNamespace(outcomes=[outcome])
    assert _completed(plan, []) == outcome_refs([outcome])
    assert _completed(plan, outcome_refs([outcome])) == outcome_refs([outcome]), "an earlier snapshot does not conflict"
