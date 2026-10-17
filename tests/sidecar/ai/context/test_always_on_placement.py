"""Where the routed lane places ``## Always-on memories`` (production call site)."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.always_on_memories import ALWAYS_ON_HEADING, is_always_on_system_message
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.context.turn_context import TURN_CONTEXT_HEADING
from sidecar.ai.memory.contracts import GENERAL_PROJECT_ID, MemoryPolicy
from sidecar.ai.memory.service import MemoryService
from sidecar.ai.memory.store import MemoryStore
from sidecar.ai.personality import PERSONALITY_HEADING
from sidecar.ai.routing.router import ChatRouter
from sidecar.ai.tools.models import GenerationResult
from sidecar.runtime.chat_models import ChatRequestContext

SECTIONS = "### Voice\n\nWarm and direct."
GIT_MARKER = "GIT-BLOCK-MARKER"


class _CapturingEngine:
    capabilities: dict[str, object] = {}

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
        self.calls.append(kwargs)
        return GenerationResult(content="ok", finish_reason="stop")

    def get_model_max_output_tokens(self) -> int | None:
        return None

    def get_model_context_length(self) -> int | None:
        return None


class _NoTools:
    available_tools: list[Any] = []

    def tool_descriptor(self, _tool_name: str) -> Any | None:
        return None

    def execute_tool(self, *_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("no tool calls are expected")


@pytest.fixture
def service(tmp_path: Path) -> Any:
    memory = MemoryService(MemoryStore(tmp_path / "memory.db"))
    result = memory.store_compat.remember(
        operation_id="op-placement-1", project_id=GENERAL_PROJECT_ID, text="Uses metric units.",
        kind="preference", origin="user", session_id="s", always_on=True,
    )
    assert result.status == "saved"
    yield memory
    memory.close()


def _routed(
    service: Any,
    *,
    engine_type: str,
    with_personality: bool,
    policy: MemoryPolicy | None = None,
) -> list[dict[str, Any]]:
    engine = _CapturingEngine()
    router = ChatRouter(
        config=replace(
            RuntimeConfig(engine_type=engine_type, model="m"),
            tools_workspace_root="C:/workspace", mode="assist",
        ),
        engine=engine,
        mcp_client=_NoTools(),
        context_builder=ContextBuilder(None),
        memory_store=service,
    )
    blocks: list[dict[str, str]] = [{"kind": "git", "content": GIT_MARKER}]
    if with_personality:
        blocks.insert(0, {"kind": "personality", "content": SECTIONS})
    router.build_chat_decision(
        request_context=ChatRequestContext(
            request_id="req-always-on",
            trace_id=None,
            session_id="session-always-on",
            mode="chat",
            approvals_pre_granted=True,
            memory_policy=policy or MemoryPolicy(),
            context_blocks=tuple(blocks),
        ),
        request_id="req-always-on",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
    )
    assert engine.calls, "the stub engine was never asked to generate"
    return list(engine.calls[0]["messages"])


def _contents(messages: list[dict[str, Any]]) -> list[str]:
    return [str(message.get("content") or "") for message in messages]


@pytest.mark.parametrize("engine_type", ["ollama", "mock"])
def test_section_sits_right_after_the_personality_row(service: Any, engine_type: str) -> None:
    contents = _contents(_routed(service, engine_type=engine_type, with_personality=True))

    personality = [i for i, text in enumerate(contents) if text.startswith(PERSONALITY_HEADING)]
    always_on = [i for i, text in enumerate(contents) if is_always_on_system_message(text)]
    assert len(personality) == 1 and len(always_on) == 1
    assert always_on[0] == personality[0] + 1
    assert "- [preference] Uses metric units." in contents[always_on[0]]


def test_section_is_never_folded_into_the_trailing_turn_context_row(service: Any) -> None:
    contents = _contents(_routed(service, engine_type="ollama", with_personality=True))

    trailing = [text for text in contents if text.startswith(TURN_CONTEXT_HEADING)]
    assert trailing and all(ALWAYS_ON_HEADING not in text for text in trailing)
    assert sum(ALWAYS_ON_HEADING in text for text in contents) == 1


def test_chatgpt_lane_without_personality_still_gets_the_section_first(service: Any) -> None:
    messages = _routed(service, engine_type="chatgpt", with_personality=True)
    contents = _contents(messages)

    assert not any(text.startswith(PERSONALITY_HEADING) for text in contents)
    always_on = [i for i, text in enumerate(contents) if is_always_on_system_message(text)]
    git = [i for i, text in enumerate(contents) if GIT_MARKER in text]
    assert len(always_on) == 1 and messages[always_on[0]]["role"] == "system"
    assert git and always_on[0] < git[0]


def test_recall_off_drops_the_section(service: Any) -> None:
    contents = _contents(
        _routed(service, engine_type="mock", with_personality=True,
                policy=MemoryPolicy(recall=False))
    )

    assert all(ALWAYS_ON_HEADING not in text for text in contents)
