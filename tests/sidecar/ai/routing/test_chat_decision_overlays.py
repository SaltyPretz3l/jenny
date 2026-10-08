"""Memory-recall overlay behaviour on the routed lane.

Ported from the retired plain-chat live-stream lane: the routed
``ChatRouter.build_chat_decision`` path now assembles these rows for every
mode, so the same guarantees are pinned here through the production call site.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.feature_flags import FEATURE_TOKEN_BUDGET
from sidecar.ai.memory.contracts import GENERAL_PROJECT_ID, MemoryPolicy
from sidecar.ai.memory.store import ApprovedMemory
from sidecar.ai.routing.router import ChatRouter
from sidecar.ai.tools.models import GenerationResult
from sidecar.runtime.chat_models import ChatRequestContext


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


class _RecallStore:
    def __init__(self) -> None:
        self.calls = 0

    def recall_memories(
        self,
        query: str,
        *,
        limit: int,
        project_id: str,
        include_general: bool = False,
    ) -> list[ApprovedMemory]:
        _ = (limit, include_general)
        self.calls += 1
        assert project_id == GENERAL_PROJECT_ID
        if query != "tea":
            return []
        return [
            ApprovedMemory(
                id=1,
                session_id="session",
                title="Tea routine",
                lesson_text="The user likes green tea in the afternoon.",
                confidence=0.9,
                lesson_kind="routine",
                source_excerpt="",
                content_fingerprint=f"sha256:{1:064x}",
                family_key="",
                provenance="user_approved",
                created_at="2026-01-01T00:00:00+00:00",
                updated_at="2026-01-01T00:00:00+00:00",
            )
        ]

    def get_recent_memories_by_kind(
        self,
        _kind: str,
        _limit: int,
        *,
        project_id: str,
        include_general: bool = False,
    ) -> list[ApprovedMemory]:
        _ = include_general
        self.calls += 1
        assert project_id == GENERAL_PROJECT_ID
        return []


def _routed_messages(
    *,
    builder: ContextBuilder,
    config: RuntimeConfig,
    memory_store: Any | None = None,
    memory_policy: MemoryPolicy | None = None,
    latest_user_content: str = "tea",
) -> list[dict[str, Any]]:
    engine = _CapturingEngine()
    router = ChatRouter(
        config=replace(config, tools_workspace_root="C:/workspace", mode="assist"),
        engine=engine,
        mcp_client=_NoTools(),
        context_builder=builder,
        memory_store=memory_store,
    )
    router.build_chat_decision(
        request_context=ChatRequestContext(
            request_id="req-overlays",
            trace_id=None,
            session_id="session-overlays",
            mode="chat",
            approvals_pre_granted=True,
            memory_policy=memory_policy,
        ),
        request_id="req-overlays",
        messages=[{"role": "user", "content": latest_user_content}],
        latest_user_content=latest_user_content,
        mode="chat",
        approvals_pre_granted=True,
    )
    assert engine.calls, "the stub engine was never asked to generate"
    return list(engine.calls[0]["messages"])


def _system_headings(messages: list[dict[str, Any]]) -> list[str]:
    return [
        str(message.get("content") or "").splitlines()[0]
        for message in messages
        if message.get("role") == "system" and str(message.get("content") or "").strip()
    ]


def test_routed_memory_overlay_stays_within_the_shared_recall_budget() -> None:
    messages = _routed_messages(
        builder=ContextBuilder(None),
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            context_length=8208,
            max_tokens=1,
            feature_flags={FEATURE_TOKEN_BUDGET: True},
        ),
        memory_store=_RecallStore(),
        memory_policy=MemoryPolicy(recall_query="tea"),
    )

    headings = _system_headings(messages)
    assert "## Recalled Memories" in headings
    assert "## Context Pressure Advisory" not in headings


def test_routed_memory_opt_out_never_touches_the_store() -> None:
    store = _RecallStore()

    messages = _routed_messages(
        builder=ContextBuilder(None),
        config=RuntimeConfig(engine_type="mock", model="mock-v1"),
        memory_store=store,
        memory_policy=MemoryPolicy(enabled=False, recall_query="tea"),
    )

    assert store.calls == 0
    assert all("## Recalled Memories" not in str(row.get("content")) for row in messages)
