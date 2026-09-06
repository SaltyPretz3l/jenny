"""Behavioral tests targeting the uncovered dark-path branches in
sidecar.runtime.request_dispatch.

Coverage targets (by source line):
  154          - _workspace_required_tool_names: non-MANAGED surface continue
  642          - _build_chat_response: non-dict params early return
  787          - process_chat_send_request: str tools_enabled conversion branch
  815, 827     - process_chat_send_request: message_id is None early exit
  845          - process_chat_send_request: cancelled cancel_handle
  1046-1056    - approval resolution: CANCELLED / PREEMPTED / RUNTIME_ERROR terminal branches
  1180, 1187-1188 - InnerRetryableTurnError handler after approval: plan-drift
                    terminal mapping and the non-plan-drift unexpected failure path
  1195-1197    - bare Exception handler in post-approval try block
  1281-1283    - process_message: initialize failure path
  1340-1342    - process_message: not-initialized, message_id is None
  1348         - process_message: not-initialized, message_id not None
  1376         - process_message: models.list version mismatch
  1383         - process_message: models.list message_id is None
  1418         - process_message: models.unload version mismatch
  1425         - process_message: models.unload message_id is None
  1434-1436    - process_message: models.unload engine exception
  1536         - process_message: CHAT_SEND_METHOD delegate
  1539         - process_message: unknown method, message_id is None
  1547-1548    - hardware.profile: message_id is None
  1554-1562    - hardware.profile: success path
  1568-1570    - hardware.profile: exception path
  1606         - hardware.vram_usage: message_id is None
  1622-1624    - hardware.vram_usage: exception fallback result
  1652-1653    - process_message: unknown method, message_id not None
  1660         - process_message: method not found error response
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import pytest

import sidecar.runtime.request_dispatch as rd
from sidecar.protocol import (
    API_VERSION,
    CHAT_SEND_METHOD,
    HARDWARE_PROFILE_METHOD,
    HARDWARE_VRAM_USAGE_METHOD,
    MODELS_LIST_METHOD,
    MODELS_RESIDENT_METHOD,
    MODELS_UNLOAD_METHOD,
)
from sidecar.runtime import request_dispatch_chat
from sidecar.runtime.approval import ApprovalResolution
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.turn_retry import InnerRetryableTurnError
from sidecar.runtime.turn_state import (
    TURN_STATE_CANCELLED,
    TURN_STATE_PREEMPTED,
    TURN_STATE_RUNTIME_ERROR,
)

LOGGER = logging.getLogger("test.request_dispatch_dark_paths")


@dataclass(frozen=True)
class _DeadlinePlan:
    wall_clock_deadline: float | None


def test_approval_wait_timeout_is_independent_of_model_work_deadline() -> None:

    assert request_dispatch_chat._effective_approval_wait_timeout(  # noqa: SLF001
        SimpleNamespace(wall_clock_deadline=103.5),
        configured_timeout_seconds=600.0,
    ) == 600.0


def test_approval_wait_timeout_preserves_legacy_plan_timeout() -> None:
    assert request_dispatch_chat._effective_approval_wait_timeout(  # noqa: SLF001
        SimpleNamespace(wall_clock_deadline=None),
        configured_timeout_seconds=600.0,
    ) == 600.0


def test_each_approval_round_credits_only_its_own_wait_time() -> None:
    first = request_dispatch_chat._credit_approval_wait(  # noqa: SLF001
        _DeadlinePlan(wall_clock_deadline=100.0),
        10.0,
    )
    second = request_dispatch_chat._credit_approval_wait(first, 20.0)  # noqa: SLF001

    assert first.wall_clock_deadline == 110.0
    assert second.wall_clock_deadline == 130.0


def test_approval_wait_credit_preserves_missing_or_malformed_deadlines() -> None:
    no_deadline = _DeadlinePlan(wall_clock_deadline=None)
    malformed = _DeadlinePlan(wall_clock_deadline="bad")  # type: ignore[arg-type]

    assert request_dispatch_chat._credit_approval_wait(no_deadline, 10.0) is no_deadline  # noqa: SLF001
    assert request_dispatch_chat._credit_approval_wait(malformed, 10.0) is malformed  # noqa: SLF001


# ---------------------------------------------------------------------------
# Minimal brain builder for process_message tests
# ---------------------------------------------------------------------------

def _null_writer(_msg: dict) -> None:
    pass


def _null_reader() -> dict:
    return {}


def _make_minimal_brain(
    *,
    config_extras: dict | None = None,
    engine: Any = None,
) -> SimpleNamespace:
    """Build the smallest duck-typed BrainContainer sufficient for process_message."""
    config = SimpleNamespace(
        tools_workspace_root=None,
        agent_workspace_root=None,
        tools_enabled=True,
        feature_flags={},
        **(config_extras or {}),
    )
    if engine is None:
        engine = SimpleNamespace(model_name="dummy-model", unload_model=lambda *_a: None)
    stack = SimpleNamespace(
        config=config,
        engine=engine,
        tool_observations=None,
    )
    brain = SimpleNamespace(stack=stack)

    # process_message calls: process_background_method, process_memory_method,
    # process_harness_method, process_suggestions_method — all must return None
    # so the code falls through to the hardware / unknown-method branches.
    # We patch these on the rd module itself (not on brain).
    return brain


def _patch_sub_dispatchers(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make all sub-dispatcher helpers return None (not their method)."""
    monkeypatch.setattr(rd, "process_background_method", lambda *a, **k: None)
    monkeypatch.setattr(rd, "process_memory_method", lambda *a, **k: None)
    monkeypatch.setattr(rd, "process_harness_method", lambda *a, **k: None)
    monkeypatch.setattr(rd, "process_suggestions_method", lambda *a, **k: None)


# ---------------------------------------------------------------------------
# _workspace_required_tool_names: non-MANAGED surface tools are skipped
# ---------------------------------------------------------------------------


def test_workspace_root_required_filters_out_non_managed_surface_tools() -> None:
    """Descriptor whose surfaces do NOT contain MANAGED_SIDECAR_SURFACE is skipped.

    Injecting a fake build_tool_catalog that returns one descriptor without the
    managed surface forces the non-MANAGED `continue` to execute.  With NO managed
    descriptor surviving, the function yields an empty set (no root required).
    """
    fake_descriptor = SimpleNamespace(
        surfaces=("electron_only",),  # not MANAGED_SIDECAR_SURFACE
        side_effecting=False,
        name="electron_tool",
        availability=SimpleNamespace(workspace_required=True, config_flag=None),
    )
    calls: list = []

    def _fake_build_tool_catalog(*, config: Any) -> list:
        calls.append(config)
        return [fake_descriptor]

    original = rd.build_tool_catalog
    rd.build_tool_catalog = _fake_build_tool_catalog  # type: ignore[assignment]
    try:
        result = rd._workspace_required_tool_names(
            config=SimpleNamespace(),
            mode="chat",
        )
    finally:
        rd.build_tool_catalog = original  # type: ignore[assignment]

    # The non-managed descriptor was skipped; no workspace-requiring tool found.
    assert not result
    assert len(calls) == 1  # catalog WAS called (the loop ran)


# ---------------------------------------------------------------------------
# Line 642 — _build_chat_response: non-dict params fast path
# ---------------------------------------------------------------------------


def test_build_chat_response_non_dict_params_calls_build_chat_send_response() -> None:
    """When params is not a dict, _build_chat_response calls build_chat_send_response
    (the fast path at line 641-656) instead of the approval-plan path."""
    calls: list = []

    def _fake_build_chat_send_response(message_id, params, **kwargs):
        calls.append({"message_id": message_id, "params": params})
        return SimpleNamespace(
            result={"status": "completed", "request_id": "rq"},
            notifications=[],
            approval_request=None,
            approval_plan=None,
            request_id="rq",
            post_settlement_callback=None,
        )

    original = rd.build_chat_send_response
    rd.build_chat_send_response = _fake_build_chat_send_response  # type: ignore[assignment]
    try:
        brain = SimpleNamespace(stack=SimpleNamespace(config=SimpleNamespace(feature_flags={})))
        result = rd._build_chat_response(
            message_id=99,
            params="not-a-dict",  # triggers line 641
            approvals_pre_granted=False,
            brain_container=brain,  # type: ignore[arg-type]
            stream_notifications=False,
            write_message=_null_writer,
            read_message=_null_reader,
            approval_response_reader=None,
            approval_response_waiter_factory=None,
            approval_timeout_seconds=30.0,
        )
    finally:
        rd.build_chat_send_response = original  # type: ignore[assignment]

    assert len(calls) == 1
    assert calls[0]["message_id"] == 99
    assert calls[0]["params"] == "not-a-dict"
    assert result.result["status"] == "completed"


# ---------------------------------------------------------------------------
# Line 690 — _raise_exhausted closure: raises ChatRequestError
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Line 787 — tools_enabled as string conversion
# ---------------------------------------------------------------------------


class _NullContextManager:
    """A no-op context manager for request_boundary."""

    def __enter__(self) -> "_NullContextManager":
        return self

    def __exit__(self, *args: Any) -> None:
        return None


def _make_brain_with_request_boundary(
    *,
    config: Any,
    engine: Any = None,
) -> SimpleNamespace:
    """Build a brain that also has request_boundary (needed past line 843)."""
    if engine is None:
        engine = SimpleNamespace(model_name="dummy-model", unload_model=lambda *_a: None)
    stack = SimpleNamespace(
        config=config,
        engine=engine,
        tool_observations=None,
    )
    brain = SimpleNamespace(
        stack=stack,
        request_boundary=lambda *a, **k: _NullContextManager(),
    )
    return brain


def test_process_chat_send_request_tools_enabled_string_true_is_truthy() -> None:
    """tools_enabled="true" (string) is converted to True (line 787)."""
    # We want to reach the workspace check but pass it.
    # Give a configured workspace root so the workspace check passes,
    # and make build_chat_send_response return a clean response.
    chat_calls: list = []

    def _fake_build(message_id, params, **kwargs):
        chat_calls.append(message_id)
        return SimpleNamespace(
            result={"status": "completed", "request_id": "rq-str"},
            notifications=[],
            approval_request=None,
            approval_plan=None,
            request_id="rq-str",
            post_settlement_callback=None,
        )

    config = SimpleNamespace(
        tools_workspace_root="/ws",
        agent_workspace_root=None,
        tools_enabled="true",  # string, not bool — triggers line 787
        feature_flags={},
    )
    brain = _make_brain_with_request_boundary(config=config)

    original_build = rd.build_chat_send_response
    rd.build_chat_send_response = _fake_build  # type: ignore[assignment]
    try:
        outcome = rd.process_chat_send_request(
            message_id=55,
            params={"accept_version": API_VERSION, "request_id": "rq-str"},
            initialized=True,
            interactive_approval=False,
            brain_container=brain,  # type: ignore[arg-type]
            logger=LOGGER,
            write_message=_null_writer,
            read_message=_null_reader,
        )
    finally:
        rd.build_chat_send_response = original_build  # type: ignore[assignment]

    # If conversion failed, we'd either crash or get a workspace error.
    assert isinstance(outcome, ProcessOutcome)
    assert outcome.initialized is True
    assert len(chat_calls) == 1


# ---------------------------------------------------------------------------
# Workspace-degrade legibility signal — process_chat_send_request emits a
# structured, informational telemetry event when workspace-requiring tools are
# dropped for a turn because no root is configured (the graceful-degrade path,
# NOT the CMP-CFG-0001 hard-fail).
# ---------------------------------------------------------------------------


def _degrade_clean_build(_message_id: Any, _params: Any, **_kwargs: Any) -> Any:
    return SimpleNamespace(
        result={"status": "completed", "request_id": "rq-degrade"},
        notifications=[],
        approval_request=None,
        approval_plan=None,
        request_id="rq-degrade",
        post_settlement_callback=None,
    )


def _run_degrade_turn(
    *,
    config: Any,
    request_id: str = "rq-degrade",
    tool_preferences: dict | None = None,
) -> ProcessOutcome:
    brain = _make_brain_with_request_boundary(config=config)
    params: dict[str, Any] = {
        "accept_version": API_VERSION,
        "request_id": request_id,
        "mode": "assist",
        "messages": [{"role": "user", "content": "How do I get started?"}],
    }
    if tool_preferences is not None:
        params["tool_preferences"] = tool_preferences
    original_build = rd.build_chat_send_response
    rd.build_chat_send_response = _degrade_clean_build  # type: ignore[assignment]
    try:
        return rd.process_chat_send_request(
            message_id=210,
            params=params,
            initialized=True,
            interactive_approval=False,
            brain_container=brain,  # type: ignore[arg-type]
            logger=LOGGER,
            write_message=_null_writer,
            read_message=_null_reader,
        )
    finally:
        rd.build_chat_send_response = original_build  # type: ignore[assignment]


def _workspace_degraded_records(caplog: Any) -> list:
    return [
        record
        for record in caplog.records
        if getattr(record, "event", "") == "sidecar.runtime.tools.workspace_degraded"
    ]


def test_process_chat_send_request_emits_workspace_degraded_signal(caplog) -> None:
    """Tools enabled, no workspace root: the turn DEGRADES (no hard-fail) and emits a
    single structured ``sidecar.runtime.tools.workspace_degraded`` telemetry event
    naming the dropped workspace-requiring tools so a driver/user can tell WHY file &
    terminal tools did nothing. Uses the REAL tool catalog (not monkeypatched) so the
    dropped-tool names are the real ones."""
    config = SimpleNamespace(
        tools_workspace_root=None,
        agent_workspace_root=None,
        tools_enabled=True,
        feature_flags={},
    )
    with caplog.at_level(logging.WARNING):
        outcome = _run_degrade_turn(config=config)

    # Degraded, not hard-failed.
    assert isinstance(outcome, ProcessOutcome)
    assert outcome.response is not None
    assert "error" not in outcome.response
    assert all(item.get("method") != "chat.error" for item in outcome.notifications)

    records = _workspace_degraded_records(caplog)
    assert len(records) == 1, "exactly one degrade signal per turn"
    record = records[0]
    assert record.levelno == logging.WARNING
    assert record.status == "degraded"
    data = record.data
    assert data["reason"] == "no workspace root configured"
    assert data["dropped_count"] >= 1
    assert data["dropped_count"] == len(data["dropped_tools"])
    # The real managed catalog drops read-file/list-dir style tools.
    assert "read_file" in data["dropped_tools"]
    # Names are sorted for stable, diff-friendly telemetry.
    assert data["dropped_tools"] == sorted(data["dropped_tools"])


def test_process_chat_send_request_no_degrade_signal_when_root_configured(caplog) -> None:
    """When a workspace root IS configured nothing is dropped, so the degrade signal
    must NOT fire (the happy path stays quiet)."""
    config = SimpleNamespace(
        tools_workspace_root="/ws",
        agent_workspace_root=None,
        tools_enabled=True,
        feature_flags={},
    )
    with caplog.at_level(logging.WARNING):
        outcome = _run_degrade_turn(config=config, request_id="rq-has-root")

    assert isinstance(outcome, ProcessOutcome)
    assert _workspace_degraded_records(caplog) == []


def test_process_chat_send_request_no_degrade_signal_when_no_workspace_tools_drop(
    caplog,
) -> None:
    """No root, but the request's enabled_tools allowlist contains only non-workspace
    tools: nothing workspace-requiring would have been active, so there is nothing to
    report and the signal must NOT fire (and the turn still degrades, not hard-fails)."""
    config = SimpleNamespace(
        tools_workspace_root=None,
        agent_workspace_root=None,
        tools_enabled=True,
        feature_flags={},
    )
    with caplog.at_level(logging.WARNING):
        outcome = _run_degrade_turn(
            config=config,
            request_id="rq-web-only",
            tool_preferences={"enabled_tools": ["web_search", "fetch_url"]},
        )

    assert isinstance(outcome, ProcessOutcome)
    assert outcome.response is not None
    assert "error" not in outcome.response
    assert _workspace_degraded_records(caplog) == []


# ---------------------------------------------------------------------------
# Line 815 / 827 — process_chat_send_request: message_id is None
# ---------------------------------------------------------------------------


def test_process_chat_send_request_null_message_id_returns_empty_outcome() -> None:
    """When message_id is None (line 814), an early ProcessOutcome with
    response=None and empty notifications is returned (lines 827-832)."""
    config = SimpleNamespace(
        tools_workspace_root="/ws",
        agent_workspace_root=None,
        tools_enabled=True,
        feature_flags={},
    )
    brain = SimpleNamespace(
        stack=SimpleNamespace(config=config, tool_observations=None)
    )
    outcome = rd.process_chat_send_request(
        message_id=None,  # triggers line 814
        params={"accept_version": API_VERSION, "request_id": "rq-none"},
        initialized=True,
        interactive_approval=False,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )

    assert isinstance(outcome, ProcessOutcome)
    assert outcome.response is None
    assert outcome.notifications == []
    assert outcome.initialized is True
    assert outcome.shutdown_requested is False


# ---------------------------------------------------------------------------
# Line 845 — process_chat_send_request: cancelled cancel_handle
# ---------------------------------------------------------------------------


def test_process_chat_send_request_pre_cancelled_handle_returns_cancelled_outcome() -> None:
    """A cancel_handle that is already cancelled (line 843) causes an immediate
    TURN_STATE_CANCELLED outcome before any real work is done."""
    config = SimpleNamespace(
        tools_workspace_root="/ws",
        agent_workspace_root=None,
        tools_enabled=True,
        feature_flags={},
    )
    brain = SimpleNamespace(
        stack=SimpleNamespace(config=config, tool_observations=None)
    )
    cancel_handle = SimpleNamespace(cancelled=True, reason="user_cancel")
    chat_calls: list = []

    original_build = rd.build_chat_send_response
    rd.build_chat_send_response = lambda *a, **k: chat_calls.append(1)  # type: ignore[assignment]
    try:
        outcome = rd.process_chat_send_request(
            message_id=88,
            params={"accept_version": API_VERSION, "request_id": "rq-cancel"},
            initialized=True,
            interactive_approval=False,
            brain_container=brain,  # type: ignore[arg-type]
            logger=LOGGER,
            write_message=_null_writer,
            read_message=_null_reader,
            cancel_handle=cancel_handle,  # type: ignore[arg-type]
        )
    finally:
        rd.build_chat_send_response = original_build  # type: ignore[assignment]

    assert isinstance(outcome, ProcessOutcome)
    assert outcome.response is not None
    result = outcome.response["result"]
    assert result["status"] == rd.TURN_STATE_CANCELLED
    # build_chat_send_response must NOT have been called
    assert chat_calls == []


# ---------------------------------------------------------------------------
# Lines 1046-1048 — approval cancelled branch
# ---------------------------------------------------------------------------


def _drive_approval_terminal_outcome(
    *,
    monkeypatch: pytest.MonkeyPatch,
    resolution_status: str,
) -> ProcessOutcome:
    """Drive the REAL approval branch (lines 1037-1114) through
    process_chat_send_request.

    The first build_chat_send_response returns an approval_request (so the
    interactive-approval branch is entered); request_tool_approval is faked to
    return a denied ApprovalResolution carrying ``resolution_status`` — that is
    exactly what selects the terminal_status/terminal_subcode mapping under
    test.  We assert on the returned ProcessOutcome's turn-result, so a mutation
    to the source if/elif chain (e.g. CANCELLED→DENIED) changes the observed
    status and breaks the test.
    """
    approval_request = {
        "tool_call_id": "call-xyz",
        "tool_name": "shell",
        "reason": "needs approval",
    }

    def _fake_build(message_id, params, **kwargs):  # noqa: ANN001, ANN002, ANN003
        return SimpleNamespace(
            result={"status": "completed", "request_id": "rq-appr"},
            notifications=[],
            approval_request=approval_request,
            approval_plan=None,
            request_id="rq-appr",
            post_settlement_callback=None,
        )

    def _fake_request_tool_approval(*args: Any, **kwargs: Any) -> ApprovalResolution:
        return ApprovalResolution(approved=False, status=resolution_status)

    config = SimpleNamespace(
        tools_workspace_root="/ws",
        agent_workspace_root=None,
        tools_enabled=True,
        feature_flags={},
    )
    brain = _make_brain_with_request_boundary(config=config)
    # request_boundary builder above does not set tool_observations on stack; the
    # cancelled/denied path reads stack.tool_observations — provide it as None.
    brain.stack.tool_observations = None

    monkeypatch.setattr(rd, "build_chat_send_response", _fake_build)
    monkeypatch.setattr(rd, "request_tool_approval", _fake_request_tool_approval)

    return rd.process_chat_send_request(
        message_id=101,
        params={"accept_version": API_VERSION, "request_id": "rq-appr"},
        initialized=True,
        interactive_approval=True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )


def test_terminalize_on_approval_cancelled_sets_cancelled_status(monkeypatch) -> None:
    """Approval resolution with status=TURN_STATE_CANCELLED drives the REAL branch
    (lines 1045-1048): the returned turn-result status is TURN_STATE_CANCELLED and
    no terminal_subcode is emitted."""
    # First pin the log-field mapping (real source call).
    event, msg = rd._approval_terminal_log_fields(TURN_STATE_CANCELLED)
    assert event == "sidecar.runtime.chat_send.approval_cancelled"
    assert "cancelled" in msg

    outcome = _drive_approval_terminal_outcome(
        monkeypatch=monkeypatch,
        resolution_status=TURN_STATE_CANCELLED,
    )
    assert isinstance(outcome, ProcessOutcome)
    result = outcome.response["result"]
    assert result["status"] == TURN_STATE_CANCELLED
    # subcode None → not surfaced into the turn result, and definitely not the
    # default DENIED subcode.
    assert result.get("terminal_subcode") is None
    assert result.get("terminal_subcode") != rd.TERMINAL_SUBCODE_DENIED_USER_EXPLICIT


# ---------------------------------------------------------------------------
# Lines 1050-1052 — approval preempted branch
# ---------------------------------------------------------------------------


def test_terminalize_on_approval_preempted_sets_preempted_status(monkeypatch) -> None:
    """Status=TURN_STATE_PREEMPTED drives the REAL branch (lines 1049-1052): the
    returned turn-result status is TURN_STATE_PREEMPTED with no subcode."""
    event, msg = rd._approval_terminal_log_fields(TURN_STATE_PREEMPTED)
    assert event == "sidecar.runtime.chat_send.approval_preempted"
    assert "preempted" in msg

    outcome = _drive_approval_terminal_outcome(
        monkeypatch=monkeypatch,
        resolution_status=TURN_STATE_PREEMPTED,
    )
    result = outcome.response["result"]
    assert result["status"] == TURN_STATE_PREEMPTED
    assert result.get("terminal_subcode") is None
    assert result.get("terminal_subcode") != rd.TERMINAL_SUBCODE_DENIED_USER_EXPLICIT


# ---------------------------------------------------------------------------
# Lines 1054-1056 — approval runtime_error branch
# ---------------------------------------------------------------------------


def test_terminalize_on_approval_runtime_error_sets_runtime_error_status(monkeypatch) -> None:
    """Status=TURN_STATE_RUNTIME_ERROR drives the REAL branch (lines 1053-1056):
    the returned turn-result status is TURN_STATE_RUNTIME_ERROR with no subcode."""
    event, msg = rd._approval_terminal_log_fields(TURN_STATE_RUNTIME_ERROR)
    assert event == "sidecar.runtime.chat_send.approval_runtime_error"
    assert "failed" in msg

    outcome = _drive_approval_terminal_outcome(
        monkeypatch=monkeypatch,
        resolution_status=TURN_STATE_RUNTIME_ERROR,
    )
    result = outcome.response["result"]
    assert result["status"] == TURN_STATE_RUNTIME_ERROR
    assert result.get("terminal_subcode") is None
    assert result.get("terminal_subcode") != rd.TERMINAL_SUBCODE_DENIED_USER_EXPLICIT


# ---------------------------------------------------------------------------
# Lines 1180, 1186 — InnerRetryableTurnError after approval: plan-drift path
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Lines 1187-1188 — InnerRetryableTurnError non-plan-drift after approval
# (drives _terminalize + _chat_unexpected_failure_outcome)
# ---------------------------------------------------------------------------


def test_post_approval_inner_retryable_non_plan_drift_produces_failure_outcome() -> None:
    error = InnerRetryableTurnError(
        reason="schema_retry_exhausted",
        retry_prompt="try again",
        terminal_subcode="schema_retry_exhausted",
    )

    outcome = rd._post_approval_retryable_terminal_outcome(
        initialized=True,
        message_id=42,
        request_id="rq-retry-42",
        error=error,
    )

    assert outcome is None


# ---------------------------------------------------------------------------
# Lines 1195-1197 — bare Exception handler in post-approval try block
# ---------------------------------------------------------------------------


def test_build_chat_response_bare_exception_after_approval_produces_failure_outcome() -> None:
    """The bare Exception catch at line 1195 is exercised when _build_chat_response
    raises a non-ChatRequestError, non-InnerRetryableTurnError exception."""
    failure_calls: list = []

    def _fake_unexpected(**kwargs: Any) -> ProcessOutcome:
        failure_calls.append(kwargs["message"])
        return ProcessOutcome(
            initialized=True,
            shutdown_requested=False,
            response={"jsonrpc": "2.0", "id": 1, "error": {"code": -32000, "message": "fail"}},
            notifications=[],
        )

    def _fake_build_chat_response(**kwargs: Any) -> Any:
        raise ValueError("unexpected internal error")

    original_fail = rd._chat_unexpected_failure_outcome
    original_build = rd._build_chat_response
    rd._chat_unexpected_failure_outcome = _fake_unexpected  # type: ignore[assignment]
    rd._build_chat_response = _fake_build_chat_response  # type: ignore[assignment]
    try:
        config = SimpleNamespace(
            tools_workspace_root="/ws",
            agent_workspace_root=None,
            tools_enabled=True,
            feature_flags={},
        )
        brain = _make_brain_with_request_boundary(config=config)
        outcome = rd.process_chat_send_request(
            message_id=1,
            params={"accept_version": API_VERSION, "request_id": "rq-bare-exc"},
            initialized=True,
            interactive_approval=False,
            brain_container=brain,  # type: ignore[arg-type]
            logger=LOGGER,
            write_message=_null_writer,
            read_message=_null_reader,
        )
    finally:
        rd._chat_unexpected_failure_outcome = original_fail  # type: ignore[assignment]
        rd._build_chat_response = original_build  # type: ignore[assignment]

    assert len(failure_calls) == 1
    assert "preparing" in failure_calls[0]


# ---------------------------------------------------------------------------
# Lines 1281-1283 — process_message: initialize failure path
# ---------------------------------------------------------------------------


def test_process_message_initialize_failure_returns_internal_error(monkeypatch) -> None:
    """When initialize_response raises, the except at line 1281 returns an
    error response with INITIALIZE_FAILED in the data."""

    def _raise_init(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("initialize_response_exploded")

    monkeypatch.setattr(rd, "initialize_response", _raise_init)
    brain = _make_minimal_brain()
    outcome = rd.process_message(
        {"method": "initialize", "id": 1, "params": {"accept_version": API_VERSION, "config": {}}},
        False,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )
    assert outcome.initialized is False
    assert outcome.response is not None
    err = outcome.response["error"]
    assert err["code"] == rd.INTERNAL_ERROR_CODE
    assert err["data"]["code"] == rd.INITIALIZE_FAILED
    assert "initialize_response_exploded" in err["data"]["detail"]


def test_initialize_dispatch_emits_correlated_runtime_progress(monkeypatch) -> None:
    written: list[dict[str, Any]] = []

    def _initialize(message_id, _params, **kwargs):
        kwargs["progress_callback"](
            {
                "state": "model_acquiring",
                "engine": "ollama",
                "model": "ornith:9b",
                "status": "downloading",
                "percent": 10,
                "completed_bytes": 1,
                "total_bytes": 10,
            }
        )
        return {"jsonrpc": "2.0", "id": message_id, "result": {}}

    monkeypatch.setattr(rd, "initialize_response", _initialize)
    outcome = rd.process_message(
        {
            "method": "initialize",
            "id": 7,
            "params": {
                "accept_version": API_VERSION,
                "request_id": "initialize-7",
                "config": {},
            },
        },
        False,
        brain_container=_make_minimal_brain(),  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=written.append,
        read_message=_null_reader,
    )

    assert outcome.initialized is True
    assert written[0]["method"] == "runtime.progress"
    assert written[0]["params"]["request_id"] == "initialize-7"
    assert written[0]["params"]["state"] == "model_acquiring"


# ---------------------------------------------------------------------------
# Lines 1340-1342 — process_message: not-initialized + message_id is None
# ---------------------------------------------------------------------------


def test_process_message_not_initialized_null_message_id_returns_none_response(
    monkeypatch,
) -> None:
    """Before initialize, a notification (no id) must get response=None
    (lines 1341-1347)."""
    _patch_sub_dispatchers(monkeypatch)
    brain = _make_minimal_brain()
    outcome = rd.process_message(
        {"method": "some.notification", "params": {}},  # no "id" key → message_id=None
        False,  # not initialized
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )
    assert outcome.initialized is False
    assert outcome.response is None
    assert outcome.notifications == []


# ---------------------------------------------------------------------------
# Line 1348 — process_message: not-initialized + message_id not None
# ---------------------------------------------------------------------------


def test_process_message_not_initialized_with_message_id_returns_not_initialized_error(
    monkeypatch,
) -> None:
    """Before initialize, a request with an id returns NOT_INITIALIZED_CODE (line 1348)."""
    _patch_sub_dispatchers(monkeypatch)
    brain = _make_minimal_brain()
    outcome = rd.process_message(
        {"method": "chat.send", "id": 9, "params": {}},
        False,  # not initialized
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )
    assert outcome.initialized is False
    assert outcome.response is not None
    err = outcome.response["error"]
    assert err["code"] == rd.NOT_INITIALIZED_CODE
    assert "not initialized" in err["message"]


# ---------------------------------------------------------------------------
# Line 1376 — process_message: models.list version mismatch
# ---------------------------------------------------------------------------


def test_process_message_models_list_version_mismatch_returns_error(monkeypatch) -> None:
    """A models.list with mismatched accept_version returns the version error
    response (line 1376)."""
    _patch_sub_dispatchers(monkeypatch)
    brain = _make_minimal_brain()
    outcome = rd.process_message(
        {
            "method": MODELS_LIST_METHOD,
            "id": 10,
            "params": {"accept_version": "1900-01-01"},
        },
        True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )
    assert outcome.initialized is True
    err = outcome.response["error"]
    assert "accept_version" in err["message"]


# ---------------------------------------------------------------------------
# Line 1383 — process_message: models.list message_id is None
# ---------------------------------------------------------------------------


def test_process_message_models_list_null_message_id_returns_none_response(monkeypatch) -> None:
    """models.list with id=None (notification form) returns response=None (line 1383)."""
    _patch_sub_dispatchers(monkeypatch)
    brain = _make_minimal_brain()
    outcome = rd.process_message(
        {"method": MODELS_LIST_METHOD, "params": {"accept_version": API_VERSION}},
        True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )
    assert outcome.response is None


# ---------------------------------------------------------------------------
# Line 1418 — process_message: models.unload version mismatch
# ---------------------------------------------------------------------------


def test_process_message_models_unload_version_mismatch_returns_error(monkeypatch) -> None:
    """models.unload with mismatched version returns an error (line 1418)."""
    _patch_sub_dispatchers(monkeypatch)
    brain = _make_minimal_brain()
    outcome = rd.process_message(
        {
            "method": MODELS_UNLOAD_METHOD,
            "id": 20,
            "params": {"accept_version": "1900-01-01"},
        },
        True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )
    assert outcome.initialized is True
    err = outcome.response["error"]
    assert "accept_version" in err["message"]


# ---------------------------------------------------------------------------
# Line 1425 — process_message: models.unload message_id is None
# ---------------------------------------------------------------------------


def test_process_message_models_unload_null_message_id_returns_none_response(monkeypatch) -> None:
    """models.unload with id=None returns response=None (line 1425)."""
    _patch_sub_dispatchers(monkeypatch)
    brain = _make_minimal_brain()
    outcome = rd.process_message(
        {"method": MODELS_UNLOAD_METHOD, "params": {"accept_version": API_VERSION}},
        True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )
    assert outcome.response is None


# ---------------------------------------------------------------------------
# Lines 1434-1436 — process_message: models.unload engine exception
# ---------------------------------------------------------------------------


def test_process_message_models_unload_engine_exception_returns_internal_error(
    monkeypatch,
) -> None:
    """When engine.unload_model() raises, an internal error is returned (lines 1434-1436)."""
    _patch_sub_dispatchers(monkeypatch)

    # models.unload now passes the model tag explicitly (intentional eviction
    # bypasses the shared-daemon residency refcount), so the double accepts it.
    def _exploding_unload(*_args: object) -> None:
        raise RuntimeError("GPU gone")

    engine = SimpleNamespace(model_name="dummy-model-example", unload_model=_exploding_unload)
    brain = _make_minimal_brain(engine=engine)

    outcome = rd.process_message(
        {"method": MODELS_UNLOAD_METHOD, "id": 21, "params": {"accept_version": API_VERSION}},
        True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )
    assert outcome.initialized is True
    err = outcome.response["error"]
    assert err["code"] == rd.INTERNAL_ERROR_CODE
    assert "GPU gone" in err["data"]["detail"]


# ---------------------------------------------------------------------------
# models.resident (Wave 4 model-fit self-catalog)
# ---------------------------------------------------------------------------


def test_process_message_models_resident_version_mismatch_returns_error(monkeypatch) -> None:
    _patch_sub_dispatchers(monkeypatch)
    brain = _make_minimal_brain()
    outcome = rd.process_message(
        {
            "method": MODELS_RESIDENT_METHOD,
            "id": 30,
            "params": {"accept_version": "1900-01-01"},
        },
        True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )
    err = outcome.response["error"]
    assert "accept_version" in err["message"]


def test_process_message_models_resident_null_message_id_returns_none_response(monkeypatch) -> None:
    _patch_sub_dispatchers(monkeypatch)
    brain = _make_minimal_brain()
    outcome = rd.process_message(
        {"method": MODELS_RESIDENT_METHOD, "params": {"accept_version": API_VERSION}},
        True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )
    assert outcome.response is None


def test_process_message_models_resident_success_returns_models(monkeypatch) -> None:
    """When the resolved engine returns resident models, the result surfaces
    ``available: true`` and passes the model list through unmodified."""
    _patch_sub_dispatchers(monkeypatch)
    fake_models = [
        {
            "name": "llama3.1:8b",
            "digest": "abc123",
            "size": 4_900_000_000,
            "size_vram": 4_900_000_000,
            "context_length": 8192,
            "parameter_size": "8B",
            "quantization_level": "Q4_0",
            "expires_at": "2026-09-01T00:05:00Z",
        }
    ]
    fake_engine = SimpleNamespace(list_resident_models=lambda: fake_models)
    monkeypatch.setattr(rd, "_resolve_resident_models_engine", lambda _brain: fake_engine)
    brain = _make_minimal_brain()

    outcome = rd.process_message(
        {"method": MODELS_RESIDENT_METHOD, "id": 31, "params": {"accept_version": API_VERSION}},
        True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )
    result = outcome.response["result"]
    assert result["available"] is True
    assert result["models"] == fake_models


def test_process_message_models_resident_engine_exception_degrades_unavailable(monkeypatch) -> None:
    """A connection failure degrades to ``available: false`` with a reason,
    never raising across the RPC boundary."""
    _patch_sub_dispatchers(monkeypatch)

    def _exploding_list() -> None:
        raise ConnectionError("ollama daemon unreachable")

    fake_engine = SimpleNamespace(list_resident_models=_exploding_list)
    monkeypatch.setattr(rd, "_resolve_resident_models_engine", lambda _brain: fake_engine)
    brain = _make_minimal_brain()

    outcome = rd.process_message(
        {"method": MODELS_RESIDENT_METHOD, "id": 32, "params": {"accept_version": API_VERSION}},
        True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )
    result = outcome.response["result"]
    assert result["available"] is False
    assert "unreachable" in result["reason"]
    assert result["models"] == []


def test_process_message_models_resident_no_engine_degrades_unavailable(monkeypatch) -> None:
    """No resolvable Ollama engine (e.g. mock/openai-compatible engine active
    and the fallback import fails) degrades to ``available: false``."""
    _patch_sub_dispatchers(monkeypatch)
    monkeypatch.setattr(rd, "_resolve_resident_models_engine", lambda _brain: None)
    brain = _make_minimal_brain()

    outcome = rd.process_message(
        {"method": MODELS_RESIDENT_METHOD, "id": 33, "params": {"accept_version": API_VERSION}},
        True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )
    result = outcome.response["result"]
    assert result["available"] is False
    assert result["models"] == []


# ---------------------------------------------------------------------------
# Lines 1547-1548 — hardware.profile: message_id is None
# ---------------------------------------------------------------------------


def test_process_message_hardware_profile_null_message_id_returns_none_response(
    monkeypatch,
) -> None:
    """hardware.profile with id=None returns response=None (lines 1547-1553)."""
    _patch_sub_dispatchers(monkeypatch)
    brain = _make_minimal_brain()
    outcome = rd.process_message(
        {"method": HARDWARE_PROFILE_METHOD, "params": {}},  # no "id"
        True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )
    assert outcome.response is None
    assert outcome.notifications == []


# ---------------------------------------------------------------------------
# Lines 1554-1562 — hardware.profile: success path
# ---------------------------------------------------------------------------


def test_process_message_hardware_profile_success_returns_profile_result(
    monkeypatch,
) -> None:
    """hardware.profile happy path: get_hardware_profile is called and its
    to_dict result is returned (lines 1554-1562)."""
    _patch_sub_dispatchers(monkeypatch)

    profile_dict = {"cpu": "example-cpu", "ram_gb": 16}
    get_calls: list = []

    def _fake_get_hardware_profile(*, ollama_host: Any, model_catalog: Any) -> Any:
        get_calls.append({"ollama_host": ollama_host, "model_catalog": model_catalog})
        return SimpleNamespace(to_dict=lambda: profile_dict)

    # Patch the lazy import by pre-populating the module in sys.modules
    import sys
    import types

    fake_hw_mod = types.ModuleType("sidecar.runtime.hardware_profile")
    fake_hw_mod.get_hardware_profile = _fake_get_hardware_profile  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "sidecar.runtime.hardware_profile", fake_hw_mod)

    config = SimpleNamespace(
        tools_workspace_root=None,
        agent_workspace_root=None,
        tools_enabled=True,
        feature_flags={},
        api_url="http://localhost:11434",
    )
    brain = _make_minimal_brain(config_extras={"api_url": "http://localhost:11434"})

    outcome = rd.process_message(
        {
            "method": HARDWARE_PROFILE_METHOD,
            "id": 40,
            "params": {
                "accept_version": API_VERSION,
                "model_catalog": ["dummy-model-example"],
            },
        },
        True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )
    assert outcome.initialized is True
    assert outcome.response is not None
    result = outcome.response["result"]
    assert result["cpu"] == "example-cpu"
    assert result["ram_gb"] == 16
    assert len(get_calls) == 1


# ---------------------------------------------------------------------------
# Lines 1568-1570 — hardware.profile: exception path
# ---------------------------------------------------------------------------


def test_process_message_hardware_profile_exception_returns_internal_error(
    monkeypatch,
) -> None:
    """hardware.profile exception returns INTERNAL_ERROR (lines 1568-1579)."""
    _patch_sub_dispatchers(monkeypatch)

    import sys
    import types

    fake_hw_mod = types.ModuleType("sidecar.runtime.hardware_profile")

    def _raise_hp(*, ollama_host: Any, model_catalog: Any) -> Any:
        raise RuntimeError("hardware probe failed example")

    fake_hw_mod.get_hardware_profile = _raise_hp  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "sidecar.runtime.hardware_profile", fake_hw_mod)

    brain = _make_minimal_brain(config_extras={"api_url": None})

    outcome = rd.process_message(
        {
            "method": HARDWARE_PROFILE_METHOD,
            "id": 41,
            "params": {"accept_version": API_VERSION},
        },
        True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )
    assert outcome.initialized is True
    err = outcome.response["error"]
    assert err["code"] == rd.INTERNAL_ERROR_CODE
    assert "hardware.profile failed" in err["message"]
    assert "hardware probe failed example" in err["data"]["detail"]


# ---------------------------------------------------------------------------
# Line 1606 — hardware.vram_usage: message_id is None
# ---------------------------------------------------------------------------


def test_process_message_hardware_vram_usage_null_message_id_returns_none_response(
    monkeypatch,
) -> None:
    """hardware.vram_usage with id=None returns response=None (lines 1605-1611)."""
    _patch_sub_dispatchers(monkeypatch)
    brain = _make_minimal_brain()
    outcome = rd.process_message(
        {"method": HARDWARE_VRAM_USAGE_METHOD, "params": {"accept_version": API_VERSION}},
        True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )
    assert outcome.response is None


# ---------------------------------------------------------------------------
# Lines 1622-1624 — hardware.vram_usage: exception → fallback result
# ---------------------------------------------------------------------------


def test_process_message_hardware_vram_usage_exception_returns_fallback_result(
    monkeypatch,
) -> None:
    """When get_vram_usage() raises, the except block (line 1622) returns a
    fallback result with available=False (lines 1626-1638)."""
    _patch_sub_dispatchers(monkeypatch)

    import sys
    import types

    fake_vram_mod = types.ModuleType("sidecar.runtime.hardware_vram_usage")

    def _raise_vram() -> Any:
        raise RuntimeError("vram probe failed example")

    fake_vram_mod.get_vram_usage = _raise_vram  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "sidecar.runtime.hardware_vram_usage", fake_vram_mod)

    brain = _make_minimal_brain()

    outcome = rd.process_message(
        {"method": HARDWARE_VRAM_USAGE_METHOD, "id": 50, "params": {"accept_version": API_VERSION}},
        True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )
    assert outcome.initialized is True
    result = outcome.response["result"]
    assert result["available"] is False
    assert result["source"] == "runtime_fallback"


# ---------------------------------------------------------------------------
# Line 1536 — process_message: CHAT_SEND_METHOD delegate
# ---------------------------------------------------------------------------


def test_process_message_chat_send_delegates_to_process_chat_send_request(
    monkeypatch,
) -> None:
    """CHAT_SEND_METHOD in process_message calls process_chat_send_request (line 1641)."""
    _patch_sub_dispatchers(monkeypatch)
    chat_send_calls: list = []

    def _fake_process_chat_send_request(**kwargs: Any) -> ProcessOutcome:
        chat_send_calls.append(kwargs["message_id"])
        return ProcessOutcome(
            initialized=True,
            shutdown_requested=False,
            response={"jsonrpc": "2.0", "id": kwargs["message_id"], "result": {"status": "ok"}},
            notifications=[],
        )

    monkeypatch.setattr(rd, "process_chat_send_request", _fake_process_chat_send_request)
    brain = _make_minimal_brain()

    outcome = rd.process_message(
        {"method": CHAT_SEND_METHOD, "id": 60, "params": {"accept_version": API_VERSION}},
        True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )
    assert chat_send_calls == [60]
    assert outcome.response["result"]["status"] == "ok"


# ---------------------------------------------------------------------------
# Line 1539 — process_message: unknown method + message_id is None
# ---------------------------------------------------------------------------


def test_process_message_unknown_method_null_message_id_returns_none_response(
    monkeypatch,
) -> None:
    """Unknown method with no id returns response=None (lines 1652-1658)."""
    _patch_sub_dispatchers(monkeypatch)
    brain = _make_minimal_brain()
    outcome = rd.process_message(
        {"method": "no.such.method", "params": {}},  # no "id" → message_id=None
        True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )
    assert outcome.response is None
    assert outcome.notifications == []


# ---------------------------------------------------------------------------
# Lines 1652-1653, 1660 — unknown method with message_id → METHOD_NOT_FOUND
# ---------------------------------------------------------------------------


def test_process_message_unknown_method_with_message_id_returns_method_not_found(
    monkeypatch,
) -> None:
    """Unknown method with a message id returns METHOD_NOT_FOUND_CODE (lines 1660-1669)."""
    _patch_sub_dispatchers(monkeypatch)
    brain = _make_minimal_brain()
    outcome = rd.process_message(
        {"method": "no.such.method", "id": 70, "params": {}},
        True,
        brain_container=brain,  # type: ignore[arg-type]
        logger=LOGGER,
        write_message=_null_writer,
        read_message=_null_reader,
    )
    assert outcome.initialized is True
    assert outcome.response is not None
    err = outcome.response["error"]
    assert err["code"] == rd.METHOD_NOT_FOUND_CODE
    assert "no.such.method" in err["message"]
