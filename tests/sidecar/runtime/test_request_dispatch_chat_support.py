from __future__ import annotations

from typing import Any

import pytest

from sidecar.runtime.chat import ChatRequestError
from sidecar.runtime.request_dispatch_chat_support import _validate_chat_send_semantics


@pytest.mark.parametrize(
    "request_id",
    [None, 42, 3.5, True, [], {}, ("value",), object()],
    ids=["null", "integer", "float", "boolean", "list", "dict", "tuple", "object"],
)
def test_explicit_non_string_request_id_is_rejected(request_id: Any) -> None:
    error = _validate_chat_send_semantics(
        params={"request_id": request_id},
        message_id=7,
    )

    assert isinstance(error, ChatRequestError)
    assert error.message == "chat.send params.request_id must be a non-empty string when provided."
