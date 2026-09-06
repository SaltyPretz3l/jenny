from __future__ import annotations

import pytest

from sidecar.ai.engines import (
    ollama_runtime,
    ollama_stream_transport,
    vllm_engine_generation,
    vllm_sse_stream,
)
from sidecar.runtime.bounded_io import BoundedIOError


class _OllamaResponse:
    def __init__(self, data: bytes) -> None:
        self._data = data
        self._offset = 0

    def read(self, size: int) -> bytes:
        chunk = self._data[self._offset : self._offset + size]
        self._offset += len(chunk)
        return chunk


class _VllmResponse:
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    def iter_raw(self, *, chunk_size: int):
        _ = chunk_size
        yield from self._chunks


def test_ollama_never_newline_record_is_rejected_at_line_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ollama_stream_transport, "MAX_PROVIDER_STREAM_LINE_BYTES", 16)
    response = _OllamaResponse(b"x" * 17)

    with pytest.raises(BoundedIOError, match="line exceeds"):
        list(ollama_runtime._iter_bounded_response_lines(response))


def test_vllm_stream_is_rejected_at_aggregate_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(vllm_sse_stream, "_MAX_PROVIDER_STREAM_TOTAL_BYTES", 12)
    response = _VllmResponse([b"a\n"] * 7)

    with pytest.raises(BoundedIOError, match="total byte"):
        list(vllm_engine_generation._iter_bounded_sse_lines(response))
