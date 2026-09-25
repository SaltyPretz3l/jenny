"""SSE readers must hand each line on as soon as its bytes arrive.

httpx's ``iter_raw(chunk_size=N)`` holds bytes until a full N-byte block has
filled. A 64 KiB block turned a llama-server reply of ~800 small deltas into
three bursts (2026-09-18, Bonsai 2 on the managed llama-server). These tests
drive a real ``httpx.Response`` whose body arrives one network chunk at a time
and assert a line is yielded before the next chunk is pulled.
"""

from __future__ import annotations

from collections.abc import Iterator

import httpx

from sidecar.ai.engines import chatgpt_subscription_stream, vllm_sse_stream


class _TrickleStream(httpx.SyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks
        self.pulled = 0

    def __iter__(self) -> Iterator[bytes]:
        for chunk in self._chunks:
            self.pulled += 1
            yield chunk


def _trickle_response() -> tuple[httpx.Response, _TrickleStream]:
    stream = _TrickleStream([
        b'data: {"n": 1}\n\n',
        b'data: {"n": 2}\n\n',
        b"data: [DONE]\n\n",
    ])
    request = httpx.Request("POST", "http://127.0.0.1:8033/v1/chat/completions")
    return httpx.Response(200, stream=stream, request=request), stream


def test_vllm_sse_lines_arrive_per_network_chunk() -> None:
    response, stream = _trickle_response()
    lines = vllm_sse_stream._iter_bounded_sse_lines(response)

    assert next(lines) == 'data: {"n": 1}'
    assert stream.pulled == 1


def test_chatgpt_sse_lines_arrive_per_network_chunk() -> None:
    response, stream = _trickle_response()
    lines = iter(chatgpt_subscription_stream.iter_cancel_aware_sse_lines(response, None))

    assert next(lines).rstrip("\n") == 'data: {"n": 1}'
    assert stream.pulled == 1
