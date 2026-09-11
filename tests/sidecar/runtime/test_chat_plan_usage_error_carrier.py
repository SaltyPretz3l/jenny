"""Router-path terminal errors carry the plan-usage snapshot to `chat.error`.

A ChatGPT 429 on the tool-loop/router path surfaces as ``ToolExecutionFailure``
-> ``ChatRequestError`` out of ``build_chat_send_response``; the ``chat.error``
notification is only built later by ``chat_error_notification``, after the
request context (and the stash) is gone. ``chat.py`` therefore copies the
snapshot onto ``error.data`` before re-raising, and ``chat_error_notification``
merges ``error.data`` top-level -> ``params.plan_usage``.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

import sidecar.runtime.chat as chat_module
import sidecar.runtime.chat_resume as resume_module
from sidecar.runtime.chat import build_chat_send_response
from sidecar.runtime.chat_helpers import chat_error_notification
from sidecar.runtime.chat_models import ChatRequestError
from sidecar.runtime.local_engine.request_context import (
    clear_request_context,
    current_request_context,
    install_request_context,
)
from sidecar.runtime.plan_usage_snapshot import record_plan_usage_snapshot
from tests.sidecar.runtime.test_chat import _build_approval_plan_for_chat_tests
from tests.sidecar.runtime.test_chat_dark_paths import _make_brain_container, _TextOnlyEngine

_HEADERS = {
    "x-codex-primary-used-percent": "100",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": "1756800000",
    "x-codex-rate-limit-reached-type": "primary",
}
_EXPECTED = {
    "schema_version": 1,
    "primary": {"used_percent": 100.0, "window_minutes": 300, "reset_at": 1756800000},
    "rate_limit_reached_type": "primary",
}


class _BindableEngine(_TextOnlyEngine):
    """Minimal engine with the request-context binding hooks chat.py drives."""

    def begin_request_context(self, **kwargs: Any) -> None:
        install_request_context(self, request_id=str(kwargs.get("request_id") or "req"))

    def clear_request_context(self, *, request_id: str) -> None:  # noqa: ARG002
        clear_request_context(self)


def _raise_rate_limited_after_stash(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_router_response(**kwargs: Any) -> Any:
        engine = kwargs["brain_container"].stack.engine
        assert current_request_context(engine) is not None, "chat.py must bind before routing"
        record_plan_usage_snapshot(engine, SimpleNamespace(headers=_HEADERS))
        raise ChatRequestError(
            request_id=kwargs["request_context"].request_id,
            trace_id=None,
            session_id=None,
            code="CMP-LOOP-0010",
            message="provider rate limited",
            rpc_code=-32602,
            retryable=True,
            data=None,
        )

    monkeypatch.setattr(chat_module, "_build_router_response", fake_router_response)


def _send(
    engine: _BindableEngine, feature_flags: dict[str, bool], writer: Any = None
) -> ChatRequestError:
    brain = _make_brain_container(
        SimpleNamespace(),  # the router is never reached: _build_router_response is patched
        feature_flags=feature_flags,
        engine=engine,
    )
    with pytest.raises(ChatRequestError) as caught:
        build_chat_send_response(
            "msg-plan-429",
            {"request_id": "req-plan-429", "messages": [{"role": "user", "content": "hi"}]},
            approvals_pre_granted=True,
            brain_container=brain,
            invalid_params_code=-32602,
            stream_notifications=writer is not None,
            notification_writer=writer,
        )
    return caught.value


@pytest.mark.parametrize("enabled", [True, False])
def test_live_plan_usage_is_emitted_before_terminal_error_and_cleared(
    monkeypatch: pytest.MonkeyPatch, enabled: bool
) -> None:
    _raise_rate_limited_after_stash(monkeypatch)
    messages: list[dict[str, Any]] = []
    engine = _BindableEngine()
    _send(engine, {"chatgpt_plan_meter": enabled, "context_usage_live": False}, messages.append)
    readings = [m for m in messages if m.get("method") == "chat.plan_usage"]
    assert len(readings) == int(enabled)
    if enabled:
        assert readings[0]["params"]["plan_usage"] == _EXPECTED
        assert readings[0]["params"]["request_id"] == "req-plan-429"
    assert current_request_context(engine) is None
    record_plan_usage_snapshot(engine, SimpleNamespace(headers=_HEADERS))
    assert len([m for m in messages if m.get("method") == "chat.plan_usage"]) == len(readings)


def test_router_path_chat_request_error_carries_plan_usage(monkeypatch: pytest.MonkeyPatch) -> None:
    _raise_rate_limited_after_stash(monkeypatch)
    engine = _BindableEngine()

    error = _send(engine, {"chatgpt_plan_meter": True})

    assert current_request_context(engine) is None, "request context is cleared on the way out"
    assert error.data == {"plan_usage": _EXPECTED}
    params = chat_error_notification(error)["params"]
    assert params["plan_usage"] == _EXPECTED
    assert params["code"] == "CMP-LOOP-0010"
    assert params["retryable"] is True


def test_router_path_flag_off_leaves_error_data_untouched(monkeypatch: pytest.MonkeyPatch) -> None:
    _raise_rate_limited_after_stash(monkeypatch)

    error = _send(_BindableEngine(), {"chatgpt_plan_meter": False})

    assert error.data == {}
    assert "plan_usage" not in chat_error_notification(error)["params"]


def test_approval_resume_rebinds_live_usage_after_the_original_context_clears(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = _BindableEngine()
    _raise_rate_limited_after_stash(monkeypatch)
    original_messages: list[dict[str, Any]] = []
    _send(engine, {}, original_messages.append)
    assert current_request_context(engine) is None
    plan = _build_approval_plan_for_chat_tests(remaining_iterations=1)
    brain = _make_brain_container(SimpleNamespace(), feature_flags={}, engine=engine)
    resumed_messages: list[dict[str, Any]] = []

    def provider_response_in_resumed_scope(**_kwargs: Any) -> Any:
        assert current_request_context(engine) is not None
        record_plan_usage_snapshot(engine, SimpleNamespace(headers=_HEADERS))
        return "resumed"

    monkeypatch.setattr(resume_module, "execute_with_inner_turn_retry", provider_response_in_resumed_scope)
    result = resume_module.resume_chat_send_response_from_approval_plan(
        plan, brain_container=brain, stream_notifications=True,
        notification_writer=resumed_messages.append,
    )
    assert result == "resumed"
    assert len(resumed_messages) == 1
    assert resumed_messages[0]["method"] == "chat.plan_usage"
    assert resumed_messages[0]["params"]["plan_usage"] == _EXPECTED
    assert len(original_messages) == 1
    assert current_request_context(engine) is None
