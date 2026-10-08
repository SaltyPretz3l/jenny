"""OpenAI-compatible ``/v1/embeddings`` client for the loopback embedding server.

Loopback-only: the host is re-validated before every request, environment
proxies are ignored and redirects are never followed. The key and the input
texts are never logged.
"""

from __future__ import annotations

import time
from collections.abc import Sequence
from typing import Any

import httpx

from sidecar.ai.error_codes import (
    CMP_CATALOG_EMBEDDER_INVALID_PAYLOAD,
    CMP_CATALOG_EMBEDDER_UNAVAILABLE,
)
from sidecar.ai.semantic.vectors import truncate_and_normalize, validate_vector
from sidecar.exceptions import CompanionError

EMBEDDING_REQUEST_MODEL = "jenny-embedding"
DEFAULT_BATCH_SIZE = 16
MAX_BATCH_SIZE = 64
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
_HTTP_OK = 200


class EmbeddingProviderError(CompanionError):
    """Typed embedder failure carrying a ``CMP-CAT`` code."""

    def __init__(self, code: str, message: str, *, unreachable: bool = False) -> None:
        super().__init__(code, message, retryable=code == CMP_CATALOG_EMBEDDER_UNAVAILABLE)
        # True when no server answered at all (down or restarting), as opposed
        # to a server that answered this batch with an error or ran out of time.
        self.unreachable = unreachable


def require_loopback_url(base_url: str) -> httpx.URL:
    """Parse ``base_url`` and refuse anything but plain-HTTP loopback."""
    try:
        url = httpx.URL(base_url)
    except (httpx.InvalidURL, TypeError) as error:
        raise EmbeddingProviderError(
            CMP_CATALOG_EMBEDDER_UNAVAILABLE, "embedder URL is invalid"
        ) from error
    if url.scheme != "http" or url.host not in LOOPBACK_HOSTS or url.userinfo:
        raise EmbeddingProviderError(
            CMP_CATALOG_EMBEDDER_UNAVAILABLE, "embedder URL must be a loopback http URL"
        )
    return url


def _payload_error(message: str) -> EmbeddingProviderError:
    return EmbeddingProviderError(CMP_CATALOG_EMBEDDER_INVALID_PAYLOAD, message)


def _ordered_items(data: list[Any]) -> list[Any]:
    if not any(isinstance(item, dict) and "index" in item for item in data):
        return data
    indexes: list[int] = []
    for item in data:
        index = item.get("index") if isinstance(item, dict) else None
        if isinstance(index, bool) or not isinstance(index, int):
            raise _payload_error("embedding indexes are inconsistent")
        indexes.append(index)
    if sorted(indexes) != list(range(len(data))):
        raise _payload_error("embedding indexes are inconsistent")
    by_index = dict(zip(indexes, data, strict=True))
    return [by_index[index] for index in range(len(data))]


def parse_embeddings_payload(payload: Any, *, expected: int, dims: int) -> list[list[float]]:
    """Validate an OpenAI-style embeddings response and apply Matryoshka dims."""
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list) or len(data) != expected:
        raise _payload_error("embedding count does not match the inputs")
    vectors: list[list[float]] = []
    width: int | None = None
    for item in _ordered_items(data):
        raw = item.get("embedding") if isinstance(item, dict) else None
        try:
            values = validate_vector(raw)
        except ValueError as error:
            raise _payload_error("embedding values are invalid") from error
        if width is None:
            width = len(values)
        elif len(values) != width:
            raise _payload_error("embedding lengths are inconsistent")
        try:
            vectors.append(truncate_and_normalize(values, dims))
        except ValueError as error:
            raise _payload_error("embedding is a zero vector") from error
    return vectors


class OpenAICompatibleEmbeddingProvider:
    """Batching embedder client; satisfies the memory ``EmbeddingProvider`` protocol."""

    def __init__(
        self,
        base_url: str,
        api_key: str | None,
        *,
        dims: int,
        batch_size: int = DEFAULT_BATCH_SIZE,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        require_loopback_url(base_url)
        if isinstance(batch_size, bool) or not isinstance(batch_size, int) or batch_size < 1:
            raise ValueError("batch_size must be a positive integer")
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key or None
        self._dims = dims
        self._batch_size = min(batch_size, MAX_BATCH_SIZE)
        self._client = httpx.Client(
            transport=transport, trust_env=False, follow_redirects=False
        )

    @property
    def batch_size(self) -> int:
        return self._batch_size

    def close(self) -> None:
        self._client.close()

    def embed(self, text: str, *, timeout_seconds: float) -> list[float]:
        return self.embed_many([text], timeout_seconds=timeout_seconds)[0]

    def embed_many(
        self, texts: Sequence[str], *, timeout_seconds: float
    ) -> list[list[float]]:
        """Embed ``texts`` in batches; the whole call shares one deadline."""
        deadline = time.monotonic() + max(float(timeout_seconds), 0.0)
        vectors: list[list[float]] = []
        for start in range(0, len(texts), self._batch_size):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise EmbeddingProviderError(
                    CMP_CATALOG_EMBEDDER_UNAVAILABLE, "embedder deadline exceeded"
                )
            batch = list(texts[start : start + self._batch_size])
            vectors.extend(self._post(batch, timeout_seconds=remaining))
        return vectors

    def _post(self, batch: list[str], *, timeout_seconds: float) -> list[list[float]]:
        url = require_loopback_url(f"{self._base_url}/embeddings")
        headers = {"Authorization": f"Bearer {self._api_key}"} if self._api_key else {}
        body = {"input": batch, "model": EMBEDDING_REQUEST_MODEL, "encoding_format": "float"}
        try:
            response = self._client.post(
                url, json=body, headers=headers, timeout=httpx.Timeout(timeout_seconds)
            )
        except httpx.ConnectTimeout as error:
            raise EmbeddingProviderError(
                CMP_CATALOG_EMBEDDER_UNAVAILABLE, "embedder is not reachable", unreachable=True
            ) from error
        except httpx.TimeoutException as error:
            raise EmbeddingProviderError(
                CMP_CATALOG_EMBEDDER_UNAVAILABLE, "embedder request timed out"
            ) from error
        except httpx.ConnectError as error:
            raise EmbeddingProviderError(
                CMP_CATALOG_EMBEDDER_UNAVAILABLE, "embedder is not reachable", unreachable=True
            ) from error
        except httpx.HTTPError as error:
            raise EmbeddingProviderError(
                CMP_CATALOG_EMBEDDER_UNAVAILABLE,
                f"embedder request failed ({type(error).__name__})",
            ) from error
        if response.status_code != _HTTP_OK:
            raise EmbeddingProviderError(
                CMP_CATALOG_EMBEDDER_UNAVAILABLE,
                f"embedder returned HTTP {response.status_code}",
            )
        try:
            payload = response.json()
        except ValueError as error:
            raise _payload_error("embedder response is not JSON") from error
        return parse_embeddings_payload(payload, expected=len(batch), dims=self._dims)
