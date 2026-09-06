"""Wiring test: ``build_chat_decision`` invokes the interrupted-turn overlay.

Unit coverage for the overlay render/append function itself lives in
``tests/sidecar/ai/context/test_runtime_overlays_interrupted_turn.py``. This
file covers only the wiring -- that the real ``ChatRouter.build_chat_decision``
call site in ``sidecar/ai/routing/chat_decision.py`` reaches
``append_interrupted_turn_receipts_runtime_system_message`` on a depth-0 turn
with a session_id and forwards the request-context receipts, and that (like the
repo-delta overlay, and unlike model identity) it is NOT invoked on sub-agent
(depth > 0) turns nor on turns with no session_id.

Uses the same ``_build_router``/``_StubEngine``/``_StubMCPClient`` harness
pattern as ``test_chat_decision_model_identity.py``.
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


def _spy_interrupted_overlay(monkeypatch: Any) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    def spy(_runtime_system_messages: list[str], **kwargs: Any) -> None:
        calls.append(kwargs)

    monkeypatch.setattr(
        "sidecar.ai.routing.chat_decision."
        "append_interrupted_turn_receipts_runtime_system_message",
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


def test_depth_zero_turn_forwards_receipts_to_overlay(monkeypatch: Any) -> None:
    calls = _spy_interrupted_overlay(monkeypatch)
    receipts = {"completed": [{"tool_name": "read_file", "summary": "ok"}], "total": 1}
    _run_turn(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        request_context=ChatRequestContext(
            request_id="req-interrupted-depth-0",
            trace_id=None,
            session_id="session-interrupted-depth-0",
            mode="chat",
            approvals_pre_granted=True,
            agent_depth=0,
            interrupted_turn_receipts=receipts,
        ),
    )
    assert len(calls) == 1
    assert calls[0]["receipts"] == receipts


def test_depth_zero_turn_threads_mcp_client_to_overlay(monkeypatch: Any) -> None:
    """W8-S3: the call site hands the overlay its liveness source (the MCP
    client), so dead-generation ledger pendings can be merged in production."""
    calls = _spy_interrupted_overlay(monkeypatch)
    engine = _StubEngine(GenerationResult(content="hi", finish_reason="stop"))
    router = _build_router(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"), engine=engine
    )
    router.build_chat_decision(
        request_context=ChatRequestContext(
            request_id="req-interrupted-mcp-thread",
            trace_id=None,
            session_id="session-interrupted-mcp-thread",
            mode="chat",
            approvals_pre_granted=True,
            agent_depth=0,
            interrupted_turn_receipts=None,
        ),
        request_id="req-interrupted-mcp-thread",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
    )
    assert len(calls) == 1
    assert calls[0]["mcp_client"] is router._mcp_client  # noqa: SLF001


def test_sub_agent_turn_does_not_invoke_overlay(monkeypatch: Any) -> None:
    """Like repo-delta, the receipts overlay is depth-0 only."""
    calls = _spy_interrupted_overlay(monkeypatch)
    _run_turn(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        request_context=ChatRequestContext(
            request_id="req-interrupted-depth-1",
            trace_id=None,
            session_id="session-interrupted-depth-1",
            mode="chat",
            approvals_pre_granted=True,
            agent_depth=1,
            interrupted_turn_receipts={"completed": [], "total": 0},
        ),
    )
    assert calls == []


def test_turn_with_no_session_id_does_not_invoke_overlay(monkeypatch: Any) -> None:
    calls = _spy_interrupted_overlay(monkeypatch)
    _run_turn(
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        request_context=ChatRequestContext(
            request_id="req-interrupted-no-session",
            trace_id=None,
            session_id=None,
            mode="chat",
            approvals_pre_granted=True,
            agent_depth=0,
            interrupted_turn_receipts={"completed": [], "total": 0},
        ),
    )
    assert calls == []
