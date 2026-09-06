from __future__ import annotations

from types import SimpleNamespace

import pytest

from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.feature_flags import FEATURE_TOKEN_BUDGET
from sidecar.runtime import chat_streaming


def test_live_stream_runtime_reinsertion_preserves_plugin_overlay(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plugin_overlay = "## Plugin Runtime Overlay\nplugin authority"
    memory_overlay = "## Recalled Memories\nremember this"
    advisory = "## Context Pressure Advisory\ncontext is tight"
    insertion_passes: list[tuple[str, ...]] = []
    real_builder = ContextBuilder(None)

    class _ContextBuilder:
        def build_system_prompt(self, system_prompt: str, **_kwargs: object) -> str:
            return system_prompt

        def insert_runtime_system_messages(
            self,
            working_messages: list[dict[str, object]],
            runtime_messages: list[str] | tuple[str, ...],
        ) -> list[dict[str, object]]:
            insertion_passes.append(tuple(runtime_messages))
            return real_builder.insert_runtime_system_messages(working_messages, runtime_messages)

        def build_context_pressure_advisory(self, _status: object) -> str:
            return advisory

    config = SimpleNamespace(
        engine_type="ollama",
        system_prompt_profile="full",
        system_prompt="system prompt",
        feature_flags={FEATURE_TOKEN_BUDGET: True},
        tools_workspace_manifest_enabled=False,
        tools_task_capsule_enabled=False,
        max_tokens=256,
        assistant_name="Jenny",
    )
    engine = SimpleNamespace(
        get_model_context_length=lambda: 4096,
        get_model_max_output_tokens=lambda: 256,
    )
    brain = SimpleNamespace(
        stack=SimpleNamespace(
            context_builder=_ContextBuilder(),
            config=config,
            engine=engine,
            memory_service=None,
            turn_diagnostics=None,
        )
    )
    monkeypatch.setattr(
        chat_streaming,
        "build_dynamic_system_messages",
        lambda **_kwargs: [{"role": "system", "content": plugin_overlay}],
    )
    monkeypatch.setattr(
        chat_streaming,
        "build_prompt_memory_recall_system_message",
        lambda **_kwargs: memory_overlay,
    )
    monkeypatch.setattr(chat_streaming, "check_budget", lambda *_args, **_kwargs: object())
    monkeypatch.setattr(
        chat_streaming,
        "compact_semantic_messages_with_budget",
        lambda messages, **_kwargs: list(messages),
    )

    result = chat_streaming._build_live_stream_messages(
        brain,
        [{"role": "user", "content": "hello"}],
        learned_lessons=None,
        latest_user_content="hello",
        request_id="req_plugin_overlay",
        session_id="sess_test",
    )

    assert len(insertion_passes) == 2
    assert plugin_overlay in insertion_passes[0]
    assert plugin_overlay in insertion_passes[1]
    assert advisory in insertion_passes[1]
    system_contents = [
        str(message["content"]) for message in result if message.get("role") == "system"
    ]
    assert plugin_overlay in system_contents
