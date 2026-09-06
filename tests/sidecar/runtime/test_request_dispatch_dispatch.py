"""Unit coverage for the *pure* helper functions in ``request_dispatch``.

Phase 1 coverage remediation. These tests target the deterministic, dark
helper functions of ``sidecar.runtime.request_dispatch`` -- the ones whose
behavior is a pure input -> output mapping or a recordable side effect -- so
they can be exercised without booting the full async JSON-RPC router.

Test-only: nothing here imports Electron/renderer code, and the source module
is not modified.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest

import sidecar.runtime.request_dispatch as rd
from sidecar.ai.error_codes import CMP_CHAT_INVALID_PARAMS, CMP_CHAT_STREAM_FAILED
from sidecar.ai.routing.loop_events import (
    ApprovalRequestedEvent,
    ApprovalResolvedEvent,
    IterationStartEvent,
    PhaseCompletedEvent,
    PhaseStartedEvent,
    ToolCallDeltaEvent,
)
from sidecar.runtime import telemetry
from sidecar.runtime.approval import ApprovalResolution
from sidecar.runtime.chat_models import ChatRequestError
from sidecar.runtime.telemetry import TelemetryStatus
from sidecar.runtime.turn_retry import InnerRetryableTurnError


class _RecordingWriter:
    """A recording fake notifier: collects every emitted JSON-RPC message."""

    def __init__(self) -> None:
        self.messages: list[dict[str, object]] = []

    def __call__(self, message: dict[str, object]) -> None:
        self.messages.append(message)

    @property
    def methods(self) -> list[str]:
        return [str(m.get("method")) for m in self.messages]


# ---------------------------------------------------------------------------
# FIX 1: telemetry isolation — reset module globals before and after each test
# so that _apply_telemetry_config tests are order-independent.
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_telemetry_globals(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(telemetry, "_sentry_initialized", False)
    monkeypatch.setattr(telemetry, "_last_status", TelemetryStatus())
    yield
    monkeypatch.setattr(telemetry, "_sentry_initialized", False)
    monkeypatch.setattr(telemetry, "_last_status", TelemetryStatus())


# ---------------------------------------------------------------------------
# _workspace_root_configured
# ---------------------------------------------------------------------------


def test_workspace_root_configured_unset_returns_false() -> None:
    assert rd._workspace_root_configured(SimpleNamespace()) is False
    assert rd._workspace_root_configured(SimpleNamespace(tools_workspace_root="")) is False
    assert (
        rd._workspace_root_configured(
            SimpleNamespace(tools_workspace_root="   ", agent_workspace_root=None)
        )
        is False
    )


def test_workspace_root_configured_prefers_tools_then_agent_root() -> None:
    assert (
        rd._workspace_root_configured(SimpleNamespace(tools_workspace_root="C:/ws")) is True
    )
    # falls back to agent_workspace_root when tools root is blank
    assert (
        rd._workspace_root_configured(
            SimpleNamespace(tools_workspace_root="", agent_workspace_root="C:/agent")
        )
        is True
    )


# ---------------------------------------------------------------------------
# _request_tool_preference_set
# ---------------------------------------------------------------------------


def test_request_tool_preference_set_non_dict_returns_empty() -> None:
    assert rd._request_tool_preference_set(None, "enabled_tools") == frozenset()
    assert rd._request_tool_preference_set("nope", "enabled_tools") == frozenset()  # type: ignore[arg-type]


def test_request_tool_preference_set_non_collection_value_returns_empty() -> None:
    assert rd._request_tool_preference_set({"enabled_tools": "x"}, "enabled_tools") == frozenset()
    assert rd._request_tool_preference_set({"enabled_tools": 5}, "enabled_tools") == frozenset()
    assert rd._request_tool_preference_set({}, "missing") == frozenset()


def test_request_tool_preference_set_strips_and_drops_blanks() -> None:
    result = rd._request_tool_preference_set(
        {"enabled_tools": [" git ", "", "  ", "filesystem"]},
        "enabled_tools",
    )
    assert result == frozenset({"git", "filesystem"})


def test_request_tool_preference_set_accepts_tuple_and_set() -> None:
    assert rd._request_tool_preference_set({"k": ("a", "b")}, "k") == frozenset({"a", "b"})
    assert rd._request_tool_preference_set({"k": {"a", "b"}}, "k") == frozenset({"a", "b"})


# ---------------------------------------------------------------------------
# _workspace_required_tool_names  (a non-empty set == a workspace root is required)
# ---------------------------------------------------------------------------


def test_workspace_root_required_chat_mode_true_for_default_catalog() -> None:
    # The managed sidecar catalog includes workspace-requiring tools, so a
    # default chat-mode request reports a workspace root requirement.
    assert rd._workspace_required_tool_names(
        config=SimpleNamespace(),
        mode="chat",
    )


def test_workspace_root_required_respects_disabled_tools_preference() -> None:
    # Derive the disable set from the canonical live catalog so adding a tool
    # cannot silently leave this contract test stale.
    baseline = rd._workspace_required_tool_names(
        config=SimpleNamespace(),
        mode="chat",
    )
    assert baseline
    assert "workspace_present" in baseline

    # Disabling every workspace-requiring tool → no remaining tool requires a
    # workspace root → must return an empty set.
    result = rd._workspace_required_tool_names(
        config=SimpleNamespace(),
        mode="chat",
        tool_preferences={"disabled_tools": sorted(baseline)},
    )
    assert not result


def test_workspace_root_required_with_enabled_allowlist_is_bool() -> None:
    # An enabled_tools allowlist that contains ONLY non-workspace tools must
    # return False (no workspace-requiring tool survives the filter).
    result_no_ws = rd._workspace_required_tool_names(
        config=SimpleNamespace(),
        mode="chat",
        tool_preferences={"enabled_tools": ["web_search", "fetch_url"]},
    )
    assert not result_no_ws

    # An enabled_tools allowlist that includes at least one workspace-requiring
    # tool must yield a non-empty set.
    result_with_ws = rd._workspace_required_tool_names(
        config=SimpleNamespace(),
        mode="chat",
        tool_preferences={"enabled_tools": ["read_file", "web_search"]},
    )
    assert result_with_ws


# ---------------------------------------------------------------------------
# _emit_phase_notification
# ---------------------------------------------------------------------------


def test_emit_phase_notification_disabled_emits_nothing() -> None:
    writer = _RecordingWriter()
    event = PhaseStartedEvent(phase_id="p1", phase_kind="reasoning", iteration=1)
    rd._emit_phase_notification(
        enabled=False,
        writer=writer,
        event=event,
        request_id="req1",
        trace_id="tr1",
        session_id="sess1",
    )
    assert writer.messages == []


def test_emit_phase_notification_legacy_only_emits_single_notification() -> None:
    writer = _RecordingWriter()
    event = PhaseStartedEvent(phase_id="p1", phase_kind="reasoning", iteration=2)
    rd._emit_phase_notification(
        enabled=True,
        writer=writer,
        event=event,
        request_id="req1",
        trace_id="tr1",
        session_id="sess1",
    )
    assert writer.methods == ["chat.phase_started"]
    params = writer.messages[0]["params"]
    assert params["request_id"] == "req1"
    assert params["trace_id"] == "tr1"
    assert params["session_id"] == "sess1"
    assert params["phase_id"] == "p1"
    assert params["iteration"] == 2


def test_emit_phase_notification_canonical_appends_turn_event_and_bumps_seq() -> None:
    writer = _RecordingWriter()
    seq_state = {"seq": 0}
    event = PhaseCompletedEvent(phase_id="p2", phase_kind="reasoning", iteration=1)
    rd._emit_phase_notification(
        enabled=True,
        writer=writer,
        event=event,
        request_id="req2",
        trace_id="tr2",
        session_id="sess2",
        canonical_enabled=True,
        canonical_seq_state=seq_state,
    )
    assert writer.methods == ["chat.phase_completed", "turn.event"]
    assert seq_state["seq"] == 1
    canonical_params = writer.messages[1]["params"]
    assert canonical_params["seq"] == 1
    assert canonical_params["turn_id"] == "req2"


def test_emit_phase_notification_canonical_enabled_without_seq_state_skips_canonical() -> None:
    writer = _RecordingWriter()
    event = PhaseStartedEvent(phase_id="p3", phase_kind="reasoning", iteration=1)
    rd._emit_phase_notification(
        enabled=True,
        writer=writer,
        event=event,
        request_id="req3",
        trace_id=None,
        session_id=None,
        canonical_enabled=True,
        canonical_seq_state=None,
    )
    # legacy fires, canonical is skipped because seq_state is None
    assert writer.methods == ["chat.phase_started"]


def test_emit_phase_notification_no_transport_event_emits_nothing_legacy() -> None:
    writer = _RecordingWriter()
    seq_state = {"seq": 5}
    # ToolCallDeltaEvent has no legacy transport representation -> serializer
    # returns None, so the writer is never invoked for the legacy message,
    # but the canonical serializer DOES represent it and bumps seq.
    event = ToolCallDeltaEvent(
        call_id="c1", tool_name="git", arguments_delta="{", sequence=0
    )
    rd._emit_phase_notification(
        enabled=True,
        writer=writer,
        event=event,
        request_id="req4",
        trace_id=None,
        session_id=None,
        canonical_enabled=True,
        canonical_seq_state=seq_state,
    )
    assert writer.methods == ["turn.event"]
    assert seq_state["seq"] == 6


# ---------------------------------------------------------------------------
# _emit_canonical_notification
# ---------------------------------------------------------------------------


def test_emit_canonical_notification_disabled_emits_nothing() -> None:
    writer = _RecordingWriter()
    event = ApprovalRequestedEvent(call_id="c1", tool_name="git")
    rd._emit_canonical_notification(
        enabled=False,
        writer=writer,
        event=event,
        request_id="req",
        trace_id=None,
        session_id="ss",
        canonical_seq_state={"seq": 0},
    )
    assert writer.messages == []


def test_emit_canonical_notification_none_seq_state_emits_nothing() -> None:
    writer = _RecordingWriter()
    event = ApprovalRequestedEvent(call_id="c1", tool_name="git")
    rd._emit_canonical_notification(
        enabled=True,
        writer=writer,
        event=event,
        request_id="req",
        trace_id=None,
        session_id="ss",
        canonical_seq_state=None,
    )
    assert writer.messages == []


def test_emit_canonical_notification_emits_turn_event_and_bumps_seq() -> None:
    writer = _RecordingWriter()
    seq_state = {"seq": 3}
    event = ApprovalResolvedEvent(
        call_id="c1", approved=True, status="approved", tool_name="git"
    )
    rd._emit_canonical_notification(
        enabled=True,
        writer=writer,
        event=event,
        request_id="reqc",
        trace_id="trc",
        session_id="ssc",
        canonical_seq_state=seq_state,
    )
    assert writer.methods == ["turn.event"]
    assert seq_state["seq"] == 4
    params = writer.messages[0]["params"]
    assert params["type"] == "tool_approval_resolved"
    assert params["seq"] == 4
    assert params["payload"]["approved"] is True


def test_emit_canonical_notification_non_canonical_event_does_not_bump_seq() -> None:
    writer = _RecordingWriter()
    seq_state = {"seq": 7}
    # IterationStartEvent has a canonical representation, but an event with no
    # canonical parts (none exists among loop events that pass through here);
    # use a bare object to force _serialize_turn_event -> None.
    rd._emit_canonical_notification(
        enabled=True,
        writer=writer,
        event=object(),
        request_id="reqc",
        trace_id=None,
        session_id=None,
        canonical_seq_state=seq_state,
    )
    assert writer.messages == []
    # seq is not advanced when the event has no canonical representation
    assert seq_state["seq"] == 7


def test_emit_canonical_notification_iteration_start_is_serialized() -> None:
    writer = _RecordingWriter()
    seq_state = {"seq": 0}
    rd._emit_canonical_notification(
        enabled=True,
        writer=writer,
        event=IterationStartEvent(iteration=1, max_iterations=8),
        request_id="reqi",
        trace_id=None,
        session_id=None,
        canonical_seq_state=seq_state,
    )
    assert writer.methods == ["turn.event"]
    assert seq_state["seq"] == 1


# ---------------------------------------------------------------------------
# _validate_chat_send_semantics
# ---------------------------------------------------------------------------


def test_validate_chat_send_semantics_non_dict_returns_none() -> None:
    assert rd._validate_chat_send_semantics(params=None, message_id=1) is None
    assert rd._validate_chat_send_semantics(params="nope", message_id=1) is None


def test_validate_chat_send_semantics_valid_minimal_params_returns_none() -> None:
    assert (
        rd._validate_chat_send_semantics(
            params={"request_id": "rq", "messages": [{"role": "user", "content": "hi"}]},
            message_id=1,
        )
        is None
    )


def test_validate_chat_send_semantics_blank_explicit_request_id_rejected() -> None:
    error = rd._validate_chat_send_semantics(
        params={"request_id": "   "},
        message_id=1,
    )
    assert isinstance(error, ChatRequestError)
    assert error.code == CMP_CHAT_INVALID_PARAMS
    assert error.rpc_code == rd.INVALID_PARAMS_CODE
    assert error.retryable is False
    assert "request_id" in error.message


def test_validate_chat_send_semantics_empty_messages_list_rejected() -> None:
    error = rd._validate_chat_send_semantics(
        params={"messages": []},
        message_id=2,
    )
    assert isinstance(error, ChatRequestError)
    assert "non-empty list" in error.message


def test_validate_chat_send_semantics_messages_not_a_list_rejected() -> None:
    error = rd._validate_chat_send_semantics(
        params={"messages": "not-a-list"},
        message_id=2,
    )
    assert isinstance(error, ChatRequestError)
    assert error.code == CMP_CHAT_INVALID_PARAMS


def test_validate_chat_send_semantics_invalid_message_role_rejected() -> None:
    error = rd._validate_chat_send_semantics(
        params={"messages": [{"role": "bogus", "content": "x"}]},
        message_id=3,
    )
    assert isinstance(error, ChatRequestError)
    # error text propagated from validate_chat_messages
    assert "role must be one of" in error.message


def test_validate_chat_send_semantics_interactive_response_requires_batch_id() -> None:
    error = rd._validate_chat_send_semantics(
        params={"interactive_response": {"batch_id": "   "}},
        message_id=4,
    )
    assert isinstance(error, ChatRequestError)
    assert "batch_id" in error.message


def test_validate_chat_send_semantics_interactive_response_with_batch_id_ok() -> None:
    assert (
        rd._validate_chat_send_semantics(
            params={"interactive_response": {"batch_id": "batch-1"}},
            message_id=4,
        )
        is None
    )




def test_validate_chat_send_semantics_plan_mode_non_bool_rejected() -> None:
    error = rd._validate_chat_send_semantics(
        params={"plan_mode": "yes"},
        message_id=6,
    )
    assert isinstance(error, ChatRequestError)
    assert "plan_mode" in error.message


def test_validate_chat_send_semantics_reasoning_effort_invalid_rejected() -> None:
    error = rd._validate_chat_send_semantics(
        params={"reasoning_effort": "bananas"},
        message_id=7,
    )
    assert isinstance(error, ChatRequestError)
    assert "reasoning_effort" in error.message
    assert error.rpc_code == rd.INVALID_PARAMS_CODE


def test_validate_chat_send_semantics_session_start_date_invalid_rejected() -> None:
    error = rd._validate_chat_send_semantics(
        params={"session_start_date": "06/13/2026"},
        message_id=7,
    )
    assert isinstance(error, ChatRequestError)
    assert "session_start_date" in error.message


def test_validate_chat_send_semantics_correlation_ids_propagated() -> None:
    error = rd._validate_chat_send_semantics(
        params={
            "request_id": "rq-x",
            "trace_id": "tr-x",
            "session_id": "ss-x",
            "plan_mode": "no",
        },
        message_id=8,
    )
    assert isinstance(error, ChatRequestError)
    assert error.request_id == "rq-x"
    assert error.trace_id == "tr-x"
    assert error.session_id == "ss-x"


# ---------------------------------------------------------------------------
# _apply_telemetry_config
# ---------------------------------------------------------------------------


def test_apply_telemetry_config_non_dict_params_returns_status() -> None:
    status = rd._apply_telemetry_config(None)
    assert isinstance(status, dict)
    assert "status" in status


def test_apply_telemetry_config_missing_config_returns_status() -> None:
    status = rd._apply_telemetry_config({"config": "not-a-dict"})
    assert isinstance(status, dict)
    assert "status" in status


def test_apply_telemetry_config_opt_out_disables_telemetry() -> None:
    status = rd._apply_telemetry_config(
        {
            "config": {"crash_reporting_opt_in": False, "telemetry_dsn": "https://x@y/1"},
            "client_version": "9.9.9",
        }
    )
    assert status["initialized"] is False
    assert status["status"] == "disabled"


def test_apply_telemetry_config_opt_in_without_dsn_is_disabled() -> None:
    # opt_in but DSN missing -> telemetry stays disabled with a failure reason.
    status = rd._apply_telemetry_config(
        {
            "config": {"crash_reporting_opt_in": True},
            "client_version": "1.0.0",
        }
    )
    assert status["initialized"] is False
    assert status["status"] == "disabled"


def test_apply_telemetry_config_reads_dsn_from_secrets_over_config() -> None:
    # secrets.telemetry_dsn takes precedence; opt_out still disables, but the
    # secrets branch is exercised. An invalid DSN with opt_in is rejected.
    status = rd._apply_telemetry_config(
        {
            "config": {"crash_reporting_opt_in": True, "telemetry_dsn": "config-dsn"},
            "secrets": {"telemetry_dsn": "not-a-valid-dsn"},
            "client_version": "2.0.0",
        }
    )
    assert status["initialized"] is False
    # The secrets DSN must take precedence: the invalid DSN is rejected, not
    # silently ignored in favour of 'disabled'.  'disabled' here would mean the
    # precedence check never reached the secrets branch at all.
    assert status["status"] == "invalid_dsn"


# ---------------------------------------------------------------------------
# _chat_unexpected_failure_outcome
# ---------------------------------------------------------------------------


def test_chat_unexpected_failure_outcome_builds_retryable_internal_error(caplog) -> None:
    logger = logging.getLogger("test.request_dispatch.failure")
    with caplog.at_level(logging.ERROR):
        try:
            raise RuntimeError("boom detail here")
        except RuntimeError:
            outcome = rd._chat_unexpected_failure_outcome(
                initialized=True,
                message_id=11,
                params={"request_id": "rq", "trace_id": "tr", "session_id": "ss"},
                message="chat.send stream failed",
                logger=logger,
            )

    assert outcome.initialized is True
    assert outcome.shutdown_requested is False
    assert outcome.response is not None
    error_obj = outcome.response["error"]
    assert error_obj["code"] == rd.INTERNAL_ERROR_CODE
    assert error_obj["data"]["code"] == CMP_CHAT_STREAM_FAILED
    # cause captured from sys.exc_info()
    assert error_obj["data"]["error_type"] == "RuntimeError"
    assert "boom detail here" in error_obj["data"]["error_message"]
    # a notification accompanies the error outcome
    assert len(outcome.notifications) >= 1


def test_chat_unexpected_failure_outcome_without_active_exception_has_no_cause() -> None:
    logger = logging.getLogger("test.request_dispatch.failure2")
    # Called outside any except block: sys.exc_info() has no active exception,
    # so no cause data is attached.
    outcome = rd._chat_unexpected_failure_outcome(
        initialized=False,
        message_id=12,
        params={"request_id": "rq2"},
        message="generic failure",
        logger=logger,
    )
    assert outcome.initialized is False
    error_obj = outcome.response["error"]
    assert error_obj["code"] == rd.INTERNAL_ERROR_CODE
    assert "error_type" not in error_obj["data"]


# ---------------------------------------------------------------------------
# _post_approval_retryable_terminal_outcome
# ---------------------------------------------------------------------------


def test_post_approval_retryable_terminal_outcome_non_plan_drift_returns_none() -> None:
    error = InnerRetryableTurnError(
        reason="r", retry_prompt="p", terminal_subcode="some_other_subcode"
    )
    assert (
        rd._post_approval_retryable_terminal_outcome(
            initialized=True,
            message_id=21,
            request_id="rq",
            error=error,
        )
        is None
    )


def test_post_approval_retryable_terminal_outcome_missing_subcode_returns_none() -> None:
    error = InnerRetryableTurnError(reason="r", retry_prompt="p", terminal_subcode=None)
    assert (
        rd._post_approval_retryable_terminal_outcome(
            initialized=True,
            message_id=21,
            request_id="rq",
            error=error,
        )
        is None
    )


def test_post_approval_retryable_terminal_outcome_plan_drift_builds_preempted_result() -> None:
    error = InnerRetryableTurnError(
        reason="r", retry_prompt="p", terminal_subcode="PRE_plan_drift_X"
    )
    outcome = rd._post_approval_retryable_terminal_outcome(
        initialized=True,
        message_id=22,
        request_id="rq-drift",
        error=error,
    )
    assert outcome is not None
    assert outcome.initialized is True
    assert outcome.shutdown_requested is False
    assert outcome.notifications == []
    result = outcome.response["result"]
    assert result["request_id"] == "rq-drift"
    assert result["status"] == rd.TURN_STATE_PREEMPTED
    assert result["terminal_subcode"] == rd.TERMINAL_SUBCODE_PREEMPTED_PLAN_DRIFT


# ---------------------------------------------------------------------------
# _normalize_approval_resolution
# ---------------------------------------------------------------------------


def test_normalize_approval_resolution_passthrough_resolution_instance() -> None:
    resolution = ApprovalResolution(approved=False, status="denied_by_policy")
    assert rd._normalize_approval_resolution(resolution) is resolution


def test_normalize_approval_resolution_true_bool_maps_to_approved() -> None:
    resolved = rd._normalize_approval_resolution(True)
    assert isinstance(resolved, ApprovalResolution)
    assert resolved.approved is True
    assert resolved.status == "approved"


def test_normalize_approval_resolution_false_bool_maps_to_denied() -> None:
    resolved = rd._normalize_approval_resolution(False)
    assert resolved.approved is False
    assert resolved.status == "denied"


# ---------------------------------------------------------------------------
# _approval_terminal_log_fields
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "expected_event", "expected_message_fragment"),
    [
        (rd.TURN_STATE_TIMEOUT, "sidecar.runtime.chat_send.approval_timeout", "timed out"),
        (rd.TURN_STATE_CANCELLED, "sidecar.runtime.chat_send.approval_cancelled", "cancelled"),
        (rd.TURN_STATE_PREEMPTED, "sidecar.runtime.chat_send.approval_preempted", "preempted"),
        (
            rd.TURN_STATE_RUNTIME_ERROR,
            "sidecar.runtime.chat_send.approval_runtime_error",
            "failed",
        ),
        ("denied", "sidecar.runtime.chat_send.approval_denied", "denied"),
        ("totally-unknown", "sidecar.runtime.chat_send.approval_denied", "denied"),
    ],
)
def test_approval_terminal_log_fields_maps_status_to_event_and_message(
    status: str,
    expected_event: str,
    expected_message_fragment: str,
) -> None:
    event, message = rd._approval_terminal_log_fields(status)
    assert event == expected_event
    assert expected_message_fragment in message


def test_approval_terminal_log_fields_normalizes_case_and_whitespace() -> None:
    event, message = rd._approval_terminal_log_fields("  TIMEOUT  ")
    assert event == "sidecar.runtime.chat_send.approval_timeout"
    assert "timed out" in message


def test_approval_terminal_log_fields_none_falls_back_to_denied() -> None:
    event, message = rd._approval_terminal_log_fields("")
    assert event == "sidecar.runtime.chat_send.approval_denied"
    assert "denied" in message
