"""Shared harness for the scripted mock-engine memory scenarios (row 58 W4).

A :class:`ScenarioStack` owns a real ``MemoryStore`` on a temp path, the
``MemoryService`` the container builds for it, a scripted engine for
``memory.reflect`` (no model) and an enabled conversation index. Every call
goes through the sidecar's real JSON-RPC dispatcher
(``request_dispatch.process_message``); only the chat path's prompt recall,
which has no RPC of its own, calls ``MemoryService`` directly, exactly as
``runtime_overlays.build_prompt_memory_recall_system_message`` does.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import logging
from collections.abc import Sequence
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.memory.contracts import MemoryPolicy, RecentChat
from sidecar.ai.memory.service import MemoryService
from sidecar.ai.memory.store import MemoryStore
from sidecar.protocol import (
    API_VERSION,
    CONVERSATIONS_INDEX_SESSION_METHOD,
    CONVERSATIONS_SEARCH_METHOD,
    MEMORY_APPLY_METHOD,
    MEMORY_LIST_METHOD,
    MEMORY_RECALL_METHOD,
    MEMORY_REFLECT_METHOD,
    MEMORY_SAVE_METHOD,
)
from sidecar.runtime import request_dispatch
from tests.sidecar.ai.memory.memory_v9_helpers import WallClock

LOGGER = logging.getLogger("test.memory_scenarios")
PROJECT_A = "project_alpha"
PROJECT_B = "project_beta"
GENERAL = "project_general"
EPOCH_SOURCE = "electron-main"


class TickingClock(WallClock):
    """The store's wall clock: every read moves it 1 ms, so writes order strictly."""

    def __call__(self) -> datetime:
        self.now += timedelta(milliseconds=1)
        return self.now


def fingerprint(label: str) -> str:
    """A ``sha256:<64 hex>`` window fingerprint named by *label*."""

    return "sha256:" + hashlib.sha256(label.encode("utf-8")).hexdigest()


def item(text: str, *, source: int = 0, kind: str = "fact", scope: str = "project") -> dict[str, Any]:
    """One memory as the reflection model writes it."""

    return {"text": text, "kind": kind, "from": source, "scope": scope}


def model_output(*memories: dict[str, Any], recap: str = "", **extra: Any) -> str:
    return json.dumps({"memories": list(memories), "recap": recap, **extra})


def window(*turns: tuple[str, str], prefix: str = "m") -> list[dict[str, str]]:
    """A reflection window: ``(role, content)`` turns with ids ``m-1``, ``m-2``..."""

    return [
        {"id": f"{prefix}-{index}", "role": role, "content": content}
        for index, (role, content) in enumerate(turns, start=1)
    ]


class ScriptedEngine:
    """The reflection engine: answers each ``generate`` with the next scripted output."""

    def __init__(self) -> None:
        self.outputs: list[str] = []
        self.prompts: list[str] = []

    def script(self, *outputs: str) -> None:
        self.outputs.extend(outputs)

    def generate(self, **kwargs: Any) -> str:
        self.prompts.append(str(kwargs.get("prompt", "")))
        return self.outputs.pop(0)


class ScenarioStack:
    """One sidecar's memory stack on disk, driven through JSON-RPC."""

    def __init__(self, tmp_path: Path, *, hybrid: bool = False) -> None:
        self.db_path = tmp_path / "sidecar-memory.db"
        self.index_path = tmp_path / "conversation-index.db"
        self.clock = TickingClock()
        self.engine = ScriptedEngine()
        self.sent: list[dict[str, Any]] = []
        self._ids = itertools.count(1)
        self.store: MemoryStore | None = None
        self.open(hybrid=hybrid)

    # --- lifecycle ---------------------------------------------------------------

    def open(self, *, hybrid: bool = False) -> None:
        """Open the store and build the stack the way ``container.py`` does."""

        config = parse_runtime_config({
            "memory_hybrid_recall_enabled": hybrid,
            "conversation_index": {"enabled": True, "db_path": str(self.index_path)},
        })
        store = MemoryStore(self.db_path, clock=self.clock)
        self.store = store
        self.service = MemoryService(
            store, hybrid_recall_enabled=config.memory_hybrid_recall_enabled
        )
        # Duck-typed like the dispatcher tests' containers (a BrainContainer stand-in).
        self.container: Any = SimpleNamespace(stack=SimpleNamespace(
            engine=self.engine, config=config, memory_store=store,
            memory_service=self.service,
        ))

    def restart(self, *, hybrid: bool = False) -> None:
        """A sidecar restart: close the store, then reopen it from the same file."""

        self.close()
        self.open(hybrid=hybrid)

    def close(self) -> None:
        if self.store is not None:
            self.store.close()
            self.store = None

    # --- JSON-RPC --------------------------------------------------------------

    def call(self, method: str, **params: Any) -> dict[str, Any]:
        message = {
            "jsonrpc": "2.0", "id": next(self._ids), "method": method,
            "params": {"accept_version": API_VERSION, **params},
        }
        outcome = request_dispatch.process_message(
            message, True, brain_container=self.container, logger=LOGGER,
            write_message=self.sent.append, read_message=dict,
        )
        assert outcome.response is not None
        return outcome.response

    def result(self, method: str, **params: Any) -> dict[str, Any]:
        response = self.call(method, **params)
        assert "error" not in response, response.get("error")
        return dict(response["result"])

    def error(self, method: str, **params: Any) -> dict[str, Any]:
        response = self.call(method, **params)
        assert "error" in response, response.get("result")
        return dict(response["error"])

    # --- memory sugar ----------------------------------------------------------

    def save(
        self, text: str, *, project: str = PROJECT_A, session: str = "chat-1",
        kind: str = "fact", **extra: Any,
    ) -> dict[str, Any]:
        return self.result(
            MEMORY_SAVE_METHOD, project_id=project, session_id=session,
            candidate={"lesson_text": text, "lesson_kind": kind}, **extra,
        )

    def recall(self, query: str, *, project: str = PROJECT_A, **extra: Any) -> list[str]:
        result = self.result(MEMORY_RECALL_METHOD, project_id=project, query=query, limit=5,
                             **extra)
        return [memory["lesson_text"] for memory in result["memories"]]

    def listed(self, *, project: str = PROJECT_A, **extra: Any) -> list[dict[str, Any]]:
        return list(self.result(MEMORY_LIST_METHOD, project_id=project, limit=50,
                                **extra)["memories"])

    def listed_texts(self, *, project: str = PROJECT_A, **extra: Any) -> list[str]:
        return [memory["lesson_text"] for memory in self.listed(project=project, **extra)]

    def prompt_recall(
        self, query: str, *, project: str = PROJECT_A, session: str | None = None,
        recent: Sequence[str] = (),
    ) -> tuple[list[str], list[str]]:
        """The chat path's recall (memories, recap texts) for a turn in *session*."""

        policy = MemoryPolicy(
            project_id=project,
            recent_chats=tuple(RecentChat(chat, f"Chat {chat}") for chat in recent),
        )
        memories, recaps = self.service.recall_for_prompt_with_recaps(
            query, policy=policy, scope_session_id=session
        )
        return [memory.lesson_text for memory in memories], [line.text for line in recaps]

    def reflect(  # noqa: PLR0913 - the memory.reflect params.
        self, output: str, *, session: str, messages: list[dict[str, str]],
        project: str = PROJECT_A, new_user_ids: Sequence[str] | None = None,
        window_label: str = "w1",
    ) -> dict[str, Any]:
        self.engine.script(output)
        ids = list(new_user_ids) if new_user_ids is not None else [
            message["id"] for message in messages if message["role"] == "user"
        ]
        return self.result(
            MEMORY_REFLECT_METHOD, request_id=f"reflect-{session}-{window_label}",
            session_id=session, project_id=project, messages=messages, new_user_ids=ids,
            window_fingerprint=fingerprint(window_label),
        )

    def apply(  # noqa: PLR0913 - the memory.apply params.
        self, *, session: str, proposals: Sequence[dict[str, Any]], project: str = PROJECT_A,
        recap: str = "", window_label: str = "w1", expected: str | None = None,
        message_count: int = 1,
    ) -> dict[str, Any]:
        return self.result(
            MEMORY_APPLY_METHOD, session_id=session, project_id=project, policy_epoch=0,
            epoch_source=EPOCH_SOURCE, capture="auto", expected_fingerprint=expected,
            cursor={
                "message_count": message_count, "last_message_id": f"{window_label}-last",
                "window_fingerprint": fingerprint(window_label),
                "session_incarnation": "inc_1", "turn_generation": 0,
            },
            proposals=list(proposals), recap=recap,
        )

    def take_notes(  # noqa: PLR0913 - reflect then apply, as Electron runs them.
        self, output: str, *, session: str, messages: list[dict[str, str]],
        project: str = PROJECT_A, window_label: str = "w1", expected: str | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        reflected = self.reflect(output, session=session, messages=messages, project=project,
                                 window_label=window_label)
        applied = self.apply(
            session=session, project=project, proposals=reflected["proposals"],
            recap=reflected["recap"], window_label=window_label, expected=expected,
            message_count=len(messages),
        )
        return reflected, applied

    # --- conversation index sugar ---------------------------------------------

    def index_chat(self, session: str, texts: Sequence[str], *,
                   project: str = PROJECT_A, title: str = "") -> dict[str, Any]:
        # Untitled by default: the fake embedders embed the title with every message.
        return self.result(
            CONVERSATIONS_INDEX_SESSION_METHOD, session_id=session, project_id=project,
            title=title, updated_at="2026-10-15T10:00:00Z",
            fingerprint=f"fp-{session}",
            messages=[
                {"message_id": f"{session}-m{index}",
                 "role": "user" if index % 2 == 0 else "assistant",
                 "created_at": f"2026-10-15T10:00:{index:02d}Z", "text": text}
                for index, text in enumerate(texts)
            ],
        )

    def search_chats(self, query: str, *, project: str = PROJECT_A,
                     exclude: Sequence[str] = ()) -> dict[str, Any]:
        return self.result(CONVERSATIONS_SEARCH_METHOD, query=query, project_id=project,
                           exclude_session_ids=list(exclude))


__all__ = [
    "EPOCH_SOURCE",
    "GENERAL",
    "LOGGER",
    "PROJECT_A",
    "PROJECT_B",
    "ScenarioStack",
    "ScriptedEngine",
    "TickingClock",
    "fingerprint",
    "item",
    "model_output",
    "window",
]
