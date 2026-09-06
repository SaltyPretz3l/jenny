from __future__ import annotations

import logging
from dataclasses import replace
from types import SimpleNamespace
from typing import Any

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder, SkillScope
from sidecar.ai.context.builder_shared import MAX_SKILL_FILE_BYTES
from sidecar.ai.routing.router import ChatRouter
from sidecar.ai.tools.models import GenerationResult
from sidecar.runtime.chat import _normalize_skill_invocation
from sidecar.runtime.chat_models import ChatRequestContext
from sidecar.runtime.chat_streaming import _build_live_stream_messages

SKILL_ID = "bundled/humanizer"


def _write_skill(tmp_path, *, body: str = "Keep facts intact."):
    root = tmp_path / "bundled"
    skill_dir = root / "humanizer"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: Humanizer\ncommand: humanize\n---\n{body}", encoding="utf-8"
    )
    return root


def _builder(tmp_path, *, disabled: bool = False, body: str = "Keep facts intact."):
    root = _write_skill(tmp_path, body=body)
    return ContextBuilder(
        None,
        skill_scopes=(SkillScope(scope="bundled", root=root, enabled=True),),
        disabled_skill_ids=(SKILL_ID,) if disabled else (),
        skills_system_enabled=True,
    )


def _config():
    return SimpleNamespace(
        engine_type="ollama",
        skills_auto_index="off",
        system_prompt="Base system prompt.",
        system_prompt_profile="full",
        assistant_name="Jenny",
        feature_flags={},
        max_tokens=1024,
        tools_workspace_manifest_enabled=False,
        tools_task_capsule_enabled=False,
    )


def _invoked(messages):
    return [
        message for message in messages
        if str(message.get("content", "")).startswith("## Invoked Skill:")
    ]


class _CapturingEngine:
    def __init__(self):
        self.calls: list[dict[str, Any]] = []

    def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
        self.calls.append(kwargs)
        return GenerationResult(content="ok", finish_reason="stop")

    def get_model_max_output_tokens(self):
        return None

    def get_model_context_length(self):
        return None


class _StubMCPClient:
    @property
    def available_tools(self):
        return []

    def tool_descriptor(self, _tool_name):
        return None


def test_valid_skill_is_injected_once_on_live_and_router_paths_and_not_next_request(tmp_path):
    builder = _builder(tmp_path)
    config = _config()
    engine = SimpleNamespace(
        capabilities={},
        get_model_context_length=lambda: 32768,
        get_model_max_output_tokens=lambda: 1024,
    )
    brain = SimpleNamespace(stack=SimpleNamespace(
        context_builder=builder, config=config, engine=engine,
        memory_service=None, memory_store=None, turn_diagnostics=None,
    ))

    live_messages = _build_live_stream_messages(
        brain, [{"role": "user", "content": "Polish this"}], None,
        latest_user_content="Polish this", request_id="req-live", session_id="session-1",
        skill_invocation={"id": SKILL_ID},
    )
    engine = _CapturingEngine()
    router = ChatRouter(
        config=replace(
            RuntimeConfig(engine_type="mock", model="mock-v1"),
            mode="assist", skills_auto_index="off", tools_workspace_root="C:/workspace",
        ),
        engine=engine,
        mcp_client=_StubMCPClient(),
        context_builder=builder,
    )
    for request_id, invocation in (("req-router", {"id": SKILL_ID}), ("req-next", None)):
        request_context = ChatRequestContext(
            request_id=request_id, trace_id=None, session_id="session-1", mode="chat",
            approvals_pre_granted=True, skill_invocation=invocation,
        )
        router.build_chat_decision(
            request_context=request_context,
            request_id=request_id,
            messages=[{"role": "user", "content": "Polish this"}],
            latest_user_content="Polish this",
            mode="chat",
            approvals_pre_granted=True,
        )
    router_messages = engine.calls[0]["messages"]
    next_request_messages = engine.calls[1]["messages"]

    assert len(_invoked(live_messages)) == 1
    assert len(_invoked(router_messages)) == 1
    assert _invoked(next_request_messages) == []
    assert all("## Available Skills" not in str(message.get("content", "")) for message in live_messages)


def test_disabled_skill_is_omitted_and_warned(caplog, tmp_path):
    builder = _builder(tmp_path, disabled=True)
    with caplog.at_level(logging.WARNING):
        message = builder.build_invoked_skill_system_message({"id": SKILL_ID})

    assert message == ""
    assert any(record.event == "ai.context.skill_invocation_unresolved" for record in caplog.records)


def test_malformed_skill_invocation_is_ignored_and_logged(caplog):
    with caplog.at_level(logging.INFO):
        normalized = _normalize_skill_invocation(
            {"id": "bundled/../escape"}, request_id="req-bad", session_id="session-bad"
        )

    assert normalized is None
    assert sum(record.event == "ai.skills.invocation_rejected" for record in caplog.records) == 1


def test_invoked_skill_message_is_bounded_by_skill_file_limit(tmp_path):
    builder = _builder(tmp_path, body="x" * (MAX_SKILL_FILE_BYTES - 100))
    message = builder.build_invoked_skill_system_message({"id": SKILL_ID})

    assert message.startswith("## Invoked Skill: Humanizer\n")
    assert len(message.encode("utf-8")) <= MAX_SKILL_FILE_BYTES
