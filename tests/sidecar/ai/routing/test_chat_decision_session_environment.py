"""Wiring test: `build_chat_decision` invokes the Session Environment overlay.

Unit coverage for the render itself lives in
`tests/sidecar/ai/context/test_session_environment_overlay.py`. This file pins
only the wiring — the real call site in `chat_decision.py` reaches
`append_session_environment_runtime_system_message` on every turn (all depths,
with or without a session id), AFTER budget filtering, passing the
post-budget-filter prompt schemas. Mirrors
`test_chat_decision_model_identity.py`'s harness.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.routing.router import ChatRouter
from sidecar.ai.tools.models import GenerationResult
from sidecar.runtime.chat_models import ChatRequestContext


class _StubEngine:
    def __init__(self, result: GenerationResult) -> None:
        self._result = result

    def generate_with_tools(self, **_kwargs: Any) -> GenerationResult:
        return self._result

    def get_model_max_output_tokens(self) -> int | None:
        return None

    def get_model_context_length(self) -> int | None:
        return None


class _StubMCPClient:
    @property
    def available_tools(self) -> list[Any]:
        return []

    def tool_descriptor(self, _tool_name: str) -> Any | None:
        return None

    def execute_tool(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        *,
        timeout_seconds: float | None = None,
    ) -> Any:
        raise AssertionError("no tool calls are expected in this test")


def _build_router(*, config: RuntimeConfig, engine: _StubEngine) -> ChatRouter:
    if not config.tools_workspace_root and not config.agent_workspace_root:
        config = replace(config, tools_workspace_root="C:/workspace")
    if config.mode == "chat":
        config = replace(config, mode="assist")
    return ChatRouter(
        config=config,
        engine=engine,
        mcp_client=_StubMCPClient(),
        context_builder=ContextBuilder(None),
    )


def _spy_overlay(monkeypatch: Any) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    def spy(_runtime_system_messages: list[str], **kwargs: Any) -> None:
        calls.append(kwargs)

    monkeypatch.setattr(
        "sidecar.ai.routing.chat_decision."
        "append_session_environment_runtime_system_message",
        spy,
    )
    return calls


def _run_turn(*, request_context: ChatRequestContext) -> None:
    engine = _StubEngine(GenerationResult(content="hi", finish_reason="stop"))
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"), engine=engine
    )
    router.build_chat_decision(
        request_context=request_context,
        request_id=request_context.request_id,
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
    )


def test_wiring_invokes_overlay_with_tool_schemas_for_depth_zero(monkeypatch: Any) -> None:
    calls = _spy_overlay(monkeypatch)
    _run_turn(
        request_context=ChatRequestContext(
            request_id="req-env-depth-0",
            trace_id=None,
            session_id="session-env-depth-0",
            mode="chat",
            approvals_pre_granted=True,
            agent_depth=0,
        )
    )
    assert len(calls) == 1
    assert "tool_schemas" in calls[0]
    assert isinstance(calls[0]["tool_schemas"], list)
    assert calls[0]["session_id"] == "session-env-depth-0"


def test_wiring_invokes_overlay_for_sub_agent_turn(monkeypatch: Any) -> None:
    calls = _spy_overlay(monkeypatch)
    _run_turn(
        request_context=ChatRequestContext(
            request_id="req-env-depth-1",
            trace_id=None,
            session_id="session-env-depth-1",
            mode="chat",
            approvals_pre_granted=True,
            agent_depth=1,
        )
    )
    assert len(calls) == 1


def test_wiring_invokes_overlay_when_session_id_is_empty(monkeypatch: Any) -> None:
    calls = _spy_overlay(monkeypatch)
    _run_turn(
        request_context=ChatRequestContext(
            request_id="req-env-no-session",
            trace_id=None,
            session_id=None,
            mode="chat",
            approvals_pre_granted=True,
            agent_depth=0,
        )
    )
    assert len(calls) == 1
