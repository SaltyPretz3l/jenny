"""Prompt recall admits the chat's own chat-scope rows (row 58 W1, Astra finding 6)."""

from __future__ import annotations

import logging
from pathlib import Path

from sidecar.ai.context.runtime_overlays import (
    RuntimeOverlayLogContext,
    build_prompt_memory_recall_system_message,
)
from sidecar.ai.memory.contracts import MemoryPolicy
from sidecar.ai.memory.store import MemoryStore

PROJECT = "project_alpha"
SESSION = "sess-1"


class _CapturingBuilder:
    def __init__(self) -> None:
        self.seen: list[str] = []

    def build_memory_recall_system_message(self, memories: list[object]) -> str:
        self.seen = [str(getattr(memory, "lesson_text", "")) for memory in memories]
        return "## Recalled Memories" if memories else ""


def _recall(store: MemoryStore, session_id: str | None) -> list[str]:
    builder = _CapturingBuilder()
    build_prompt_memory_recall_system_message(
        context_builder=builder,  # type: ignore[arg-type]
        memory_store=store,
        latest_user_content="deploy convention for alpha",
        memory_policy=MemoryPolicy(project_id=PROJECT),
        log_context=RuntimeOverlayLogContext(
            logger=logging.getLogger(__name__),
            component="test.memory",
            event="test.memory.recall",
            request_id="req-1",
            session_id=session_id,
        ),
        session_id=session_id,
    )
    return sorted(builder.seen)


def test_prompt_recall_sees_this_chats_notes_and_never_another_chats(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        for text, scope in (
            ("Alpha deploy convention: Fridays", ""),
            ("This chat decided the alpha deploy waits", SESSION),
            ("Another chat decided the alpha deploy ships", "sess-other"),
        ):
            result = store.remember(
                operation_id=f"op:{scope or 'project'}", project_id=PROJECT, text=text, kind="decision",
                origin="jenny", session_id=scope or SESSION, scope_session_id=scope, always_on=False,
                source_message_ids=(),
            )
            assert result.status == "saved", result

        assert _recall(store, SESSION) == [
            "Alpha deploy convention: Fridays",
            "This chat decided the alpha deploy waits",
        ]
        assert _recall(store, None) == ["Alpha deploy convention: Fridays"]
    finally:
        store.close()


def test_prompt_overlay_renders_other_chat_recap_without_matching_memories(tmp_path: Path) -> None:
    from sidecar.ai.context.builder import ContextBuilder
    from sidecar.ai.memory.contracts import RecentChat
    from sidecar.ai.memory.store_shared import RECAP_PROVENANCE

    store = MemoryStore(tmp_path / "recap.db")
    try:
        store.remember(
            operation_id="seed:recap", project_id=PROJECT, session_id="earlier",
            scope_session_id="earlier", text="Earlier we discussed tea", kind="fact",
            origin="reflection", provenance=RECAP_PROVENANCE,
        )
        rendered = build_prompt_memory_recall_system_message(
            context_builder=ContextBuilder(tmp_path), memory_store=store,
            latest_user_content="heliotrope zebra",
            memory_policy=MemoryPolicy(project_id=PROJECT, recent_chats=(RecentChat("earlier", "Tea"),)),
            log_context=RuntimeOverlayLogContext(
                logger=logging.getLogger(__name__), component="test.memory", event="test.recall",
                request_id="req", session_id=SESSION,
            ), session_id=SESSION,
        )
        assert '"chat":"Tea"' in rendered
        assert '"recap":"Earlier we discussed tea"' in rendered
    finally:
        store.close()
