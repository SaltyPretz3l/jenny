from __future__ import annotations

from types import SimpleNamespace

from sidecar import server
from sidecar.protocol import API_VERSION
from sidecar.runtime import request_dispatch
from sidecar.runtime.multiplexer import TurnCancellationHandle


def test_process_message_chat_send_streams_tokens_and_done() -> None:
    message = {
        "jsonrpc": "2.0",
        "id": 12,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_stream",
            "messages": [{"role": "user", "content": "hello sidecar"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["result"]["request_id"] == "req_stream"
    assert outcome.notifications[0]["method"] == "chat.thinking"
    assert outcome.notifications[0]["params"]["request_id"] == "req_stream"
    assert outcome.notifications[0]["params"]["delta"]
    assert outcome.notifications[0]["params"]["thinking_id"] == "think_req_stream"
    assert outcome.notifications[0]["params"]["kind"] == "status"
    assert outcome.notifications[0]["params"]["persist"] is False
    assert outcome.notifications[0]["params"]["api_version"] == API_VERSION
    assert any(item["method"] == "chat.token" for item in outcome.notifications)
    assert outcome.notifications[-1]["method"] == "chat.done"
    assert outcome.notifications[-1]["params"]["api_version"] == API_VERSION


def test_process_message_chat_send_orders_thinking_before_tokens() -> None:
    message = {
        "jsonrpc": "2.0",
        "id": 13,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_thinking_order",
            "messages": [{"role": "user", "content": "please think first"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    methods = [item["method"] for item in outcome.notifications]
    assert methods[0] == "chat.thinking"
    assert "chat.token" in methods
    assert methods.index("chat.thinking") < methods.index("chat.token")
    assert methods[-1] == "chat.done"


def test_chat_send_emits_canonical_turn_events_when_flag_enabled() -> None:
    initialize = {
        "jsonrpc": "2.0",
        "id": 13_01,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {
                "engine_type": "mock",
                "model": "mock-v1",
                "feature_flags": {"canonical_turn_events": True},
            },
        },
    }
    _ = server.process_message(initialize, initialized=False)

    message = {
        "jsonrpc": "2.0",
        "id": 13_02,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_canonical_turn_events",
            "messages": [{"role": "user", "content": "hello canonical"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    methods = [item["method"] for item in outcome.notifications]
    assert "chat.token" in methods
    assert "chat.done" in methods
    canonical_events = [
        item["params"] for item in outcome.notifications if item["method"] == "turn.event"
    ]
    assert canonical_events
    assert any(item["type"] == "text_delta" for item in canonical_events)
    text_completed = [
        item for item in canonical_events if item["type"] == "text_part_completed"
    ]
    assert text_completed
    assert text_completed[-1]["payload"]["text"]
    assert text_completed[-1]["payload"]["assistant_phase"] == "final_answer"
    assert any(item["type"] == "turn_completed" for item in canonical_events)
    assert [item["seq"] for item in canonical_events] == sorted(
        item["seq"] for item in canonical_events
    )
    assert {item["turn_id"] for item in canonical_events} == {"req_canonical_turn_events"}


def test_send_outcome_uses_ordered_terminal_result_when_available() -> None:
    calls: list[tuple[str, object]] = []

    class _FakeMultiplexer:
        def send_terminal_result(self, notifications, response):  # noqa: ANN001
            calls.append(("terminal", (list(notifications), response)))

        def send_data(self, message):  # noqa: ANN001
            raise AssertionError(f"unexpected data send: {message!r}")

        def send_control(self, message):  # noqa: ANN001
            raise AssertionError(f"unexpected control send: {message!r}")

    notifications = [
        {
            "jsonrpc": "2.0",
            "method": "chat.token",
            "params": {"request_id": "req_ordered_terminal", "delta": "fallback"},
        },
        {
            "jsonrpc": "2.0",
            "method": "chat.done",
            "params": {"request_id": "req_ordered_terminal"},
        },
    ]
    response = {
        "jsonrpc": "2.0",
        "id": 14,
        "result": {"request_id": "req_ordered_terminal", "status": "completed"},
    }

    server._send_outcome(  # noqa: SLF001
        SimpleNamespace(notifications=notifications, response=response),
        multiplexer=_FakeMultiplexer(),
    )

    assert calls == [("terminal", (notifications, response))]


def test_send_outcome_routes_a_notificationless_response_through_the_terminal_lane() -> None:
    """The live-stream turn resolves on the ORDERED lane, not the priority one.

    In live streaming ``emit()`` writes every notification straight to the wire
    and leaves ``ProcessOutcome.notifications`` EMPTY. This test used to pin the
    empty case onto ``send_control`` -- and because the writer drains control
    strictly ahead of data, the chat.send response could be written BEFORE
    chat.token/chat.done frames already queued on the data lane. Electron
    deletes the per-request notification handler on resolve, so the overtaken
    terminal was dropped as ``sidecar.unmatched_notification``: lost turn usage
    (cost/context ring), lost ``streamSawDone``, and silently truncated
    assistant text.

    ``send_terminal_result`` lands the bundle on the data queue, FIFO behind
    everything already streamed, while keeping the full high-water-mark
    headroom control gave it.
    """
    calls: list[tuple[str, object]] = []

    class _FakeMultiplexer:
        def send_terminal_result(self, notifications, response):  # noqa: ANN001
            calls.append(("terminal", (list(notifications), response)))

        def send_data(self, message):  # noqa: ANN001
            raise AssertionError(f"unexpected data send: {message!r}")

        def send_control(self, message):  # noqa: ANN001
            raise AssertionError(f"response must not jump the queue on control: {message!r}")

    response = {
        "jsonrpc": "2.0",
        "id": 15,
        "result": {"ok": True},
    }

    server._send_outcome(  # noqa: SLF001
        SimpleNamespace(notifications=[], response=response),
        multiplexer=_FakeMultiplexer(),
    )

    assert calls == [("terminal", ([], response))]


def test_send_outcome_requires_the_terminal_lane_and_routes_through_it() -> None:
    """send_terminal_result is the mandatory transport contract (W2-36-F03)."""
    calls: list[tuple[str, object]] = []

    class _TerminalLaneMultiplexer:
        def send_terminal_result(self, notifications, response):  # noqa: ANN001
            calls.append(("terminal", list(notifications), response))

    response = {"jsonrpc": "2.0", "id": 16, "result": {"ok": True}}

    server._send_outcome(  # noqa: SLF001
        SimpleNamespace(notifications=[], response=response),
        multiplexer=_TerminalLaneMultiplexer(),
    )

    assert calls == [("terminal", [], response)]


def test_process_chat_send_request_short_circuits_cancelled_turn_handle() -> None:
    cancel_handle = TurnCancellationHandle(request_id="req_cancelled")
    cancel_handle.cancel(reason="chat_cancel")

    outcome = request_dispatch.process_chat_send_request(
        message_id=99,
        params={
            "accept_version": API_VERSION,
            "request_id": "req_cancelled",
            "messages": [{"role": "user", "content": "hello"}],
        },
        initialized=True,
        interactive_approval=True,
        brain_container=server._BRAIN_CONTAINER,
        logger=server.logger,
        write_message=lambda _message: None,
        read_message=lambda: {},
        stream_notifications=True,
        cancel_handle=cancel_handle,
    )

    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "cancelled"


def test_process_message_chat_send_invalid_payload_emits_chat_error() -> None:
    message = {
        "jsonrpc": "2.0",
        "id": 13,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_bad",
            "messages": [],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["error"]["data"]["code"] == "CMP-CHAT-0001"
    assert outcome.notifications[0]["method"] == "chat.error"
    assert outcome.notifications[0]["params"]["retryable"] is False


def test_process_message_chat_send_accepts_chat_mode_interactive_response() -> None:
    # B7b: a normal (chat-mode) turn may now answer a clarifying question, so a
    # chat-mode chat.send carrying a well-formed interactive_response is accepted
    # and routed instead of being rejected at dispatch.
    message = {
        "jsonrpc": "2.0",
        "id": 13_1,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_chat_mode_interactive_response",
            "conversation_mode": "chat",
            "interactive_response": {"batch_id": "batch_1"},
            "messages": [{"role": "user", "content": "hello"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert "error" not in outcome.response
    assert outcome.response["result"]["status"] == "completed"


def test_process_message_chat_send_rejects_malformed_interactive_response() -> None:
    # B7b: shape validation is KEPT regardless of conversation_mode — an
    # interactive_response without a non-empty batch_id is still rejected.
    message = {
        "jsonrpc": "2.0",
        "id": 13_1,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_bad_interactive_response",
            "conversation_mode": "chat",
            "interactive_response": {"answers": []},
            "messages": [{"role": "user", "content": "hello"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["error"]["code"] == -32602
    assert outcome.response["error"]["data"]["code"] == "CMP-CHAT-0001"
    assert outcome.notifications[0]["method"] == "chat.error"
    assert "interactive_response must be an object with a non-empty batch_id" in (
        outcome.notifications[0]["params"]["message"]
    )




def test_process_message_chat_send_rejects_malformed_reasoning_effort() -> None:
    message = {
        "jsonrpc": "2.0",
        "id": 13_21,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_bad_reasoning_effort",
            "reasoning_effort": "turbo",
            "messages": [{"role": "user", "content": "hello"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["error"]["code"] == -32602
    assert outcome.response["error"]["data"]["code"] == "CMP-CHAT-0001"
    assert outcome.notifications[0]["method"] == "chat.error"
    assert "reasoning_effort" in outcome.notifications[0]["params"]["message"]


def test_process_message_chat_send_rejects_malformed_session_start_date() -> None:
    message = {
        "jsonrpc": "2.0",
        "id": 13_22,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_bad_session_start_date",
            "session_start_date": "2026-99-99",
            "messages": [{"role": "user", "content": "hello"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["error"]["code"] == -32602
    assert outcome.response["error"]["data"]["code"] == "CMP-CHAT-0001"
    assert outcome.notifications[0]["method"] == "chat.error"
    assert "session_start_date" in outcome.notifications[0]["params"]["message"]


def test_process_message_chat_send_rejects_non_object_message_entries() -> None:
    message = {
        "jsonrpc": "2.0",
        "id": 13_3,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_bad_message_entry",
            "messages": ["hello"],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["error"]["code"] == -32602
    assert outcome.response["error"]["data"]["code"] == "CMP-CHAT-0001"
    assert outcome.notifications[0]["method"] == "chat.error"
    assert "messages[0] must be an object" in outcome.notifications[0]["params"]["message"]


def test_process_message_chat_send_rejects_malformed_tool_message_history() -> None:
    message = {
        "jsonrpc": "2.0",
        "id": 13_4,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_bad_tool_message",
            "messages": [
                {"role": "user", "content": "hello"},
                {"role": "tool", "content": "missing tool_call_id"},
            ],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["error"]["code"] == -32602
    assert outcome.response["error"]["data"]["code"] == "CMP-CHAT-0001"
    assert outcome.notifications[0]["method"] == "chat.error"
    assert "tool_call_id" in outcome.notifications[0]["params"]["message"]


def test_process_message_chat_send_rejects_assistant_tool_call_without_call_id() -> None:
    message = {
        "jsonrpc": "2.0",
        "id": 13_4_1,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_bad_assistant_tool_call",
            "messages": [
                {"role": "user", "content": "hello"},
                {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "type": "function",
                            "function": {"name": "read_file", "arguments": "{}"},
                        }
                    ],
                },
            ],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["error"]["code"] == -32602
    assert outcome.response["error"]["data"]["code"] == "CMP-CHAT-0001"
    assert outcome.notifications[0]["method"] == "chat.error"
    assert "call id" in outcome.notifications[0]["params"]["message"]


def test_process_message_chat_send_is_stateless_without_explicit_history() -> None:
    first = {
        "jsonrpc": "2.0",
        "id": 31,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_a",
            "messages": [{"role": "user", "content": "first session message"}],
        },
    }
    second = {
        "jsonrpc": "2.0",
        "id": 32,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_b",
            "messages": [{"role": "user", "content": "second session message"}],
        },
    }
    with_history = {
        "jsonrpc": "2.0",
        "id": 33,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_c",
            "messages": [
                {"role": "user", "content": "previous context"},
                {"role": "assistant", "content": "prior response"},
                {"role": "user", "content": "latest context-aware request"},
            ],
        },
    }

    first_outcome = server.process_message(first, initialized=True)
    second_outcome = server.process_message(second, initialized=True)
    history_outcome = server.process_message(with_history, initialized=True)

    first_text = "".join(
        notification["params"]["delta"]
        for notification in first_outcome.notifications
        if notification["method"] == "chat.token"
    )
    second_text = "".join(
        notification["params"]["delta"]
        for notification in second_outcome.notifications
        if notification["method"] == "chat.token"
    )
    history_text = "".join(
        notification["params"]["delta"]
        for notification in history_outcome.notifications
        if notification["method"] == "chat.token"
    )

    assert "Conversation context included" not in first_text
    assert "Conversation context included" not in second_text
    assert "Conversation context included 2 prior message(s)." in history_text


def test_process_message_chat_send_rejects_incompatible_version() -> None:
    message = {
        "jsonrpc": "2.0",
        "id": 14,
        "method": "chat.send",
        "params": {
            "accept_version": "2025-01-01",
            "request_id": "req_bad_version",
            "messages": [{"role": "user", "content": "hi"}],
        },
    }

    outcome = server.process_message(message, initialized=True)

    assert outcome.response is not None
    assert outcome.response["error"]["data"]["code"] == "CMP-PROTO-0001"
    assert outcome.notifications[0]["method"] == "chat.error"


def test_chat_send_delivers_the_personality_context_block_to_the_engine() -> None:
    """End-to-end proof the Electron-authored note reaches model-facing system rows.

    v3 removed config-driven personality profiles, so the personality text now
    arrives only on the typed `context_blocks` channel. MockEngine keys its
    reply off a marker phrase in a system row, which makes "did the block reach
    inference" observable from the wire instead of from prompt internals.
    """
    initialize = {
        "jsonrpc": "2.0",
        "id": 21,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {
                "engine_type": "mock",
                "model": "mock-v1",
            },
        },
    }
    _ = server.process_message(initialize, initialized=False)

    def _send(request_id: str, context_blocks: list[dict[str, str]] | None) -> str:
        params = {
            "accept_version": API_VERSION,
            "request_id": request_id,
            "messages": [{"role": "user", "content": "How do I start?"}],
        }
        if context_blocks is not None:
            params["context_blocks"] = context_blocks
        outcome = server.process_message(
            {"jsonrpc": "2.0", "id": 22, "method": "chat.send", "params": params},
            initialized=True,
        )
        return "".join(
            notification["params"]["delta"]
            for notification in outcome.notifications
            if notification["method"] == "chat.token"
        )

    with_block = _send(
        "req_personality_block",
        [{"kind": "personality", "content": "### Voice\n\npersonality profile: mentor"}],
    )
    without_block = _send("req_no_personality_block", None)

    assert "Step 1:" in with_block
    assert "Step 2:" in with_block
    # Same request, no block: the marker never reaches the engine.
    assert "Step 1:" not in without_block


def test_chat_send_emits_agent_progress_when_executor_flag_enabled() -> None:
    initialize = {
        "jsonrpc": "2.0",
        "id": 22_1,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {
                "engine_type": "mock",
                "model": "mock-v1",
                "feature_flags": {"agent_executor": True},
            },
        },
    }
    _ = server.process_message(initialize, initialized=False)

    chat_send = {
        "jsonrpc": "2.0",
        "id": 22_2,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_agent_executor",
            "messages": [{"role": "user", "content": "Plan this task end-to-end"}],
        },
    }
    outcome = server.process_message(chat_send, initialized=True)

    methods = [item["method"] for item in outcome.notifications]
    assert "agent.progress" in methods
    assert methods.index("agent.progress") < methods.index("chat.thinking")
    progress_payloads = [
        item["params"] for item in outcome.notifications if item["method"] == "agent.progress"
    ]
    assert progress_payloads[0]["request_id"] == "req_agent_executor"
    assert progress_payloads[-1]["percent"] == 100


def test_process_message_chat_send_degrades_when_workspace_missing() -> None:
    # Tools enabled but no workspace root: the tool-contract assembly already drops
    # every workspace-requiring tool from the model's list, so the turn must DEGRADE
    # to a normal answer instead of hard-failing with CMP-CFG-0001. This is the fresh
    # "Skip setup" first-message regression — the skip path leaves tools enabled with
    # no root, and that must not error the user's very first message.
    initialize = {
        "jsonrpc": "2.0",
        "id": 40,
        "method": "initialize",
        "params": {
            "accept_version": API_VERSION,
            "config": {
                "engine_type": "mock",
                "model": "mock-v1",
                "tools_enabled": True,
                "tools_workspace_root": None,
                "agent_workspace_root": None,
            },
        },
    }
    _ = server.process_message(initialize, initialized=False)

    chat_send = {
        "jsonrpc": "2.0",
        "id": 41,
        "method": "chat.send",
        "params": {
            "accept_version": API_VERSION,
            "request_id": "req_missing_ws",
            "mode": "assist",
            "messages": [{"role": "user", "content": "How do I start?"}],
        },
    }
    outcome = server.process_message(chat_send, initialized=True)

    assert outcome.response is not None
    methods = [item["method"] for item in outcome.notifications]
    codes = [
        item["params"].get("code")
        for item in outcome.notifications
        if isinstance(item.get("params"), dict)
    ]
    assert "chat.error" not in methods, "a missing workspace root must not hard-fail the turn"
    assert "CMP-CFG-0001" not in codes
    assert methods[-1] == "chat.done"
