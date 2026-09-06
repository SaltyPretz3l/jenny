from __future__ import annotations

import threading
from types import SimpleNamespace

import pytest

from sidecar import server
from sidecar.ai.config import RuntimeConfig
from sidecar.ai.error_codes import (
    CMP_BACKGROUND_INVALID_PARAMS,
    CMP_CHAT_STREAM_FAILED,
    CMP_RESOURCE_EXCEEDED,
)
from sidecar.ai.feature_flags import (
    FEATURE_CANONICAL_TURN_EVENTS,
)
from sidecar.protocol import API_VERSION, TURN_EVENT_METHOD
from sidecar.runtime import request_dispatch, request_dispatch_chat
from sidecar.runtime.approval import ApprovalResolution
from sidecar.runtime.approval_plan import ApprovalPlanCache
from sidecar.runtime.chat_models import ChatResponse


def test_process_chat_send_request_fails_fast_for_invalid_messages(
    monkeypatch,
) -> None:
    def _should_not_run(*args: object, **kwargs: object) -> ChatResponse:
        raise AssertionError("build_chat_send_response should not run for invalid inbound messages")

    monkeypatch.setattr(request_dispatch, "build_chat_send_response", _should_not_run)

    outcome = request_dispatch.process_chat_send_request(
        message_id=101,
        params={
            "accept_version": API_VERSION,
            "request_id": "req-invalid-fast-fail",
            "messages": [],
        },
        initialized=True,
        interactive_approval=False,
        brain_container=server._BRAIN_CONTAINER,
        logger=server.logger,
        write_message=lambda _message: None,
        read_message=lambda: {},
    )

    assert outcome.response is not None
    assert outcome.response["error"]["data"]["code"] == "CMP-CHAT-0001"
    assert outcome.notifications[0]["method"] == "chat.error"


def test_process_chat_send_request_allows_descriptor_safe_tools_without_workspace_root(
    monkeypatch,
) -> None:
    build_calls = {"count": 0}

    def _build_success(*args: object, **kwargs: object) -> ChatResponse:
        _ = args, kwargs
        build_calls["count"] += 1
        return ChatResponse(
            request_id="req-workspace-optional-tools",
            result={"request_id": "req-workspace-optional-tools", "status": "completed"},
            notifications=[],
            approval_request=None,
        )

    monkeypatch.setattr(request_dispatch, "build_chat_send_response", _build_success)
    # No tool_preferences are sent below, so the preflight's explicit-allowlist guard
    # short-circuits (requested_tools is empty) and the turn degrades gracefully without
    # ever building the catalog — no need to stub the workspace-required check.
    monkeypatch.setattr(
        request_dispatch,
        "policy_for_mode",
        lambda _mode: SimpleNamespace(allow_tools=True),
    )

    class _NullContext:
        def __enter__(self):
            return None

        def __exit__(self, exc_type, exc, tb):
            return False

    fake_brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                feature_flags={},
                tools_enabled=True,
                tools_workspace_root=" ",
                agent_workspace_root="",
            )
        ),
        request_boundary=lambda *_args, **_kwargs: _NullContext(),
    )

    outcome = request_dispatch.process_chat_send_request(
        message_id=9911,
        params={
            "accept_version": API_VERSION,
            "request_id": "req-workspace-optional-tools",
            "messages": [{"role": "user", "content": "run tool-optional turn"}],
            "mode": "assist",
        },
        initialized=True,
        interactive_approval=False,
        brain_container=fake_brain_container,
        logger=server.logger,
        write_message=lambda _message: None,
        read_message=lambda: {},
    )

    assert build_calls["count"] == 1
    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "completed"


def test_process_chat_send_request_resumes_from_cached_approval_plan_without_second_build(
    monkeypatch,
) -> None:
    build_calls = {"count": 0}
    resume_calls = {"count": 0}
    approval_plan = SimpleNamespace(call_id="call-approved-1", request_id="req-approved-1")

    monkeypatch.setattr(request_dispatch, "_APPROVAL_PLAN_CACHE", ApprovalPlanCache())

    def _build_once(*args: object, **kwargs: object) -> ChatResponse:
        _ = args, kwargs
        build_calls["count"] += 1
        return ChatResponse(
            request_id="req-approved-1",
            result={"request_id": "req-approved-1", "status": "awaiting_approval"},
            notifications=[],
            approval_request={
                "request_id": "req-approved-1",
                "tool_name": "write_file",
                "tool_input": {"path": "notes.md"},
                "mode": "chat",
                "tool_call_id": "call-approved-1",
            },
            approval_plan=approval_plan,
        )

    def _resume_cached_plan(
        approval_plan_arg: object,
        **kwargs: object,
    ) -> ChatResponse:
        _ = kwargs
        assert approval_plan_arg is approval_plan
        resume_calls["count"] += 1
        return ChatResponse(
            request_id="req-approved-1",
            result={"request_id": "req-approved-1", "status": "completed"},
            notifications=[],
            approval_request=None,
        )

    monkeypatch.setattr(request_dispatch, "build_chat_send_response", _build_once)
    monkeypatch.setattr(
        request_dispatch,
        "resume_chat_send_response_from_approval_plan",
        _resume_cached_plan,
    )
    monkeypatch.setattr(request_dispatch, "request_tool_approval", lambda *args, **kwargs: True)

    outcome = request_dispatch.process_chat_send_request(
        message_id=991,
        params={
            "accept_version": API_VERSION,
            "request_id": "req-approved-1",
            "messages": [{"role": "user", "content": "write notes.md"}],
        },
        initialized=True,
        interactive_approval=True,
        brain_container=server._BRAIN_CONTAINER,
        logger=server.logger,
        write_message=lambda _message: None,
        read_message=lambda: {},
    )

    assert build_calls["count"] == 1
    assert resume_calls["count"] == 1
    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "completed"


def test_process_chat_send_request_fails_closed_when_approval_plan_is_oversized(
    monkeypatch,
) -> None:
    approval_plan = SimpleNamespace(
        call_id="call-oversized",
        request_id="req-oversized",
        session_id="session-oversized",
    )
    cache = ApprovalPlanCache(max_bytes=1, size_fn=lambda _plan: 2)
    monkeypatch.setattr(request_dispatch, "_APPROVAL_PLAN_CACHE", cache)
    monkeypatch.setattr(
        request_dispatch,
        "build_chat_send_response",
        lambda *args, **kwargs: ChatResponse(
            request_id="req-oversized",
            result={"request_id": "req-oversized", "status": "awaiting_approval"},
            notifications=[],
            approval_request={
                "request_id": "req-oversized",
                "tool_name": "write_file",
                "tool_input": {"path": "notes.md"},
                "mode": "assist",
                "tool_call_id": "call-oversized",
            },
            approval_plan=approval_plan,
        ),
    )
    monkeypatch.setattr(
        request_dispatch,
        "request_tool_approval",
        lambda *args, **kwargs: pytest.fail("oversized plan must fail before approval wait"),
    )

    class _NullContext:
        def __enter__(self):
            return None

        def __exit__(self, exc_type, exc, tb):
            return False

    fake_brain = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                feature_flags={},
                tools_enabled=True,
                tools_workspace_root="C:/workspace",
                agent_workspace_root="C:/workspace",
            )
        ),
        request_boundary=lambda *_args, **_kwargs: _NullContext(),
    )

    outcome = request_dispatch.process_chat_send_request(
        message_id=992,
        params={
            "accept_version": API_VERSION,
            "request_id": "req-oversized",
            "session_id": "session-oversized",
            "messages": [{"role": "user", "content": "write notes.md"}],
            "mode": "assist",
        },
        initialized=True,
        interactive_approval=True,
        brain_container=fake_brain,
        logger=server.logger,
        write_message=lambda _message: None,
        read_message=lambda: {},
    )

    assert outcome.response is not None
    assert outcome.response["error"]["data"]["code"] == CMP_RESOURCE_EXCEEDED


def test_process_chat_send_request_forwards_electron_bridge_callbacks_to_approval_resume(
    monkeypatch,
) -> None:
    approval_plan = SimpleNamespace(
        call_id="call-electron-bridge-approval",
        request_id="req-electron-bridge-approval",
    )
    captured_kwargs: dict[str, object] = {}

    monkeypatch.setattr(request_dispatch, "_APPROVAL_PLAN_CACHE", ApprovalPlanCache())

    def _build_once(*args: object, **kwargs: object) -> ChatResponse:
        _ = args, kwargs
        return ChatResponse(
            request_id="req-electron-bridge-approval",
            result={
                "request_id": "req-electron-bridge-approval",
                "status": "awaiting_approval",
            },
            notifications=[],
            approval_request={
                "request_id": "req-electron-bridge-approval",
                "tool_name": "worktree_create",
                "tool_input": {"name": "feature"},
                "mode": "assist",
                "tool_call_id": "call-electron-bridge-approval",
            },
            approval_plan=approval_plan,
        )

    def _resume_cached_plan(
        approval_plan_arg: object,
        **kwargs: object,
    ) -> ChatResponse:
        assert approval_plan_arg is approval_plan
        captured_kwargs.update(kwargs)
        return ChatResponse(
            request_id="req-electron-bridge-approval",
            result={"request_id": "req-electron-bridge-approval", "status": "completed"},
            notifications=[],
            approval_request=None,
        )

    written_messages: list[dict[str, object]] = []

    def write_message(message: dict[str, object]) -> None:
        written_messages.append(message)

    def approval_response_reader(_timeout: float) -> dict[str, object]:
        return {"jsonrpc": "2.0", "id": 1, "result": {"approved": True}}

    def approval_response_waiter_factory(
        expected_id: int,
        **_kwargs: object,
    ):
        def _read_response(_timeout: float) -> dict[str, object]:
            return {"jsonrpc": "2.0", "id": expected_id, "result": {"approved": True}}

        return _read_response

    monkeypatch.setattr(request_dispatch, "build_chat_send_response", _build_once)
    monkeypatch.setattr(
        request_dispatch,
        "resume_chat_send_response_from_approval_plan",
        _resume_cached_plan,
    )
    monkeypatch.setattr(request_dispatch, "request_tool_approval", lambda *args, **kwargs: True)

    outcome = request_dispatch.process_chat_send_request(
        message_id=9912,
        params={
            "accept_version": API_VERSION,
            "request_id": "req-electron-bridge-approval",
            "messages": [{"role": "user", "content": "click submit"}],
        },
        initialized=True,
        interactive_approval=True,
        brain_container=server._BRAIN_CONTAINER,
        logger=server.logger,
        write_message=write_message,
        read_message=lambda: {},
        approval_response_reader=approval_response_reader,
        approval_response_waiter_factory=approval_response_waiter_factory,
    )

    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "completed"
    assert captured_kwargs["electron_tool_writer"] is write_message
    assert captured_kwargs["electron_tool_reader"] is approval_response_reader
    assert captured_kwargs["electron_tool_reader_factory"] is approval_response_waiter_factory


def test_process_chat_send_request_emits_canonical_approval_lifecycle(
    monkeypatch,
) -> None:
    approval_plan = SimpleNamespace(
        call_id="call-canonical-approval",
        request_id="req-canonical-approval",
        approval_plan_hash="hash-canonical-approval",
    )
    monkeypatch.setattr(request_dispatch, "_APPROVAL_PLAN_CACHE", ApprovalPlanCache())

    def _build_once(*args: object, **kwargs: object) -> ChatResponse:
        _ = args, kwargs
        return ChatResponse(
            request_id="req-canonical-approval",
            result={"request_id": "req-canonical-approval", "status": "awaiting_approval"},
            notifications=[],
            approval_request={
                "request_id": "req-canonical-approval",
                "tool_name": "write_file",
                "tool_input": {"path": "notes.md"},
                "mode": "chat",
                "tool_call_id": "call-canonical-approval",
                "reason": "Needs file write approval",
            },
            approval_plan=approval_plan,
        )

    def _resume_cached_plan(
        approval_plan_arg: object,
        **kwargs: object,
    ) -> ChatResponse:
        _ = kwargs
        assert approval_plan_arg is approval_plan
        return ChatResponse(
            request_id="req-canonical-approval",
            result={"request_id": "req-canonical-approval", "status": "completed"},
            notifications=[],
            approval_request=None,
        )

    monkeypatch.setattr(request_dispatch, "build_chat_send_response", _build_once)
    monkeypatch.setattr(
        request_dispatch,
        "resume_chat_send_response_from_approval_plan",
        _resume_cached_plan,
    )
    monkeypatch.setattr(
        request_dispatch,
        "request_tool_approval",
        lambda *args, **kwargs: ApprovalResolution(True, "approved"),
    )
    real_flag_check = request_dispatch.is_feature_flag_enabled
    monkeypatch.setattr(
        request_dispatch,
        "is_feature_flag_enabled",
        lambda flags, flag: (
            True
            if flag == FEATURE_CANONICAL_TURN_EVENTS
            else real_flag_check(flags, flag)
        ),
    )
    written_messages: list[dict[str, object]] = []

    outcome = request_dispatch.process_chat_send_request(
        message_id=9911,
        params={
            "accept_version": API_VERSION,
            "request_id": "req-canonical-approval",
            "messages": [{"role": "user", "content": "write notes.md"}],
        },
        initialized=True,
        interactive_approval=True,
        brain_container=server._BRAIN_CONTAINER,
        logger=server.logger,
        write_message=written_messages.append,
        read_message=lambda: {},
    )

    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "completed"
    turn_events = [
        message["params"]
        for message in written_messages
        if message.get("method") == TURN_EVENT_METHOD
    ]
    assert [event["type"] for event in turn_events] == [
        "tool_approval_requested",
        "tool_approval_resolved",
    ]
    assert [event["event_id"] for event in turn_events] == [
        "req-canonical-approval:approval:requested:call-canonical-approval",
        "req-canonical-approval:approval:resolved:call-canonical-approval",
    ]
    assert turn_events[0]["payload"]["approval_state"] == "pending"
    assert turn_events[0]["payload"]["approval_plan_hash"] == "hash-canonical-approval"
    assert turn_events[1]["payload"]["approved"] is True
    assert turn_events[1]["payload"]["approval_state"] == "approved"


def test_process_chat_send_request_cache_miss_after_approval_returns_chat_error(
    monkeypatch,
) -> None:
    approval_plan = SimpleNamespace(call_id="call-miss-1", request_id="req-miss-1")
    monkeypatch.setattr(request_dispatch, "_APPROVAL_PLAN_CACHE", ApprovalPlanCache())

    monkeypatch.setattr(
        request_dispatch,
        "build_chat_send_response",
        lambda *args, **kwargs: ChatResponse(
            request_id="req-miss-1",
            result={"request_id": "req-miss-1", "status": "awaiting_approval"},
            notifications=[],
            approval_request={
                "request_id": "req-miss-1",
                "tool_name": "write_file",
                "tool_input": {"path": "notes.md"},
                "mode": "chat",
                "tool_call_id": "call-miss-1",
            },
            approval_plan=approval_plan,
        ),
    )

    def _approve_then_evict(*args: object, **kwargs: object) -> bool:
        _ = args, kwargs
        request_dispatch._APPROVAL_PLAN_CACHE.evict("req-miss-1", "call-miss-1")
        return True

    monkeypatch.setattr(request_dispatch, "request_tool_approval", _approve_then_evict)

    outcome = request_dispatch.process_chat_send_request(
        message_id=992,
        params={
            "accept_version": API_VERSION,
            "request_id": "req-miss-1",
            "messages": [{"role": "user", "content": "write notes.md"}],
        },
        initialized=True,
        interactive_approval=True,
        brain_container=server._BRAIN_CONTAINER,
        logger=server.logger,
        write_message=lambda _message: None,
        read_message=lambda: {},
    )

    assert outcome.response is not None
    assert outcome.response["error"]["data"]["code"] == CMP_CHAT_STREAM_FAILED
    assert "sidecar_crash_pre_approval" in outcome.response["error"]["message"]
    assert outcome.notifications[0]["method"] == "chat.error"


def test_process_chat_send_request_preserves_terminal_result_after_approval(
    monkeypatch,
) -> None:
    approval_plan = SimpleNamespace(call_id="call-preempted-1", request_id="req-preempted-1")
    monkeypatch.setattr(request_dispatch, "_APPROVAL_PLAN_CACHE", ApprovalPlanCache())

    monkeypatch.setattr(
        request_dispatch,
        "build_chat_send_response",
        lambda *args, **kwargs: ChatResponse(
            request_id="req-preempted-1",
            result={"request_id": "req-preempted-1", "status": "awaiting_approval"},
            notifications=[],
            approval_request={
                "request_id": "req-preempted-1",
                "tool_name": "write_file",
                "tool_input": {"path": "notes.md"},
                "mode": "chat",
                "tool_call_id": "call-preempted-1",
            },
            approval_plan=approval_plan,
        ),
    )
    monkeypatch.setattr(request_dispatch, "request_tool_approval", lambda *args, **kwargs: True)
    monkeypatch.setattr(
        request_dispatch,
        "resume_chat_send_response_from_approval_plan",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            request_dispatch.InnerRetryableTurnError(
                reason="approval plan drifted before execution (execution_context).",
                retry_prompt="retry with fresh plan",
                terminal_subcode="approval_plan_drift",
            )
        ),
    )

    outcome = request_dispatch.process_chat_send_request(
        message_id=9931,
        params={
            "accept_version": API_VERSION,
            "request_id": "req-preempted-1",
            "messages": [{"role": "user", "content": "write notes.md"}],
        },
        initialized=True,
        interactive_approval=True,
        brain_container=server._BRAIN_CONTAINER,
        logger=server.logger,
        write_message=lambda _message: None,
        read_message=lambda: {},
    )

    assert outcome.response is not None
    assert outcome.response["result"] == {
        "api_version": API_VERSION,
        "request_id": "req-preempted-1",
        "status": "preempted",
        "terminal_subcode": "plan_drift",
    }
    assert outcome.notifications == []


def test_process_chat_send_request_maps_approval_timeout_to_timeout_terminal_subcode(
    monkeypatch,
    caplog,
) -> None:
    approval_plan = SimpleNamespace(call_id="call-timeout-1", request_id="req-timeout-1")
    monkeypatch.setattr(request_dispatch, "_APPROVAL_PLAN_CACHE", ApprovalPlanCache())

    def _build_with_pending_approval(*args: object, **kwargs: object) -> ChatResponse:
        return ChatResponse(
            request_id="req-timeout-1",
            result={"request_id": "req-timeout-1", "status": "awaiting_approval"},
            notifications=[],
            approval_request={
                "request_id": "req-timeout-1",
                "tool_name": "write_file",
                "tool_input": {"path": "notes.md"},
                "mode": "chat",
                "tool_call_id": "call-timeout-1",
            },
            approval_plan=approval_plan,
        )

    monkeypatch.setattr(request_dispatch, "build_chat_send_response", _build_with_pending_approval)
    monkeypatch.setattr(
        request_dispatch,
        "request_tool_approval",
        lambda *args, **kwargs: ApprovalResolution(False, "timeout"),
    )

    with caplog.at_level("INFO"):
        outcome = request_dispatch.process_chat_send_request(
            message_id=994,
            params={
                "accept_version": API_VERSION,
                "request_id": "req-timeout-1",
                "messages": [{"role": "user", "content": "write notes.md"}],
            },
            initialized=True,
            interactive_approval=True,
            brain_container=server._BRAIN_CONTAINER,
            logger=server.logger,
            write_message=lambda _message: None,
            read_message=lambda: {},
        )

    assert outcome.response is not None
    assert outcome.response["result"]["request_id"] == "req-timeout-1"
    assert outcome.response["result"]["status"] == "timeout"
    assert outcome.response["result"]["terminal_subcode"] == "approval"
    assert outcome.notifications == []
    timeout_records = [
        record
        for record in caplog.records
        if getattr(record, "event", "") == "sidecar.runtime.chat_send.approval_timeout"
    ]
    assert timeout_records
    assert timeout_records[-1].status == "timeout"


def test_approval_wait_extends_the_original_work_deadline_before_resume(
    monkeypatch,
) -> None:
    approval_plan = SimpleNamespace(
        call_id="call-expired-after-approval",
        request_id="req-expired-after-approval",
        wall_clock_deadline=101.0,
    )
    monkeypatch.setattr(request_dispatch, "_APPROVAL_PLAN_CACHE", ApprovalPlanCache())
    monkeypatch.setattr(
        request_dispatch,
        "build_chat_send_response",
        lambda *args, **kwargs: ChatResponse(
            request_id="req-expired-after-approval",
            result={"request_id": "req-expired-after-approval", "status": "awaiting_approval"},
            notifications=[],
            approval_request={
                "request_id": "req-expired-after-approval",
                "tool_name": "write_file",
                "tool_input": {"path": "notes.md"},
                "mode": "chat",
                "tool_call_id": "call-expired-after-approval",
            },
            approval_plan=approval_plan,
        ),
    )
    monotonic_values = iter((100.0, 102.0))
    monkeypatch.setattr(request_dispatch_chat, "monotonic", lambda: next(monotonic_values))
    monkeypatch.setattr(
        request_dispatch,
        "request_tool_approval",
        lambda *args, **kwargs: ApprovalResolution(True, "approved"),
    )
    resumed_deadlines = []

    def _resume(credited_plan, *args, **kwargs):
        resumed_deadlines.append(credited_plan.wall_clock_deadline)
        return ChatResponse(
            request_id="req-expired-after-approval",
            result={"request_id": "req-expired-after-approval", "status": "completed"},
            notifications=[],
            approval_request=None,
        )

    monkeypatch.setattr(
        request_dispatch,
        "resume_chat_send_response_from_approval_plan",
        _resume,
    )

    outcome = request_dispatch.process_chat_send_request(
        message_id=9941,
        params={
            "accept_version": API_VERSION,
            "request_id": "req-expired-after-approval",
            "messages": [{"role": "user", "content": "write notes.md"}],
        },
        initialized=True,
        interactive_approval=True,
        brain_container=server._BRAIN_CONTAINER,
        logger=server.logger,
        write_message=lambda _message: None,
        read_message=lambda: {},
    )

    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "completed"
    assert resumed_deadlines == [103.0]


def test_process_chat_send_request_emits_chat_error_on_approval_denial(
    monkeypatch,
    caplog,
) -> None:
    approval_plan = SimpleNamespace(call_id="call-denied-1", request_id="req-denied-1")
    monkeypatch.setattr(request_dispatch, "_APPROVAL_PLAN_CACHE", ApprovalPlanCache())

    def _build_with_pending_approval(*args: object, **kwargs: object) -> ChatResponse:
        return ChatResponse(
            request_id="req-denied-1",
            result={"request_id": "req-denied-1", "status": "awaiting_approval"},
            notifications=[],
            approval_request={
                "request_id": "req-denied-1",
                "tool_name": "write_file",
                "tool_input": {"path": "notes.md"},
                "mode": "chat",
                "tool_call_id": "call-denied-1",
            },
            approval_plan=approval_plan,
        )

    monkeypatch.setattr(request_dispatch, "build_chat_send_response", _build_with_pending_approval)
    monkeypatch.setattr(
        request_dispatch,
        "request_tool_approval",
        lambda *args, **kwargs: ApprovalResolution(False, "denied"),
    )

    with caplog.at_level("INFO"):
        outcome = request_dispatch.process_chat_send_request(
            message_id=995,
            params={
                "accept_version": API_VERSION,
                "request_id": "req-denied-1",
                "messages": [{"role": "user", "content": "write notes.md"}],
            },
            initialized=True,
            interactive_approval=True,
            brain_container=server._BRAIN_CONTAINER,
            logger=server.logger,
            write_message=lambda _message: None,
            read_message=lambda: {},
        )

    assert outcome.response is not None
    assert outcome.response["result"]["request_id"] == "req-denied-1"
    assert outcome.response["result"]["status"] == "denied"
    assert outcome.response["result"]["terminal_subcode"] == "user_explicit"
    assert len(outcome.notifications) == 1
    rejection_notification = outcome.notifications[0]
    assert rejection_notification["method"] == "chat.error"
    rejection_params = rejection_notification["params"]
    assert rejection_params["code"] == "CMP-APPROVAL-REJECTED"
    assert rejection_params["request_id"] == "req-denied-1"
    assert rejection_params["message"] == "User rejected approval for write_file"
    assert rejection_params["retryable"] is False
    denial_records = [
        record
        for record in caplog.records
        if getattr(record, "event", "") == "sidecar.runtime.chat_send.approval_denied"
    ]
    assert denial_records
    assert denial_records[-1].status == "denied"
    assert denial_records[-1].data["terminal_subcode"] == "user_explicit"


def test_process_message_background_run_retires_sub_agent_tasks(tmp_path) -> None:
    fake_container = SimpleNamespace(
        stack=SimpleNamespace(
            raw_config={"background_runtime_root": str(tmp_path)},
            secrets={},
            config=RuntimeConfig(background_runtime_root=str(tmp_path)),
        ),
        subprocess_manager=None,
    )
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(server, "_BRAIN_CONTAINER", fake_container)
    try:
        message = {
            "jsonrpc": "2.0",
            "id": 15_2,
            "method": "background.run",
            "params": {
                "accept_version": API_VERSION,
                "task": "sub_agent_verification",
                "task_id": "builtin:sub_agent_verification",
            },
        }

        outcome = server.process_message(message, initialized=True)
    finally:
        monkeypatch.undo()

    assert outcome.response is not None
    assert outcome.response["result"]["status"] == "skipped"
    assert outcome.response["result"]["task"] == "sub_agent_verification"
    assert outcome.response["result"]["reason"] == "unknown_task"


def test_process_message_background_run_rejects_missing_task_with_cmp_code(tmp_path) -> None:
    fake_container = SimpleNamespace(
        stack=SimpleNamespace(
            raw_config={"background_runtime_root": str(tmp_path)},
            secrets={},
            config=RuntimeConfig(background_runtime_root=str(tmp_path)),
        ),
        subprocess_manager=None,
    )
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(server, "_BRAIN_CONTAINER", fake_container)
    try:
        message = {
            "jsonrpc": "2.0",
            "id": 15_25,
            "method": "background.run",
            "params": {"accept_version": API_VERSION},
        }

        outcome = server.process_message(message, initialized=True)
    finally:
        monkeypatch.undo()

    assert outcome.response is not None
    assert outcome.response["error"]["code"] == -32602
    assert outcome.response["error"]["data"]["code"] == CMP_BACKGROUND_INVALID_PARAMS
    assert outcome.response["error"]["data"]["detail"] == "task is required"


def test_background_message_reader_close_does_not_close_blocked_buffer_cross_thread() -> None:
    unblock_reader = threading.Event()

    def reader() -> dict[str, object]:
        unblock_reader.wait(timeout=1.0)
        raise EOFError("stdin closed")

    message_reader = server.BackgroundMessageReader(reader)

    with pytest.raises(TimeoutError):
        message_reader.read(timeout_seconds=0.01)

    first_result = message_reader.close(join_timeout_seconds=0.05)

    assert first_result.drained is False
    assert first_result.worker_alive is True
    unblock_reader.set()
    assert message_reader.close(join_timeout_seconds=0.25).drained is True
    with pytest.raises(EOFError, match="closed"):
        message_reader.read()


def test_background_message_reader_queue_stays_bounded_under_backpressure() -> None:
    counter = {"value": 0}

    def reader() -> dict[str, object]:
        counter["value"] += 1
        return {"count": counter["value"]}

    message_reader = server.BackgroundMessageReader(reader)

    first = message_reader.read(timeout_seconds=0.05)
    assert first["count"] == 1

    for _ in range(200):
        if message_reader._queue.full():
            break
        threading.Event().wait(0.01)

    assert message_reader._queue.qsize() <= message_reader._queue.maxsize
    assert message_reader._queue.full() is True

    message_reader.close(join_timeout_seconds=0.5)
    assert message_reader._thread is not None
    assert message_reader._thread.is_alive() is False


def test_background_message_reader_close_unblocks_full_queue_producer() -> None:
    def reader() -> dict[str, object]:
        return {"message": "queued"}

    message_reader = server.BackgroundMessageReader(reader)

    _ = message_reader.read(timeout_seconds=0.05)
    for _ in range(200):
        if message_reader._queue.full():
            break
        threading.Event().wait(0.01)

    assert message_reader._queue.full() is True

    message_reader.close(join_timeout_seconds=0.5)
    assert message_reader._thread is not None
    assert message_reader._thread.is_alive() is False


def test_main_closes_background_reader_on_shutdown(monkeypatch) -> None:
    state = {"reader_closed": False, "manager_closed": False}
    raw_messages = iter(
        [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "accept_version": API_VERSION,
                    "config": {
                        "feature_flags": {
                            "multiplexer": True,
                            "chat_cancel": True,
                        }
                    },
                },
            }
        ]
    )

    class FakeReader:
        def __init__(self, _reader) -> None:
            pass

        def read(self, timeout_seconds: float | None = None) -> dict[str, object]:
            _ = timeout_seconds
            return {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "shutdown",
                "params": {"accept_version": API_VERSION},
            }

        def close(self, join_timeout_seconds: float = 1.0) -> SimpleNamespace:
            _ = join_timeout_seconds
            state["reader_closed"] = True
            return SimpleNamespace(drained=True, worker_alive=False)

    class FakeManager:
        def close(self, *, timeout_seconds: float = 0.0) -> SimpleNamespace:
            _ = timeout_seconds
            state["manager_closed"] = True
            return SimpleNamespace(
                drained=True,
                child_count=0,
                reservation_count=0,
                unreaped_count=0,
                manager_count=1,
            )

    monkeypatch.setattr(server, "configure_logging", lambda: None)
    monkeypatch.setattr(server, "BackgroundMessageReader", FakeReader)
    # Patch the class, not the singleton instance: close() only exists on
    # BrainContainer's class body, so monkeypatch.setattr(instance, "close", ...)
    # would capture the bound method via getattr() as the "old value" and, on
    # undo(), re-plant that bound method directly into the instance __dict__
    # (Python has no way to "unset" an instance attribute back to a class
    # method) -- permanently shadowing the class method and leaking a stray
    # `close` instance attribute onto the process-global singleton for the
    # rest of the pytest session, tripping BrainContainer.assert_request_boundary.
    monkeypatch.setattr(
        type(server._BRAIN_CONTAINER),
        "close",
        lambda self: state.setdefault("container_closed", True),
    )
    monkeypatch.setattr(server, "_SUBPROCESS_MANAGER", FakeManager())
    monkeypatch.setattr(server, "read_message", lambda: next(raw_messages))
    monkeypatch.setattr(server, "write_message", lambda _message: None)
    monkeypatch.setattr(server, "shutdown_sidecar_logging", lambda **_kwargs: None)

    server.main()

    assert state["reader_closed"] is True
    assert state["manager_closed"] is True
    assert state["container_closed"] is True
