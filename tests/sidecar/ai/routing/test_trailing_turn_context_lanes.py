"""Both chat lanes keep the leading prompt byte-stable across turns when the
trailing turn-context row is on, and carry the per-turn context before the
latest user message instead."""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context import turn_context as tc
from sidecar.ai.context.builder import ContextBuilder, SkillScope
from sidecar.ai.routing.router import ChatRouter
from sidecar.ai.tools.models import GenerationResult
from sidecar.runtime.chat_models import ChatRequestContext
from sidecar.runtime.chat_streaming import build_live_streaming_chat_response

_ACTIVE_FILE = {"kind": "active_file", "content": "## Active File\nsrc/app.py"}
_PERSONALITY = {"kind": "personality", "content": "Warm and brief."}


class _CapturingEngine:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
        self.calls.append(kwargs)
        return GenerationResult(content="done", finish_reason="stop")

    def stream(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        yield SimpleNamespace(kind="content", text="done")
        yield SimpleNamespace(kind="done", text="", finish_reason="stop")

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


@pytest.fixture(params=["0", "1"], ids=["flag-off", "flag-on"])
def flag(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> bool:
    monkeypatch.setenv(tc.TRAILING_TURN_CONTEXT_FLAG, request.param)
    return request.param == "1"


def _turns() -> list[list[dict[str, object]]]:
    first: list[dict[str, object]] = [{"role": "user", "content": "Use the git tool worktree_list."}]
    second = [
        *first,
        {"role": "assistant", "content": "done"},
        {"role": "user", "content": "What is the weather in Paris today?"},
    ]
    return [first, second]


def _router_turn(
    engine: _CapturingEngine,
    messages: list[dict[str, object]],
    index: int,
    *,
    builder: ContextBuilder | None = None,
    skill_invocation: dict[str, str] | None = None,
) -> None:
    config = replace(
        RuntimeConfig(engine_type="openai-compatible", model="ornith"),
        tools_workspace_root="C:/workspace",
        mode="assist",
        skills_auto_index="off",
    )
    router = ChatRouter(
        config=config,
        engine=engine,
        mcp_client=_NoTools(),
        context_builder=builder or ContextBuilder(None),
    )
    router.build_chat_decision(
        request_context=ChatRequestContext(
            request_id=f"req-{index}",
            trace_id=None,
            session_id="session-trailing",
            mode="assist",
            approvals_pre_granted=True,
            context_blocks=(_PERSONALITY, _ACTIVE_FILE),
            skill_invocation=skill_invocation,
        ),
        request_id=f"req-{index}",
        messages=messages,
        latest_user_content=str(messages[-1]["content"]),
        mode="assist",
        approvals_pre_granted=True,
    )


def _live_turn(
    engine: _CapturingEngine,
    messages: list[dict[str, object]],
    index: int,
    *,
    builder: ContextBuilder | None = None,
    skill_invocation: dict[str, str] | None = None,
) -> None:
    config = SimpleNamespace(
        mode="chat",
        engine_type="openai-compatible",
        model="ornith",
        feature_flags={},
        system_prompt="System prompt for testing.",
        max_tokens=4096,
        tools_workspace_manifest_enabled=False,
        tools_task_capsule_enabled=False,
        skills_auto_index="off",
    )
    stack = SimpleNamespace(
        config=config,
        engine=engine,
        context_builder=builder or ContextBuilder(None),
        memory_store=None,
        turn_diagnostics=None,
    )
    build_live_streaming_chat_response(
        request_id=f"live-{index}",
        trace_id=None,
        session_id="session-live-trailing",
        latest_user_content=str(messages[-1]["content"]),
        messages=messages,
        brain_container=SimpleNamespace(stack=stack),
        reasoning_effort=None,
        learned_lessons=None,
        max_tokens=256,
        context_blocks=(_PERSONALITY, _ACTIVE_FILE),
        skill_invocation=skill_invocation,
    )


def _leading(call: dict[str, Any]) -> tuple[str, list[str]]:
    """The system text plus every message row ahead of the conversation."""
    rows = []
    for message in call["messages"]:
        content = str(message["content"])
        # The live lane hands rows over before the engine demotes them.
        if message["role"] != "system" or content.startswith(tc.TURN_CONTEXT_HEADER):
            break
        rows.append(content)
    return str(call.get("system") or ""), rows


@pytest.mark.parametrize("lane", [_router_turn, _live_turn], ids=["tool-loop", "live-chat"])
def test_leading_prompt_is_stable_across_turns(flag: bool, lane: Any) -> None:
    engine = _CapturingEngine()
    for index, messages in enumerate(_turns()):
        lane(engine, messages, index)

    first, second = engine.calls[0], engine.calls[-1]
    rows = [str(message["content"]) for message in second["messages"]]
    leading_first, leading_second = _leading(first), _leading(second)
    if not flag:
        # Today's layout: the active file rides the leading system tier.
        assert any("src/app.py" in row for row in leading_second[1]) or (
            "src/app.py" in leading_second[0]
        )
        return
    assert leading_first == leading_second
    assert all("src/app.py" not in row for row in [leading_second[0], *leading_second[1]])
    row_index = next(
        i for i, row in enumerate(rows) if row.startswith(tc.TURN_CONTEXT_HEADER)
    )
    # Right before the user's question; loop nudges may append after it.
    assert rows[row_index + 1] == "What is the weather in Paris today?"
    context_row = second["messages"][row_index]
    assert "src/app.py" in str(context_row["content"])
    assert tc.TURN_CONTEXT_BASE_KEY not in context_row
    # The previous turn's row is not replayed; history is untouched otherwise.
    assert sum(str(row).startswith(tc.TURN_CONTEXT_HEADER) for row in rows) == 1


def _skill_builder(tmp_path: Any) -> ContextBuilder:
    skill_dir = tmp_path / "bundled" / "insight"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: Harness Insight\ncommand: insight\n---\nReview the harness.",
        encoding="utf-8",
    )
    return ContextBuilder(
        None,
        skill_scopes=(SkillScope(scope="bundled", root=tmp_path / "bundled", enabled=True),),
        skills_system_enabled=True,
    )


@pytest.mark.parametrize("lane", [_router_turn, _live_turn], ids=["tool-loop", "live-chat"])
def test_invoked_skill_rides_the_turn_row_so_the_leading_prompt_survives_it(
    flag: bool, lane: Any, tmp_path: Any
) -> None:
    """A /skill turn and the plain turn after it share one leading run; the
    skill text sits in the skill turn's trailing row, right before its prompt."""
    builder = _skill_builder(tmp_path)
    engine = _CapturingEngine()
    first: list[dict[str, object]] = [{"role": "user", "content": "/insight please"}]
    second = [*first, {"role": "assistant", "content": "done"}, {"role": "user", "content": "thanks"}]
    lane(engine, first, 0, builder=builder, skill_invocation={"id": "bundled/insight"})
    lane(engine, second, 1, builder=builder)

    skill_call, next_call = engine.calls[0], engine.calls[-1]
    leading_skill, leading_next = _leading(skill_call), _leading(next_call)
    in_leading = any(
        "## Invoked Skill: Harness Insight" in text
        for text in [leading_skill[0], *leading_skill[1]]
    )
    if not flag:
        assert in_leading
        return
    assert not in_leading
    assert leading_skill == leading_next
    rows = [str(message["content"]) for message in skill_call["messages"]]
    row_index = next(i for i, row in enumerate(rows) if row.startswith(tc.TURN_CONTEXT_HEADER))
    assert "## Invoked Skill: Harness Insight" in rows[row_index]
    assert rows[row_index + 1] == "/insight please"
    assert all(
        "## Invoked Skill" not in str(message["content"]) for message in next_call["messages"]
    )
