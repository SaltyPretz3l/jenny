"""A deterministic in-process embedder for the hybrid recall tests (row 58 W4).

Hashed bag of words into a fixed dimension, with a synonym table so paraphrase
fixtures can be engineered: two texts whose content words share a canonical
form point the same way, and stop words carry no weight.
"""

from __future__ import annotations

import hashlib
import math
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field

DIMS = 64
_WORD_RE = re.compile(r"[a-z0-9]+")
STOP_WORDS = frozenset(
    "a an and are as at be do does for from have how i in is it me my of on or our "
    "the this to uses use user what which who with you your doc query".split()
)
SYNONYMS = {
    "automobile": "vehicle", "car": "vehicle", "drives": "vehicle",
    "hound": "dog", "puppy": "dog", "pet": "dog",
}


def embed_text(text: str, dims: int = DIMS) -> list[float]:
    vector = [0.0] * dims
    for word in _WORD_RE.findall(text.lower()):
        if word in STOP_WORDS:
            continue
        token = SYNONYMS.get(word, word)
        index = int.from_bytes(hashlib.sha256(token.encode()).digest()[:4], "big") % dims
        vector[index] += 1.0
    norm = math.sqrt(sum(value * value for value in vector))
    return [value / norm for value in vector] if norm else [0.0] * dims


@dataclass
class FakeProvider:
    delay: float = 0.0
    fail: bool = False
    on_call: Callable[[], None] | None = None
    texts: list[str] = field(default_factory=list)

    def embed(self, text: str, *, timeout_seconds: float) -> list[float]:
        return self.embed_many([text], timeout_seconds=timeout_seconds)[0]

    def embed_many(self, texts: list[str], *, timeout_seconds: float) -> list[list[float]]:
        assert timeout_seconds > 0
        if self.on_call is not None:
            self.on_call()
        if self.delay:
            time.sleep(self.delay)
        if self.fail:
            raise RuntimeError("embedder down")
        self.texts.extend(texts)
        return [embed_text(text) for text in texts]


@dataclass
class FakeEmbedder:
    provider: FakeProvider = field(default_factory=FakeProvider)
    model_key: str = "fake-hash-64"
    query_template: str = "query: {text}"
    document_template: str = "doc: {title} | {text}"
    dims: int = DIMS


class StepClock:
    """A monotonic clock the fake provider advances by ``step`` per embed call."""

    def __init__(self, step: float = 1.0) -> None:
        self.now = 0.0
        self.step = step

    def __call__(self) -> float:
        return self.now

    def tick(self) -> None:
        self.now += self.step
