import json
from dataclasses import asdict
from pathlib import Path

import pytest

from sidecar.ai.feature_flags import FEATURE_AGENT_EXECUTOR
from sidecar.ai.routing.router import ChatDecision
from sidecar.runtime.chat import ChatRequestError, build_chat_send_response
from tests.sidecar.runtime.test_chat import _build_brain_container
from tests.sidecar.runtime.test_inference_admission import _execution_context


def _fixture(tmp_path: Path):
    decision = ChatDecision(thinking_text=None, response_text="ok",
                            approval_request=None, tool_results=())
    container = _build_brain_container(decision, engine_type="ollama")
    params = {"request_id": "request_1", "session_id": "session_1",
              "messages": [{"role": "user", "content": "hello"}],
              "execution_context": json.loads(json.dumps(asdict(_execution_context(tmp_path)))),
              "inference_budget_required": True}
    return container, params


def _send(container, params, *, streaming=False):
    return build_chat_send_response(
        "message_1", params, approvals_pre_granted=True, brain_container=container,
        invalid_params_code=-32602, stream_notifications=streaming,
        notification_writer=lambda _message: None,
    )


@pytest.mark.parametrize("value", [None, 1, "true", {}, []])
def test_invalid_budget_flag_is_refused_at_real_chat_entry(tmp_path, value):
    container, params = _fixture(tmp_path)
    params["inference_budget_required"] = value
    with pytest.raises(ChatRequestError, match="must be a boolean"):
        _send(container, params)
    assert container.stack.router.last_kwargs == {}


def test_required_budget_without_authority_is_refused(tmp_path):
    container, params = _fixture(tmp_path)
    del params["execution_context"]
    with pytest.raises(ChatRequestError, match="requires execution context"):
        _send(container, params)
    assert container.stack.router.last_kwargs == {}


def test_required_budget_cannot_take_unadmitted_live_stream_path(tmp_path, monkeypatch):
    container, params = _fixture(tmp_path)
    container.stack.config.feature_flags = {FEATURE_AGENT_EXECUTOR: False}
    calls = []
    monkeypatch.setattr(container.stack.engine, "stream", lambda **_kwargs: calls.append("provider"), raising=False)
    with pytest.raises(ChatRequestError, match="requires the admitted router"):
        _send(container, params, streaming=True)
    assert calls == []
    assert container.stack.router.last_kwargs == {}


@pytest.mark.parametrize("streaming", [False, True])
def test_real_router_preserves_required_budget_callback(tmp_path, streaming):
    container, params = _fixture(tmp_path)
    container.stack.config.feature_flags = {FEATURE_AGENT_EXECUTOR: True}
    _send(container, params, streaming=streaming)
    runtime = container.stack.router.last_kwargs["runtime"]
    assert runtime.request_context.inference_budget_required is True
    assert runtime.inference_admission.requires_budget is True
    # The request cannot silently downgrade when its bridge is unavailable.
    assert runtime.inference_admission is not None


def test_legacy_router_does_not_require_budget(tmp_path):
    container, params = _fixture(tmp_path)
    del params["inference_budget_required"]
    _send(container, params)
    runtime = container.stack.router.last_kwargs["runtime"]
    assert runtime.request_context.inference_budget_required is False
    assert runtime.inference_admission.requires_budget is False


@pytest.mark.parametrize("value", [None, 1, "true", {}, []])
def test_malformed_child_flags_fail_before_router(tmp_path, value):
    container, params = _fixture(tmp_path)
    params["runtime_children_enabled"] = value
    with pytest.raises(ChatRequestError, match="child flags must be booleans"):
        _send(container, params)
    assert container.stack.router.last_kwargs == {}


def test_child_capability_requires_admitted_continuation(tmp_path):
    container, params = _fixture(tmp_path)
    params["runtime_children_enabled"] = True
    with pytest.raises(ChatRequestError, match="require admitted continuation"):
        _send(container, params)
    assert container.stack.router.last_kwargs == {}


def test_child_read_only_reaches_real_router_without_changing_plan_mode(tmp_path):
    container, params = _fixture(tmp_path)
    params["runtime_child_read_only"] = True
    _send(container, params)
    context = container.stack.router.last_kwargs["runtime"].request_context
    assert context.read_only is True
    assert context.plan_mode is False
    assert context.runtime_children_enabled is False
