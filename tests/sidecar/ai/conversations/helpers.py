"""Shared builders and fake embedders for the conversation index tests."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sidecar.ai.conversations.store import MessageInput, SessionInput
from sidecar.ai.semantic.runtime import EmbedderHandle
from tests.sidecar.ai.semantic.fakes import FakeClock, FakeProvider, bag_of_words

# Paraphrase map for the fake embedder: words that "mean" the same land on the
# same vector bucket, so a search by meaning can find what the words miss.
SYNONYMS = {"automobile": "car", "vehicle": "car", "physician": "doctor"}


class SynonymProvider(FakeProvider):
    """Bag-of-words embedder that folds synonyms first (a paraphrase-aware fake)."""

    def embed_many(self, texts: Sequence[str], *, timeout_seconds: float) -> list[list[float]]:
        assert timeout_seconds > 0
        self.calls.append(list(texts))
        if self.clock is not None:
            self.clock.now += self.seconds_per_call
        if self.fail_with is not None:
            raise self.fail_with
        folded = [
            " ".join(SYNONYMS.get(word, word) for word in text.lower().split())
            for text in texts
        ]
        return [bag_of_words(text, self.dim) for text in folded]


def handle(provider: Any, model_key: str = "model-a") -> EmbedderHandle:
    return EmbedderHandle(
        provider=provider,
        model_key=model_key,
        query_template="query: {text}",
        document_template="{title} | {text}",
        dims=0,
    )


def session(
    session_id: str,
    texts: Sequence[str],
    *,
    project_id: str = "project_general",
    title: str = "",
    fingerprint: str = "fp-1",
) -> SessionInput:
    return SessionInput(
        session_id=session_id,
        project_id=project_id,
        title=title or f"Chat {session_id}",
        updated_at="2026-10-15T10:00:00Z",
        fingerprint=fingerprint,
        messages=tuple(
            MessageInput(
                message_id=f"{session_id}-m{index}",
                role="user" if index % 2 == 0 else "assistant",
                created_at=f"2026-10-15T10:00:{index:02d}Z",
                text=text,
            )
            for index, text in enumerate(texts)
        ),
    )


__all__ = ["FakeClock", "SynonymProvider", "handle", "session"]
