"""Wiring test: `build_chat_decision` invokes the model-identity overlay.

Unit coverage for the overlay render/append function itself lives in
`tests/sidecar/ai/context/test_runtime_overlays_model_identity.py`. This file
covers only the wiring -- that the real `ChatRouter.build_chat_decision` call
site in `sidecar/ai/routing/chat_decision.py` actually reaches
`append_model_identity_runtime_system_message` on every turn, including
sub-agent (depth > 0) turns and turns with no `session_id` -- unlike the
repo-delta overlay, model identity is not restricted to depth-0 turns because
each depth's request may in principle be served by a different engine.

Uses the same `_build_router`/`_StubEngine`/`_StubMCPClient` harness pattern
as `tests/sidecar/runtime/test_chat_repo_delta.py` section C.
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


def _spy_model_identity_overlay(monkeypatch: Any) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    def spy(_runtime_system_messages: list[str], **kwargs: Any) -> None:
        calls.append(kwargs)

    monkeypatch.setattr(
        "sidecar.ai.routing.chat_decision.append_model_identity_runtime_system_message",
        spy,
    )
    return calls


def _run_turn(*, config: RuntimeConfig, request_context: ChatRequestContext) -> None:
    engine = _StubEngine(GenerationResult(content="hi", finish_reason="stop"))
    router = _build_router(config=config, engine=engine)
    router.build_chat_decision(
        request_context=request_context,
        request_id=request_context.request_id,
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
    )


def test_build_chat_decision_invokes_model_identity_overlay_for_depth_zero_turn(
    monkeypatch: Any,
) -> None:
    calls = _spy_model_identity_overlay(monkeypatch)
    _run_turn(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        request_context=ChatRequestContext(
            request_id="req-identity-depth-0",
            trace_id=None,
            session_id="session-identity-depth-0",
            mode="chat",
            approvals_pre_granted=True,
            agent_depth=0,
        ),
    )

    assert len(calls) == 1
    assert calls[0]["config"].engine_type == "mock"


def test_build_chat_decision_invokes_model_identity_overlay_for_sub_agent_turn(
    monkeypatch: Any,
) -> None:
    """Unlike the repo-delta overlay, model identity is NOT depth-restricted."""
    calls = _spy_model_identity_overlay(monkeypatch)
    _run_turn(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        request_context=ChatRequestContext(
            request_id="req-identity-depth-1",
            trace_id=None,
            session_id="session-identity-depth-1",
            mode="chat",
            approvals_pre_granted=True,
            agent_depth=1,
        ),
    )

    assert len(calls) == 1


def test_build_chat_decision_invokes_model_identity_overlay_when_session_id_is_empty(
    monkeypatch: Any,
) -> None:
    calls = _spy_model_identity_overlay(monkeypatch)
    _run_turn(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        request_context=ChatRequestContext(
            request_id="req-identity-no-session",
            trace_id=None,
            session_id=None,
            mode="chat",
            approvals_pre_granted=True,
            agent_depth=0,
        ),
    )

    assert len(calls) == 1
