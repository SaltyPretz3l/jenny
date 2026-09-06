from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ChatRouter
from sidecar.ai.tools.models import GenerationResult
from sidecar.runtime.chat_decision_render import _chat_response_from_decision
from sidecar.runtime.chat_models import ChatRequestContext


class _Engine:
    def __init__(self, result: GenerationResult) -> None:
        self._result = result

    def generate_with_tools(self, **_kwargs: Any) -> GenerationResult:
        return self._result

    def get_model_max_output_tokens(self) -> int | None:
        return None

    def get_model_context_length(self) -> int | None:
        return None


class _MCPClient:
    @property
    def available_tools(self) -> list[Any]:
        return []

    def tool_descriptor(self, _tool_name: str) -> None:
        return None


def _decision_for(
    finish_reason: str,
    *,
    content: str = "partial text",
    thinking_text: str = "",
) -> Any:
    config = replace(
        RuntimeConfig(
            engine_type="ollama",
            model="qwen",
            tools_workspace_root="C:/workspace",
        ),
        mode="assist",
    )
    router = ChatRouter(
        config=config,
        engine=_Engine(
            GenerationResult(
                content=content,
                finish_reason=finish_reason,
                thinking_text=thinking_text,
            )
        ),
        mcp_client=_MCPClient(),
        context_builder=ContextBuilder(None),
    )
    router.set_harness_snapshot_provider(lambda **_kwargs: {"tools": {"items": []}})
    return router.build_chat_decision(
        request_id=f"req_{finish_reason}",
        messages=[{"role": "user", "content": "Answer the question."}],
        latest_user_content="Answer the question.",
        mode="assist",
        approvals_pre_granted=False,
        runtime=LoopRuntime(request_id=f"req_{finish_reason}", max_iterations=1),
    )


def _rendered_terminal_subcode(decision: Any) -> str:
    brain = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                background_runtime_root=None,
                engine_type="stub",
                feature_flags={},
                max_inline_payload_bytes=65_536,
                model="stub-model",
            ),
            engine=_Engine(GenerationResult(content="", finish_reason="stop")),
            tool_observations=None,
            turn_diagnostics=None,
        )
    )
    response = _chat_response_from_decision(
        request_context=ChatRequestContext(
            request_id="req_render_terminal",
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
    return response.result["terminal_subcode"]


@pytest.mark.parametrize(
    ("finish_reason", "content"),
    [
        ("incomplete", "partial text"),
        ("incomplete", ""),
        ("error", "partial text"),
        ("thinking_budget", ""),
    ],
)
def test_unclean_generation_result_surfaces_terminal_error(
    finish_reason: str,
    content: str,
) -> None:
    decision = _decision_for(finish_reason, content=content)

    assert decision.terminal_error_code == "CMP-STREAM-INCOMPLETE"
    assert decision.terminal_error_retryable is True


def test_thinking_budget_generation_result_surfaces_terminal_error() -> None:
    decision = _decision_for("thinking_budget", thinking_text="repeated reasoning")

    assert decision.terminal_error_code == "CMP-STREAM-INCOMPLETE"
    assert decision.terminal_error_retryable is True
    assert decision.terminal_subcode == "thinking_budget"
    assert _rendered_terminal_subcode(decision) == "thinking_budget"
    assert "thinking budget" in decision.response_text


def test_incomplete_generation_result_keeps_stream_incomplete_subcode() -> None:
    decision = _decision_for("incomplete")

    assert decision.terminal_subcode is None
    assert _rendered_terminal_subcode(decision) == "stream_incomplete"


def test_clean_stop_generation_result_preserves_success_contract() -> None:
    decision = _decision_for("stop")

    assert decision.terminal_error_code is None
    assert decision.terminal_error_retryable is False


@pytest.mark.parametrize(
    ("content", "expected_code"),
    [("", "CMP-STREAM-INCOMPLETE"), ("fine answer", None)],
)
def test_length_finish_reason_only_fails_closed_without_visible_text(
    content: str,
    expected_code: str | None,
) -> None:
    decision = _decision_for("length", content=content)

    assert decision.terminal_error_code == expected_code
    assert decision.terminal_error_retryable is (expected_code is not None)
