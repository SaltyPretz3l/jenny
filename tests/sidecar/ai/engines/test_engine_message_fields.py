"""W1: resolve the EngineMessage lie by DELETING the dead declared fields.

`EngineMessage` declares `is_error`, `error_code`, and `metadata`, but
`engine_messages()` never populates them and no engine serializer reads them
(verified by repo grep at wave start). With the W1 envelope, everything the
model needs rides `content`; the dead declarations would keep implying a wire
channel that does not exist. Pin the closed field set so a future engine
cannot quietly start depending on fields the builder never fills.
`images` is filled by `engine_messages()` on the anchored user row when the
request context carries vision images.
"""

from __future__ import annotations

from sidecar.ai.engines.base import EngineMessage, EngineToolCall


def test_engine_message_declares_exactly_the_fields_the_builder_fills() -> None:
    assert set(EngineMessage.__annotations__) == {
        "role",
        "content",
        "tool_calls",
        "tool_call_id",
        "name",
        "images",
    }


def test_engine_tool_call_shape_is_unchanged() -> None:
    assert set(EngineToolCall.__annotations__) == {
        "id",
        "call_id",
        "name",
        "tool_id",
        "arguments",
    }
