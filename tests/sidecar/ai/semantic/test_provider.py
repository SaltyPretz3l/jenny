from __future__ import annotations

import json
import math

import httpx
import pytest

from sidecar.ai.error_codes import (
    CMP_CATALOG_EMBEDDER_INVALID_PAYLOAD,
    CMP_CATALOG_EMBEDDER_UNAVAILABLE,
)
from sidecar.ai.semantic.provider import (
    EMBEDDING_REQUEST_MODEL,
    EmbeddingProviderError,
    OpenAICompatibleEmbeddingProvider,
)

BASE_URL = "http://127.0.0.1:8123/v1"


def _provider(handler, *, api_key: str | None = "k-123", dims: int = 0, batch_size: int = 16):
    return OpenAICompatibleEmbeddingProvider(
        BASE_URL, api_key, dims=dims, batch_size=batch_size, transport=httpx.MockTransport(handler)
    )


def _echo_handler(seen: list[httpx.Request]):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        body = json.loads(request.content)
        data = [
            {"index": index, "embedding": [float(len(text)), 0.0, 3.0, 4.0]}
            for index, text in enumerate(body["input"])
        ]
        return httpx.Response(200, json={"data": list(reversed(data))})

    return handler


def test_posts_openai_shape_with_key_and_batches() -> None:
    seen: list[httpx.Request] = []
    provider = _provider(_echo_handler(seen), batch_size=2)

    vectors = provider.embed_many(["a", "bb", "ccc"], timeout_seconds=2.0)

    assert len(seen) == 2
    assert str(seen[0].url) == f"{BASE_URL}/embeddings"
    assert seen[0].headers["authorization"] == "Bearer k-123"
    body = json.loads(seen[0].content)
    assert body == {"input": ["a", "bb"], "model": EMBEDDING_REQUEST_MODEL, "encoding_format": "float"}
    # index order restored, unit length
    assert vectors[1][0] > vectors[0][0]
    for vector in vectors:
        assert math.sqrt(sum(value * value for value in vector)) == pytest.approx(1.0)


def test_no_authorization_header_without_a_key() -> None:
    seen: list[httpx.Request] = []
    provider = _provider(_echo_handler(seen), api_key=None)

    provider.embed("hello", timeout_seconds=1.0)

    assert "authorization" not in seen[0].headers


def test_dims_truncate_then_normalize() -> None:
    provider = _provider(lambda request: httpx.Response(
        200, json={"data": [{"embedding": [3.0, 4.0, 100.0]}]}
    ), dims=2)

    assert provider.embed("x", timeout_seconds=1.0) == pytest.approx([0.6, 0.8])


@pytest.mark.parametrize(
    "payload",
    [
        {"data": []},
        {"data": [{"embedding": [1.0]}, {"embedding": [1.0]}]},
        {"data": [{"embedding": ["nan"]}]},
        {"nope": True},
        {"data": [{"embedding": [0.0, 0.0]}]},
    ],
)
def test_invalid_payload_is_typed(payload: object) -> None:
    provider = _provider(lambda request: httpx.Response(200, json=payload))

    with pytest.raises(EmbeddingProviderError) as error:
        provider.embed("x", timeout_seconds=1.0)

    assert error.value.code == CMP_CATALOG_EMBEDDER_INVALID_PAYLOAD


def test_inconsistent_lengths_and_non_json_are_invalid_payloads() -> None:
    provider = _provider(lambda request: httpx.Response(
        200, json={"data": [{"embedding": [1.0, 2.0]}, {"embedding": [1.0]}]}
    ))
    with pytest.raises(EmbeddingProviderError) as error:
        provider.embed_many(["a", "b"], timeout_seconds=1.0)
    assert error.value.code == CMP_CATALOG_EMBEDDER_INVALID_PAYLOAD

    provider = _provider(lambda request: httpx.Response(200, content=b"<html>"))
    with pytest.raises(EmbeddingProviderError) as error:
        provider.embed("a", timeout_seconds=1.0)
    assert error.value.code == CMP_CATALOG_EMBEDDER_INVALID_PAYLOAD


def _raise(exc: Exception):
    def handler(request: httpx.Request) -> httpx.Response:
        raise exc

    return handler


@pytest.mark.parametrize(
    "handler",
    [
        lambda request: httpx.Response(500, json={"error": "boom"}),
        lambda request: httpx.Response(401),
        _raise(httpx.ConnectError("refused")),
        _raise(httpx.ReadTimeout("slow")),
    ],
)
def test_transport_failures_are_embedder_unavailable(handler) -> None:
    provider = _provider(handler)

    with pytest.raises(EmbeddingProviderError) as error:
        provider.embed("secret text", timeout_seconds=1.0)

    assert error.value.code == CMP_CATALOG_EMBEDDER_UNAVAILABLE
    assert "secret text" not in str(error.value) and "k-123" not in str(error.value)


@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1:8123/v1",
        "http://example.com:8123/v1",
        "http://10.0.0.5:8123/v1",
        "http://user:pw@127.0.0.1:8123/v1",
        "not a url",
    ],
)
def test_only_loopback_http_is_accepted(url: str) -> None:
    with pytest.raises(EmbeddingProviderError) as error:
        OpenAICompatibleEmbeddingProvider(url, None, dims=0)
    assert error.value.code == CMP_CATALOG_EMBEDDER_UNAVAILABLE


@pytest.mark.parametrize("url", ["http://localhost:9/v1", "http://[::1]:9/v1"])
def test_loopback_names_are_accepted(url: str) -> None:
    OpenAICompatibleEmbeddingProvider(url, None, dims=0).close()


def test_host_is_revalidated_before_every_request() -> None:
    seen: list[httpx.Request] = []
    provider = _provider(_echo_handler(seen))
    provider._base_url = "http://evil.example/v1"  # simulate tampering after construction

    with pytest.raises(EmbeddingProviderError):
        provider.embed("x", timeout_seconds=1.0)
    assert seen == []


@pytest.mark.parametrize(
    "indexes",
    [(1, "missing"), ("missing", 0), (None, 1), (False, 1), (0, True),
     ("0", 1), (0.0, 1), (0, 0), (0, 2), (-1, 1)],
)
def test_inconsistent_embedding_indexes_are_rejected(indexes: tuple[object, object]) -> None:
    data = []
    for index in indexes:
        item = {"embedding": [1.0, 0.0]}
        if index != "missing":
            item["index"] = index
        data.append(item)
    provider = _provider(lambda request: httpx.Response(200, json={"data": data}))
    try:
        with pytest.raises(EmbeddingProviderError, match="embedding indexes are inconsistent") as error:
            provider.embed_many(["a", "b"], timeout_seconds=1.0)
        assert error.value.code == CMP_CATALOG_EMBEDDER_INVALID_PAYLOAD
    finally:
        provider.close()


@pytest.mark.parametrize("indexed", [False, True])
def test_embedding_reply_preserves_input_order(indexed: bool) -> None:
    data = [{"embedding": [1.0, 0.0]}, {"embedding": [0.0, 1.0]}]
    if indexed:
        data = [{**item, "index": index} for index, item in reversed(list(enumerate(data)))]
    provider = _provider(lambda request: httpx.Response(200, json={"data": data}))
    try:
        assert provider.embed_many(["a", "b"], timeout_seconds=1.0) == [[1.0, 0.0], [0.0, 1.0]]
    finally:
        provider.close()
