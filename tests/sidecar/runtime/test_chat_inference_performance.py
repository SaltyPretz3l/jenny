"""Replay NInfer through the chat.send entry, real router and wire writer."""

import logging
from contextlib import nullcontext
from types import SimpleNamespace

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.host_policy import HOST_EXECUTION_POLICY_VERSION
from sidecar.ai.routing.router import ChatRouter
from sidecar.protocol import API_VERSION
from sidecar.runtime.request_dispatch_chat import process_chat_send_request
from tests.sidecar.ai.engines import test_openai_compatible_ninfer as ninfer
from tests.sidecar.ai.routing.test_tool_loop import _StubMCPClient

make_engine = ninfer.make_engine


@pytest.mark.parametrize("options,live,hosted", [
    ({"live": True, "provider_kind": "ninfer"}, True, False),
    ({"live": False, "provider_kind": "ninfer"}, False, False),
    ({"live": "true", "provider_kind": "ninfer"}, False, False),
    ({"live": True, "provider_kind": "ninfer", "extra": True}, False, False),
    ([], False, False),
    ({"live": True, "provider_kind": "ninfer"}, False, True),
])
def test_chat_send_replays_inference_performance(make_engine, options, live, hosted):
    engine, sent = make_engine("think_off.sse")
    config = RuntimeConfig(
        engine_type="openai-compatible", model=ninfer.MODEL_ID, max_tokens=64,
        host_mode="server" if hosted else "desktop",
        host_execution_policy_version=HOST_EXECUTION_POLICY_VERSION if hosted else None,
    )
    context_builder = ContextBuilder(None)
    mcp_client = _StubMCPClient()
    router = ChatRouter(config=config, engine=engine, mcp_client=mcp_client,
                        context_builder=context_builder)
    container = SimpleNamespace(stack=SimpleNamespace(
        config=config, raw_config={}, engine=engine, router=router,
        context_builder=context_builder, mcp_client=mcp_client, memory_store=None,
        tool_observations=None,
    ), subprocess_manager=None, request_boundary=lambda *_args, **_kwargs: nullcontext())
    messages = []
    request = {"jsonrpc": "2.0", "id": "message", "method": "chat.send", "params": {
            "accept_version": API_VERSION,
            "request_id": "request", "trace_id": "trace", "session_id": "session",
            "logical_turn_id": "turn", "messages": [{"role": "user", "content": "Hi"}],
            "inference_performance": options,
        }}
    # The server's streaming worker dispatches chat.send through this entry.
    outcome = process_chat_send_request(
        message_id=request["id"], params=request["params"], initialized=True,
        interactive_approval=False, stream_notifications=True,
        brain_container=container, logger=logging.getLogger(__name__),
        write_message=messages.append, read_message=lambda: {},
    )
    assert outcome.response["result"]["status"] == "completed"
    assert bool(sent)
    for payload in sent:
        assert (payload.get("timings_per_token") is True) is live
        assert (payload.get("return_progress") is True) is live
        if not live:
            assert "timings_per_token" not in payload and "return_progress" not in payload
    samples = [message["params"] for message in messages
               if message["method"] == "inference.performance"]
    assert engine._current_request_context() is None
    if hosted:
        assert samples == []
        return
    assert [sample["phase"] for sample in samples] == (
        ["waiting", "decode", "finished"] if live else ["waiting", "finished"]
    )
    assert len({sample["attempt_id"] for sample in samples}) == 1
    assert [sample["sequence"] for sample in samples] == list(range(len(samples)))
    for sample in samples:
        assert (sample["request_id"], sample["trace_id"], sample["session_id"], sample["turn_id"]) == (
            "request", "trace", "session", "turn",
        )
    assert samples[-1]["terminal_decode_tps"] == pytest.approx(124.18, abs=0.01)
    assert samples[-1]["generated_tokens"] == 8
    assert samples[-1]["prompt_tokens"] == 18
    assert samples[-1]["cached_prompt_tokens"] == 0
