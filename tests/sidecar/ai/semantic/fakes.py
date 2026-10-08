"""Deterministic test doubles for the semantic catalog tests."""

from __future__ import annotations

import hashlib
import math
import re
from collections.abc import Sequence

from sidecar.ai.error_codes import CMP_CATALOG_EMBEDDER_UNAVAILABLE
from sidecar.ai.semantic.provider import EmbeddingProviderError

FAKE_DIM = 64
_WORD_RE = re.compile(r"[a-z0-9]+")


def bag_of_words(text: str, dim: int = FAKE_DIM) -> list[float]:
    """Hashed bag-of-words vector, L2-normalized (a zero text maps to one bucket)."""
    vector = [0.0] * dim
    for word in _WORD_RE.findall(text.lower()):
        bucket = int(hashlib.md5(word.encode()).hexdigest(), 16) % dim
        vector[bucket] += 1.0
    if not any(vector):
        vector[0] = 1.0
    norm = math.sqrt(sum(value * value for value in vector))
    return [value / norm for value in vector]


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class FakeProvider:
    """Records calls; can fail, or advance a fake clock per request."""

    def __init__(
        self,
        *,
        dim: int = FAKE_DIM,
        batch_size: int = 16,
        clock: FakeClock | None = None,
        seconds_per_call: float = 0.0,
    ) -> None:
        self.dim = dim
        self.batch_size = batch_size
        self.calls: list[list[str]] = []
        self.fail_with: Exception | None = None
        self.clock = clock
        self.seconds_per_call = seconds_per_call
        self.closed = False

    def embed_many(self, texts: Sequence[str], *, timeout_seconds: float) -> list[list[float]]:
        assert timeout_seconds > 0
        self.calls.append(list(texts))
        if self.clock is not None:
            self.clock.now += self.seconds_per_call
        if self.fail_with is not None:
            raise self.fail_with
        return [bag_of_words(text, self.dim) for text in texts]

    def close(self) -> None:
        self.closed = True


def unavailable() -> EmbeddingProviderError:
    """No server answered (down or restarting)."""
    return EmbeddingProviderError(
        CMP_CATALOG_EMBEDDER_UNAVAILABLE, "embedder is down", unreachable=True
    )


def refused() -> EmbeddingProviderError:
    """The server answered this batch with an error (or ran out of time on it)."""
    return EmbeddingProviderError(CMP_CATALOG_EMBEDDER_UNAVAILABLE, "embedder request timed out")
