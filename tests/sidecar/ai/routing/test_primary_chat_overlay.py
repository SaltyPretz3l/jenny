"""The ``## Primary Chat`` runtime overlay (row 69 W3).

Rendered only for a request that carries ``session_role: "primary"``; static
text, so the leading prompt stays byte-identical from turn to turn.
"""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context import turn_context as tc
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.context.primary_chat_overlay import (
    PRIMARY_CHAT_OVERLAY,
    build_primary_chat_overlay,
)
from sidecar.ai.context.prompt_modes import append_mode_runtime_overlays
from sidecar.ai.context.runtime_message_markers import (
    PRIMARY_CHAT_OVERLAY_HEADING,
    RUNTIME_SYSTEM_MESSAGE_HEADINGS,
)
from sidecar.ai.routing.router import ChatRouter
from sidecar.ai.tools.models import GenerationResult
from sidecar.runtime.chat_models import ChatRequestContext


class _CapturingEngine:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
        self.calls.append(kwargs)
        return GenerationResult(content="ok", finish_reason="stop")

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

    def execute_tool(self, *_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("no tool calls are expected in this test")


def _model_facing(
    *, session_role: str | None, user_text: str = "hello", engine_type: str = "mock"
) -> list[dict[str, object]]:
    model = "gpt-5.6-sol" if engine_type == "chatgpt" else "mock-v1"
    config = replace(
        RuntimeConfig(engine_type=engine_type, model=model),
        tools_workspace_root="C:/workspace",
        mode="assist",
    )
    engine = _CapturingEngine()
    router = ChatRouter(
        config=config,
        engine=engine,
        mcp_client=_StubMCPClient(),
        context_builder=ContextBuilder(None),
    )
    router.build_chat_decision(
        request_context=ChatRequestContext(
            request_id="req-primary",
            trace_id=None,
            session_id="session-primary",
            mode="chat",
            approvals_pre_granted=True,
            session_role=session_role,
        ),
        request_id="req-primary",
        messages=[{"role": "user", "content": user_text}],
        latest_user_content=user_text,
        mode="chat",
        approvals_pre_granted=True,
    )
    assert engine.calls, "the stub engine was never asked to generate"
    return list(engine.calls[0]["messages"])


def _overlay_rows(messages: list[dict[str, object]]) -> list[int]:
    return [
        index
        for index, message in enumerate(messages)
        if str(message.get("content") or "").startswith(PRIMARY_CHAT_OVERLAY_HEADING)
    ]


def test_ordinary_requests_get_no_overlay() -> None:
    assert build_primary_chat_overlay(SimpleNamespace()) == []
    assert build_primary_chat_overlay(SimpleNamespace(session_role=None)) == []
    assert build_primary_chat_overlay(SimpleNamespace(session_role="other")) == []
    child = SimpleNamespace(session_role="primary", agent_surface="sub_agent")
    assert build_primary_chat_overlay(child) == [], "a sub-agent turn is not the primary chat"
    assert _overlay_rows(_model_facing(session_role=None)) == []


def test_the_overlay_is_static_registered_and_bounded() -> None:
    [overlay] = build_primary_chat_overlay(SimpleNamespace(session_role="primary"))
    assert overlay == PRIMARY_CHAT_OVERLAY
    assert overlay.startswith(PRIMARY_CHAT_OVERLAY_HEADING + "\n")
    assert PRIMARY_CHAT_OVERLAY_HEADING == "## Primary Chat"
    assert PRIMARY_CHAT_OVERLAY_HEADING in RUNTIME_SYSTEM_MESSAGE_HEADINGS
    assert PRIMARY_CHAT_OVERLAY_HEADING not in tc.TRAILING_RUNTIME_HEADINGS
    assert 900 <= len(overlay) <= 1700, len(overlay)
    for tool in ("sessions_list", "session_status", "session_transcript", "conversations_search", "propose_session",
                 "session_message", "session_stop", "jenny_help", "## Profile Overview"):
        assert tool in overlay, tool
    assert not any(char.isdigit() for char in overlay), "no per-turn values in a static overlay"


def test_append_mode_runtime_overlays_renders_it_once_and_first() -> None:
    overlays: list[str] = []
    append_mode_runtime_overlays(
        overlays, request_context=SimpleNamespace(session_role="primary", plan_mode=True)
    )
    assert overlays[0] == PRIMARY_CHAT_OVERLAY
    assert sum(entry.startswith(PRIMARY_CHAT_OVERLAY_HEADING) for entry in overlays) == 1


def test_a_primary_turn_carries_the_overlay_exactly_once() -> None:
    messages = _model_facing(session_role="primary")
    [index] = _overlay_rows(messages)
    assert messages[index]["role"] == "system"
    assert messages[index]["content"] == PRIMARY_CHAT_OVERLAY


def test_the_overlay_is_present_on_the_minimal_chatgpt_profile() -> None:
    messages = _model_facing(session_role="primary", engine_type="chatgpt")
    [index] = _overlay_rows(messages)
    assert messages[index]["content"] == PRIMARY_CHAT_OVERLAY


@pytest.mark.parametrize("engine_type", ["ollama", "mock"])
def test_the_overlay_is_prefix_stable_across_turns(engine_type: str) -> None:
    first = _model_facing(session_role="primary", user_text="what was I working on?",
                          engine_type=engine_type)
    second = _model_facing(session_role="primary", user_text="and what is next for the docs?",
                           engine_type=engine_type)
    [first_index] = _overlay_rows(first)
    [second_index] = _overlay_rows(second)
    assert first_index == second_index
    assert first[first_index] == second[second_index]
    if engine_type == "ollama":
        # Local template engines keep per-turn text trailing, so the whole
        # leading run through the overlay is byte-identical.
        assert first[: first_index + 1] == second[: second_index + 1]
