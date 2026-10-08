"""Turn-diagnostics request metrics recorded by the router render seam.

``_chat_response_from_decision`` is the single place the routed lane records
``record_request_metrics`` (context estimate, message and tool-schema counts)
for a finished turn.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sidecar.ai.routing.router import ChatDecision
from sidecar.ai.tools.models import GenerationResult
from sidecar.runtime.chat_decision_render import _chat_response_from_decision
from sidecar.runtime.chat_models import ChatRequestContext
from tests.sidecar.ai.routing.test_stream_incomplete_surfacing import _Engine


def _brain(turn_diagnostics: Any) -> Any:
    return SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                background_runtime_root=None,
                engine_type="stub",
                feature_flags={},
                max_inline_payload_bytes=65_536,
                model="stub-model-example",
            ),
            engine=_Engine(GenerationResult(content="", finish_reason="stop")),
            tool_observations=None,
            turn_diagnostics=turn_diagnostics,
        )
    )


def _render(brain: Any, decision: ChatDecision) -> Any:
    return _chat_response_from_decision(
        request_context=ChatRequestContext(
            request_id="req-diag-example",
            trace_id=None,
            session_id=None,
            mode="assist",
            approvals_pre_granted=False,
        ),
        latest_user_content="hi",
        canonical_session_messages=[],
        session_title="",
        brain_container=brain,
        decision=decision,
    )


def test_render_records_request_metrics_when_diagnostics_present() -> None:
    recorded: list[dict[str, object]] = []

    class _FakeDiagnostics:
        def record_request_metrics(self, **kwargs: object) -> None:
            recorded.append(dict(kwargs))

    decision = ChatDecision(
        thinking_text=None,
        response_text="Hello.",
        approval_request=None,
        tool_results=(),
        context_tokens_estimate=512,
        message_count=4,
        tool_schema_count=7,
    )

    _render(_brain(_FakeDiagnostics()), decision)

    assert recorded == [
        {
            "request_id": "req-diag-example",
            "mode": "assist",
            "context_tokens_estimate": 512,
            "message_count": 4,
            "tool_schema_count": 7,
        }
    ]


def test_render_without_diagnostics_store_still_completes() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Hello.",
        approval_request=None,
        tool_results=(),
    )

    response = _render(_brain(None), decision)

    assert response.result["status"] == "completed"
