from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.error_codes import CMP_STREAM_INCOMPLETE
from sidecar.ai.feature_flags import FEATURE_CANONICAL_TURN_EVENTS
from sidecar.ai.routing.router import ChatDecision
from sidecar.protocol import CHAT_DONE_METHOD, CHAT_ERROR_METHOD, TURN_EVENT_METHOD
from sidecar.runtime.chat_decision_render import _chat_response_from_decision
from sidecar.runtime.chat_models import ChatRequestContext
from sidecar.runtime.chat_streaming import build_live_streaming_chat_response


class _Engine:
    def __init__(self, finish_reason: str, content: str | None = "partial text") -> None:
        self._finish_reason = finish_reason
        self._content = content

    def stream(self, **_kwargs: object):
        if self._content is not None:
            yield SimpleNamespace(kind="content", text=self._content)
        yield SimpleNamespace(kind="done", text="", finish_reason=self._finish_reason)

    def get_model_context_length(self) -> int | None:
        return None

    def get_model_max_output_tokens(self) -> int | None:
        return None


def _response_for(finish_reason: str, *, content: str | None = "partial text") -> Any:
    engine = _Engine(finish_reason, content)
    config = SimpleNamespace(
        mode="chat",
        engine_type="stub",
        model="stub-model",
        feature_flags={FEATURE_CANONICAL_TURN_EVENTS: True},
        system_prompt="System prompt for testing.",
        max_tokens=4096,
        tools_workspace_manifest_enabled=False,
        tools_task_capsule_enabled=False,
    )
    brain = SimpleNamespace(
        stack=SimpleNamespace(
            config=config,
            engine=engine,
            context_builder=ContextBuilder(None),
            memory_store=None,
            turn_diagnostics=None,
        )
    )
    return build_live_streaming_chat_response(
        request_id=f"req_{finish_reason}",
        trace_id=None,
        session_id=None,
        latest_user_content="Answer the question.",
        messages=[{"role": "user", "content": "Answer the question."}],
        brain_container=brain,
        reasoning_effort=None,
        learned_lessons=None,
        max_tokens=256,
    )


def _notifications(response: Any, method: str) -> list[dict[str, Any]]:
    return [item for item in response.notifications if item.get("method") == method]


def test_incomplete_finish_reason_emits_failed_terminal() -> None:
    response = _response_for("incomplete")

    error_notes = _notifications(response, CHAT_ERROR_METHOD)
    assert len(error_notes) == 1
    assert error_notes[0]["params"]["code"] == "CMP-STREAM-INCOMPLETE"
    assert error_notes[0]["params"]["retryable"] is True
    assert not _notifications(response, CHAT_DONE_METHOD)

    turn_event_types = [
        item["params"]["type"] for item in _notifications(response, TURN_EVENT_METHOD)
    ]
    assert "turn_failed" in turn_event_types
    assert "turn_completed" not in turn_event_types
    assert response.result["status"] == "runtime_error"
    assert response.result["terminal_subcode"] == "stream_incomplete"


@pytest.mark.parametrize(
    ("finish_reason", "content", "expected_subcode"),
    [
        ("thinking_budget", "partial text", "thinking_budget"),
        ("length", None, "stream_incomplete"),
    ],
)
def test_budget_terminal_without_usable_completion_emits_failed_terminal(
    finish_reason: str,
    content: str | None,
    expected_subcode: str,
) -> None:
    response = _response_for(finish_reason, content=content)

    assert len(_notifications(response, CHAT_ERROR_METHOD)) == 1
    assert not _notifications(response, CHAT_DONE_METHOD)
    assert response.result["status"] == "runtime_error"
    assert response.result["terminal_subcode"] == expected_subcode


def test_length_finish_reason_with_content_preserves_clean_completion() -> None:
    response = _response_for("length", content="fine answer")

    assert not _notifications(response, CHAT_ERROR_METHOD)
    assert len(_notifications(response, CHAT_DONE_METHOD)) == 1
    assert response.result["status"] == "completed"


def test_length_finish_reason_with_whitespace_emits_failed_terminal() -> None:
    response = _response_for("length", content="\n")

    error_notes = _notifications(response, CHAT_ERROR_METHOD)
    assert len(error_notes) == 1
    assert error_notes[0]["params"]["code"] == "CMP-STREAM-INCOMPLETE"
    assert response.result["status"] == "runtime_error"
    assert response.result["terminal_subcode"] == "stream_incomplete"


def test_decision_terminal_error_renders_stream_incomplete_runtime_error() -> None:
    config = SimpleNamespace(
        background_runtime_root=None,
        engine_type="stub",
        feature_flags={},
        max_inline_payload_bytes=65_536,
        model="stub-model",
    )
    brain = SimpleNamespace(
        stack=SimpleNamespace(
            config=config,
            engine=_Engine("stop"),
            tool_observations=None,
            turn_diagnostics=None,
        )
    )
    decision = ChatDecision(
        thinking_text=None,
        response_text="The stream ended early.",
        approval_request=None,
        tool_results=(),
        terminal_error_code=CMP_STREAM_INCOMPLETE,
        terminal_error_retryable=True,
    )

    response = _chat_response_from_decision(
        request_context=ChatRequestContext(
            request_id="req_decision_incomplete",
            trace_id=None,
            session_id=None,
            mode="chat",
            approvals_pre_granted=False,
        ),
        latest_user_content="Answer the question.",
        canonical_session_messages=[],
        session_title="",
        brain_container=brain,
        decision=decision,
    )

    assert response.result["status"] == "runtime_error"
    assert response.result["terminal_subcode"] == "stream_incomplete"


def test_stop_finish_reason_preserves_clean_completion() -> None:
    response = _response_for("stop")

    assert not _notifications(response, CHAT_ERROR_METHOD)
    assert len(_notifications(response, CHAT_DONE_METHOD)) == 1
    assert response.result["status"] == "completed"
