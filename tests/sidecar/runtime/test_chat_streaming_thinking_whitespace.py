from __future__ import annotations

from types import SimpleNamespace

import pytest

from sidecar.ai.context.builder import ContextBuilder
from sidecar.protocol import CHAT_THINKING_KIND_REASONING, CHAT_THINKING_METHOD
from sidecar.runtime.chat_streaming import build_live_streaming_chat_response


class _ThinkingSequenceEngine:
    def __init__(self, deltas: list[str]) -> None:
        self._deltas = deltas

    def stream(self, **_kwargs: object):
        for delta in self._deltas:
            yield SimpleNamespace(kind="thinking", text=delta)
        yield SimpleNamespace(kind="done", text="")

    def get_model_context_length(self) -> int | None:
        return None

    def get_model_max_output_tokens(self) -> int | None:
        return None


def _context_builder() -> object:
    real = ContextBuilder(None)

    class _ContextBuilder:
        def build_system_prompt(self, system_prompt: str, **_kwargs: object) -> str:
            return system_prompt

        def build_skills_system_message(self, *, tool_statuses: object = None) -> str:
            return ""

        def build_memory_recall_system_message(
            self, recalled_memories: object = None
        ) -> str:
            return ""

        def build_context_pressure_advisory(self, budget_status: object) -> str:
            return real.build_context_pressure_advisory(budget_status)

        def insert_runtime_system_messages(
            self,
            working_messages: list[dict[str, object]],
            runtime_messages: list[str] | tuple[str, ...],
        ) -> list[dict[str, object]]:
            return real.insert_runtime_system_messages(working_messages, runtime_messages)

        def workspace_status(self) -> object:
            return SimpleNamespace(
                root=None,
                exists=False,
                skills_loaded=0,
                bootstrap_loaded=0,
                instruction_file_name=None,
                instruction_file_present=False,
            )

    return _ContextBuilder()


def _reasoning_deltas(deltas: list[str]) -> list[str]:
    engine = _ThinkingSequenceEngine(deltas)
    stack = SimpleNamespace(
        config=SimpleNamespace(
            mode="chat",
            engine_type="stub",
            model="stub-model",
            feature_flags={},
            system_prompt="System prompt for testing.",
            max_tokens=4096,
            tools_workspace_manifest_enabled=False,
            tools_task_capsule_enabled=False,
        ),
        engine=engine,
        context_builder=_context_builder(),
        memory_store=None,
        turn_diagnostics=None,
    )
    response = build_live_streaming_chat_response(
        request_id="req-thinking-whitespace",
        trace_id=None,
        session_id=None,
        latest_user_content="hello",
        messages=[],
        brain_container=SimpleNamespace(stack=stack),
        reasoning_effort=None,
        learned_lessons=None,
        max_tokens=4096,
    )
    return [
        item["params"]["delta"]
        for item in response.notifications
        if item.get("method") == CHAT_THINKING_METHOD
        and item["params"].get("kind") == CHAT_THINKING_KIND_REASONING
    ]


@pytest.mark.parametrize(
    ("deltas", "expected"),
    [
        (["Real", "\n\n", "thinking."], ["Real", "\n\n", "thinking."]),
        (["   ", "Real"], ["Real"]),
        (["   "], []),
    ],
)
def test_chat_thinking_whitespace_fidelity(deltas: list[str], expected: list[str]) -> None:
    assert _reasoning_deltas(deltas) == expected
