"""``plan_usage`` attach coverage for the chat.done / chat.error render seam.

``_chat_response_from_decision`` (chat_decision_render.py) is the terminal
decision -> notification serializer used by the non-streaming path. This
covers both notification branches it can emit: the ``chat.done`` usage
payload (success) and the ``chat.error`` payload (terminal-error branch) --
mirroring the fixture pattern in
``tests/sidecar/ai/routing/test_stream_incomplete_surfacing.py``.
"""

from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace
from typing import Any, Iterator

from sidecar.ai.tools.models import GenerationResult
from sidecar.protocol import CHAT_DONE_METHOD, CHAT_ERROR_METHOD
from sidecar.runtime.chat_decision_render import _chat_response_from_decision
from sidecar.runtime.chat_models import ChatRequestContext
from sidecar.runtime.local_engine.request_context import (
    clear_request_context,
    current_request_context,
    install_request_context,
)
from tests.sidecar.ai.routing.test_stream_incomplete_surfacing import _Engine, _decision_for

_SNAPSHOT = {
    "schema_version": 1,
    "primary": {"used_percent": 62.0, "window_minutes": 300, "reset_at": 1756800000},
}


@contextmanager
def _bound_engine(request_id: str, *, snapshot: dict[str, Any] | None) -> Iterator[Any]:
    engine = _Engine(GenerationResult(content="", finish_reason="stop"))
    install_request_context(engine, request_id=request_id)
    try:
        if snapshot is not None:
            context = current_request_context(engine)
            assert context is not None
            context["plan_usage"] = snapshot
        yield engine
    finally:
        clear_request_context(engine)


def _brain(*, engine: Any, feature_flags: dict[str, bool]) -> Any:
    return SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                background_runtime_root=None,
                engine_type="chatgpt",
                feature_flags=feature_flags,
                max_inline_payload_bytes=65_536,
                model="gpt-5.5",
            ),
            engine=engine,
            tool_observations=None,
            turn_diagnostics=None,
        )
    )


def _find_notification(response: Any, method: str) -> dict[str, Any]:
    for entry in response.notifications:
        if entry.get("method") == method:
            return entry
    raise AssertionError(f"no {method!r} notification in {response.notifications!r}")


def _render(
    *,
    engine: Any,
    feature_flags: dict[str, bool],
    finish_reason: str,
    request_id: str,
) -> Any:
    decision = _decision_for(finish_reason)
    brain = _brain(engine=engine, feature_flags=feature_flags)
    return _chat_response_from_decision(
        request_context=ChatRequestContext(
            request_id=request_id,
            trace_id=None,
            session_id=None,
            mode="chat",
            approvals_pre_granted=False,
        ),
        latest_user_content="Answer the question.",
        canonical_session_messages=[],
        session_title="",
        brain_container=brain,
        decision=decision,
    )


def test_chat_done_usage_carries_plan_usage_when_enabled() -> None:
    with _bound_engine("req_plan_usage_done", snapshot=_SNAPSHOT) as engine:
        response = _render(
            engine=engine,
            feature_flags={"chatgpt_plan_meter": True},
            finish_reason="stop",
            request_id="req_plan_usage_done",
        )

    done = _find_notification(response, CHAT_DONE_METHOD)
    assert done["params"]["usage"]["plan_usage"] == _SNAPSHOT


def test_chat_error_terminal_branch_carries_plan_usage_when_enabled() -> None:
    with _bound_engine("req_plan_usage_err", snapshot=_SNAPSHOT) as engine:
        response = _render(
            engine=engine,
            feature_flags={"chatgpt_plan_meter": True},
            finish_reason="incomplete",
            request_id="req_plan_usage_err",
        )

    error = _find_notification(response, CHAT_ERROR_METHOD)
    assert error["params"]["plan_usage"] == _SNAPSHOT


def test_flag_off_removes_plan_usage_from_both_branches() -> None:
    with _bound_engine("req_plan_usage_off_done", snapshot=_SNAPSHOT) as engine:
        done_response = _render(
            engine=engine,
            feature_flags={"chatgpt_plan_meter": False},
            finish_reason="stop",
            request_id="req_plan_usage_off_done",
        )
    done = _find_notification(done_response, CHAT_DONE_METHOD)
    assert "plan_usage" not in done["params"]["usage"]

    with _bound_engine("req_plan_usage_off_err", snapshot=_SNAPSHOT) as engine:
        error_response = _render(
            engine=engine,
            feature_flags={"chatgpt_plan_meter": False},
            finish_reason="incomplete",
            request_id="req_plan_usage_off_err",
        )
    error = _find_notification(error_response, CHAT_ERROR_METHOD)
    assert "plan_usage" not in error["params"]


def test_no_snapshot_omits_plan_usage_key_even_when_enabled() -> None:
    with _bound_engine("req_plan_usage_missing", snapshot=None) as engine:
        response = _render(
            engine=engine,
            feature_flags={"chatgpt_plan_meter": True},
            finish_reason="stop",
            request_id="req_plan_usage_missing",
        )

    done = _find_notification(response, CHAT_DONE_METHOD)
    assert "plan_usage" not in done["params"]["usage"]
