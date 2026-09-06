from __future__ import annotations

import io
from email.message import Message

import pytest

from sidecar.ai.engines.http_utils import (
    MAX_JSON_RESPONSE_BYTES,
    read_json_response,
)
from sidecar.runtime.bounded_io import BoundedIOError


class _Response(io.BytesIO):
    def __init__(self, body: bytes, *, content_length: int | None = None) -> None:
        super().__init__(body)
        self.headers = Message()
        self.headers["content-type"] = "application/json; charset=utf-8"
        if content_length is not None:
            self.headers["content-length"] = str(content_length)


def test_read_json_response_accepts_bounded_json() -> None:
    assert read_json_response(_Response(b'{"ok":true}')) == {"ok": True}


def test_read_json_response_rejects_oversized_declared_body_without_reading() -> None:
    response = _Response(b"{}", content_length=MAX_JSON_RESPONSE_BYTES + 1)

    with pytest.raises(BoundedIOError, match="declared byte limit"):
        read_json_response(response)

    assert response.tell() == 0

