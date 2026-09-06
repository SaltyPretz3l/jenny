"""Dark-path coverage for :mod:`sidecar.ai.routing.tool_loop`.

Targets the scattered uncovered branches that test_tool_loop.py and
test_tool_loop_stop_drain.py do not already reach.  One behaviour per
test for tight failure isolation.
"""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.error_codes import (
    CMP_LOOP_INVALID_TOOL_CALL,
    CMP_TOOL_DISABLED,
)
from sidecar.ai.routing.loop_events import TokenDeltaEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.tool_loop import (
    _available_tool_names,
    _bind_missing_approval_call_id,
    _current_info_unavailability_response,
    _empty_post_tool_context_response,
    _failed_tool_context_response,
    _invalid_tool_output,
    _is_unknown_tool_call,
    _looks_like_generic_greeting_only,
    _looks_like_post_tool_empty_chat_menu,
    _post_tool_invalid_response_reason,
    _post_tool_invalid_log_data,
    _quota_blocked_groups,
    _quota_burst_key,
    _should_issue_tool_nudge,
    _successful_tool_context_response,
    _web_search_unavailability_reason,
    _emit_deterministic_response_tokens,
    _mark_buffer_flushed,
    _build_stopped_tool_loop_result,
    _summarize_failed_tool_outcomes,
    _summarize_successful_tool_outcomes,
)
from sidecar.ai.routing.loop_stop import StopDecision, StopReason
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.policy import tool_policy_call_key


# ---------------------------------------------------------------------------
# Minimal outcome stub (duck-typed, no real ToolExecutionOutcome needed)
# ---------------------------------------------------------------------------


def _outcome(
    *,
    tool_name: str = "read_file",
    output: str = "file content",
    success: bool = True,
    error_code: str | None = None,
) -> Any:
    return SimpleNamespace(
        tool_name=tool_name,
        output=output,
        success=success,
        error_code=error_code,
        metadata={},
    )


# ---------------------------------------------------------------------------
# _is_unknown_tool_call  (lines 102-103, 116, 118)
# ---------------------------------------------------------------------------


def _make_kernel(
    *,
    assert_raises: ToolExecutionFailure | None = None,
    is_deferred: bool = False,
    mcp_descriptor: Any = None,
    tools_shell_enabled: bool = True,
) -> Any:
    """Minimal duck-typed kernel stub for _is_unknown_tool_call."""

    def _assert_valid_tool_call(call: Any) -> None:
        if assert_raises is not None:
            raise assert_raises

    class _Config:
        tools_shell_enabled = True

    cfg = _Config()
    cfg.tools_shell_enabled = tools_shell_enabled

    class _MCPClient:
        def tool_descriptor(self, name: str) -> Any:
            return mcp_descriptor

    return SimpleNamespace(
        _assert_valid_tool_call=_assert_valid_tool_call,
        _is_direct_deferred_tool_call=lambda call, ctx: is_deferred,
        _mcp_client=_MCPClient(),
        _config=cfg,
    )


def test_is_unknown_tool_call_returns_message_on_invalid_tool_call_code() -> None:
    """Line 102: CMP_LOOP_INVALID_TOOL_CALL exception is caught and message returned."""
    exc = ToolExecutionFailure(
        code=CMP_LOOP_INVALID_TOOL_CALL,
        message="call is malformed",
        retryable=False,
    )
    kernel = _make_kernel(assert_raises=exc)
    call = ToolCallRequest(tool_id="bad_tool", arguments={}, call_id="c1")

    result = _is_unknown_tool_call(
        kernel,
        call,
        tool_resolution_context=None,
        tool_contract=None,
        request_disabled_tools=frozenset(),
    )

    # Must return the exception message, not None
    assert result == "call is malformed"


def test_is_unknown_tool_call_re_raises_non_invalid_tool_call_exception() -> None:
    """Line 103: Other ToolExecutionFailure codes are re-raised (not swallowed)."""
    exc = ToolExecutionFailure(
        code=CMP_TOOL_DISABLED,
        message="tool is disabled globally",
        retryable=False,
    )
    kernel = _make_kernel(assert_raises=exc)
    call = ToolCallRequest(tool_id="some_tool", arguments={}, call_id="c2")

    with pytest.raises(ToolExecutionFailure) as exc_info:
        _is_unknown_tool_call(
            kernel,
            call,
            tool_resolution_context=None,
            tool_contract=None,
            request_disabled_tools=frozenset(),
        )

    assert exc_info.value.code == CMP_TOOL_DISABLED


def test_is_unknown_tool_call_returns_none_when_mcp_descriptor_found() -> None:
    """Line 116: Returns None when tool has an MCP descriptor."""
    descriptor = SimpleNamespace(name="mcp_tool")
    kernel = _make_kernel(mcp_descriptor=descriptor)
    call = ToolCallRequest(tool_id="mcp_tool", arguments={}, call_id="c3")

    result = _is_unknown_tool_call(
        kernel,
        call,
        tool_resolution_context=None,
        tool_contract=None,
        request_disabled_tools=frozenset(),
    )

    assert result is None


def test_is_unknown_tool_call_returns_none_for_run_command_when_shell_disabled() -> None:
    """Line 118: run_command with shell disabled is exempt from the 'unknown' verdict."""
    kernel = _make_kernel(tools_shell_enabled=False)
    call = ToolCallRequest(tool_id="run_command", arguments={}, call_id="c4")

    result = _is_unknown_tool_call(
        kernel,
        call,
        tool_resolution_context=None,
        tool_contract=None,
        request_disabled_tools=frozenset(),
    )

    # Shell disabled but run_command still resolves to None (not unknown)
    assert result is None


# ---------------------------------------------------------------------------
# _bind_missing_approval_call_id  (lines 250)
# ---------------------------------------------------------------------------


def test_bind_missing_approval_call_id_rebinds_when_policy_key_matches() -> None:
    """Line 247-250: A call without a call_id is rebound to the approval_call_id
    when its policy key matches."""
    call_no_id = ToolCallRequest(
        tool_id="write_file",
        arguments={"path": "/tmp/out.txt", "content": "hello"},
        call_id=None,
    )
    # Build the approval_call_id as the policy key of that call
    approval_call_id = tool_policy_call_key(call_no_id)

    result = _bind_missing_approval_call_id(
        (call_no_id,),
        approval_call_id,
    )

    assert len(result) == 1
    assert result[0].call_id == approval_call_id


def test_bind_missing_approval_call_id_no_op_when_id_already_bound() -> None:
    """Lines 240-241: Returns original tuple unchanged when call_id matches."""
    call = ToolCallRequest(tool_id="read_file", arguments={}, call_id="approval-abc")
    original = (call,)

    result = _bind_missing_approval_call_id(original, "approval-abc")

    # No-op path returns the same tuple object unchanged (the function
    # short-circuits and returns the input before building a new list).
    assert result is original
    assert tuple(result) == (call,)
    assert result[0].call_id == "approval-abc"


# ---------------------------------------------------------------------------
# _post_tool_invalid_response_reason  (lines 395, 397)
# ---------------------------------------------------------------------------


def test_post_tool_invalid_response_reason_returns_empty_chat_menu() -> None:
    """Line 395: 'empty_chat_menu' is returned for an EMPTY_CHAT_MENU-like response."""
    # Must NOT start with a generic greeting (that would short-circuit to "generic_greeting")
    # The _EMPTY_CHAT_MENU_RE requires all three phrases in order.
    chat_menu_text = (
        "Sure! How can I help you today?\n\n"
        "If you're not sure where to start, I can help with things like:\n"
        "* Organizing thoughts\n"
        "* Deep research\n\n"
        "Just let me know what's on your mind!"
    )

    result = _post_tool_invalid_response_reason(
        response_text=chat_menu_text,
        harness_inventory_invalid=False,
    )

    assert result == "empty_chat_menu"


def test_post_tool_invalid_response_reason_returns_harness_inventory() -> None:
    """Line 397: 'harness_inventory' is returned when harness_inventory_invalid=True."""
    result = _post_tool_invalid_response_reason(
        response_text="Here are the results you asked for.",
        harness_inventory_invalid=True,
    )

    assert result == "harness_inventory"


# ---------------------------------------------------------------------------
# _post_tool_invalid_log_data  (line 417-418 optional outcome_count field)
# ---------------------------------------------------------------------------


def test_post_tool_invalid_log_data_includes_outcome_count_when_provided() -> None:
    """Lines 417-418: outcome_count key is included only when explicitly passed."""
    data_with = _post_tool_invalid_log_data(
        iteration=3,
        response_text="hello",
        invalid_reason="generic_greeting",
        successful_outcome_count=2,
        harness_summary_available=True,
        outcome_count=5,
    )
    data_without = _post_tool_invalid_log_data(
        iteration=3,
        response_text="hello",
        invalid_reason="generic_greeting",
        successful_outcome_count=2,
        harness_summary_available=True,
    )

    assert data_with["outcome_count"] == 5
    assert "outcome_count" not in data_without


# ---------------------------------------------------------------------------
# _web_search_unavailability_reason  (line 430)
# ---------------------------------------------------------------------------


def test_web_search_unavailability_reason_returns_none_when_no_web_search_status() -> None:
    """Line 430: Returns None when no web_search entry is in tool_statuses."""
    statuses = [SimpleNamespace(name="read_file", available=False, reason="")]

    result = _web_search_unavailability_reason(statuses)

    assert result is None


def test_web_search_unavailability_reason_returns_none_when_available() -> None:
    """Line 427: Returns None when web_search is available=True."""
    statuses = [SimpleNamespace(name="web_search", available=True, reason="")]

    result = _web_search_unavailability_reason(statuses)

    assert result is None


def test_web_search_unavailability_reason_returns_reason_when_unavailable() -> None:
    """Line 429: Returns the reason string when web_search is unavailable."""
    statuses = [SimpleNamespace(name="web_search", available=False, reason="api key missing")]

    result = _web_search_unavailability_reason(statuses)

    assert result == "api key missing"


def test_web_search_unavailability_reason_fallback_when_reason_empty() -> None:
    """Line 429: Falls back to 'runtime/backend unavailable' when reason is empty."""
    statuses = [SimpleNamespace(name="web_search", available=False, reason="")]

    result = _web_search_unavailability_reason(statuses)

    assert result == "runtime/backend unavailable"


# ---------------------------------------------------------------------------
# _current_info_unavailability_response  (line 483)
# ---------------------------------------------------------------------------


def test_current_info_unavailability_response_returns_none_when_web_search_available() -> None:
    """Line 483 (no-op path): Returns None when web_search is available."""
    statuses = [SimpleNamespace(name="web_search", available=True, reason="")]

    result = _current_info_unavailability_response(
        latest_user_content="what is the current bitcoin price?",
        tool_statuses=statuses,
    )

    assert result is None


# ---------------------------------------------------------------------------
# _summarize_successful_tool_outcomes / _successful_tool_context_response (532)
# ---------------------------------------------------------------------------


def test_successful_tool_context_response_returns_none_when_no_successes() -> None:
    """Line 532: Returns None when there are no successful outcomes."""
    outcomes = [_outcome(success=False, error_code="CMP-ERR-001")]

    result = _successful_tool_context_response(outcomes)

    assert result is None


def test_successful_tool_context_response_returns_summary_when_success_present() -> None:
    """Lines 529-537: Returns a non-empty summary string when there's a success."""
    outcomes = [_outcome(tool_name="read_file", output="file data", success=True)]

    result = _successful_tool_context_response(outcomes)

    assert result is not None
    assert "read_file" in result
    assert "file data" in result


# ---------------------------------------------------------------------------
# _empty_post_tool_context_response  (line 556)
# ---------------------------------------------------------------------------


def test_empty_post_tool_context_response_returns_none_when_no_outcomes() -> None:
    """Line 556: Returns None when outcomes list is empty."""
    result = _empty_post_tool_context_response([])

    assert result is None


def test_empty_post_tool_context_response_includes_failed_summary() -> None:
    """Lines 541-548: Returns a failed-tool summary when there are failed outcomes."""
    failed = _outcome(
        tool_name="write_file",
        output="permission denied",
        success=False,
        error_code="CMP-TOOL-0001",
    )

    result = _empty_post_tool_context_response([failed])

    assert result is not None
    assert "write_file" in result
    assert "permission denied" in result


def test_empty_post_tool_context_response_includes_successful_summary() -> None:
    """Lines 549-555: Returns a successful-tool summary when only successes present."""
    success = _outcome(tool_name="read_file", output="contents here", success=True)

    result = _empty_post_tool_context_response([success])

    assert result is not None
    assert "read_file" in result
    assert "contents here" in result


# ---------------------------------------------------------------------------
# _emit_deterministic_response_tokens  (line 511 - non-streaming no-op branch)
# ---------------------------------------------------------------------------


def test_emit_deterministic_response_tokens_no_op_when_not_streaming() -> None:
    """Line 511: No tokens emitted when runtime.streaming is False."""
    events: list[object] = []
    runtime = LoopRuntime(emit=events.append, request_id="req_det")
    runtime.streaming = False
    streamed: set[str] = set()

    _emit_deterministic_response_tokens(
        runtime=runtime,
        streamed_event_types=streamed,
        response_text="some response",
    )

    token_events = [e for e in events if isinstance(e, TokenDeltaEvent)]
    assert token_events == []
    assert "chat.token" not in streamed


def test_emit_deterministic_response_tokens_no_op_when_already_streamed() -> None:
    """Line 511: No duplicate tokens when 'chat.token' already in streamed_event_types."""
    events: list[object] = []
    runtime = LoopRuntime(emit=events.append, request_id="req_det2")
    runtime.streaming = True
    streamed: set[str] = {"chat.token"}

    _emit_deterministic_response_tokens(
        runtime=runtime,
        streamed_event_types=streamed,
        response_text="some response",
    )

    token_events = [e for e in events if isinstance(e, TokenDeltaEvent)]
    assert token_events == []


# ---------------------------------------------------------------------------
# _quota_burst_key / _quota_blocked_groups  (line 692-693)
# ---------------------------------------------------------------------------


def test_quota_burst_key_uses_quota_scope_metadata() -> None:
    """Lines 692-693: quota_burst_key extracts quota_scope from metadata."""
    blocked = SimpleNamespace(
        call=SimpleNamespace(tool_id="web_search"),
        reason="daily_limit",
        metadata={"quota_scope": "web_scope"},
    )

    key = _quota_burst_key(blocked)

    assert key == ("web_search", "web_scope")


def test_quota_burst_key_falls_back_to_reason_when_no_quota_scope() -> None:
    """Line 692: Falls back to reason when quota_scope absent from metadata."""
    blocked = SimpleNamespace(
        call=SimpleNamespace(tool_id="read_file"),
        reason="my_reason",
        metadata={},
    )

    key = _quota_burst_key(blocked)

    assert key == ("read_file", "my_reason")


def test_quota_blocked_groups_groups_consecutive_same_key() -> None:
    """Lines 775-776: Consecutive calls with the same key are grouped together."""

    def _blocked(tool_id: str, scope: str) -> Any:
        return SimpleNamespace(
            call=SimpleNamespace(tool_id=tool_id),
            reason=scope,
            metadata={"quota_scope": scope},
        )

    blocks = [
        _blocked("web_search", "daily"),
        _blocked("web_search", "daily"),
        _blocked("read_file", "daily"),
    ]

    groups = _quota_blocked_groups(tuple(blocks))  # type: ignore[arg-type]

    assert len(groups) == 2
    assert len(groups[0]) == 2
    assert len(groups[1]) == 1


# ---------------------------------------------------------------------------
# _available_tool_names  (line 878 entry loop)
# ---------------------------------------------------------------------------


def test_available_tool_names_returns_only_available_entries() -> None:
    """Line 878: Only entries with available=True are included in the result."""

    class _Entry:
        def __init__(self, name: str, available: bool) -> None:
            self.descriptor = SimpleNamespace(name=name)
            self.available = available

    class _Contract:
        entries = [_Entry("read_file", True), _Entry("write_file", False)]

    result = _available_tool_names(_Contract())

    assert result == ("read_file",)
    assert "write_file" not in result


def test_available_tool_names_returns_empty_tuple_when_contract_is_none() -> None:
    """Line 148: Returns () when tool_contract is None."""
    result = _available_tool_names(None)

    assert result == ()


# ---------------------------------------------------------------------------
# _invalid_tool_output  (line 953)
# ---------------------------------------------------------------------------


def test_invalid_tool_output_appends_available_tool_names_when_contract_present() -> None:
    """Line 953: Available tool names are appended to the error message."""

    class _Entry:
        def __init__(self, name: str) -> None:
            self.descriptor = SimpleNamespace(name=name)
            self.available = True

    class _Contract:
        entries = [_Entry("read_file"), _Entry("list_dir")]

    result = _invalid_tool_output("model requested unknown tool 'fake_tool'", _Contract())

    assert "fake_tool" in result
    assert "read_file" in result
    assert "list_dir" in result


def test_invalid_tool_output_no_tool_names_when_no_contract() -> None:
    """Line 169-170: Base message only when contract is None."""
    result = _invalid_tool_output("bad call", None)

    assert "bad call" in result
    assert "Available tools" not in result


# ---------------------------------------------------------------------------
# _mark_buffer_flushed  (lines 1004-1006)
# ---------------------------------------------------------------------------


def test_mark_buffer_flushed_calls_store_method_when_store_present() -> None:
    """Lines 1004-1006: mark_buffered_visible_output_flushed is called on the store."""
    calls: list[str] = []

    class _FakeDiagnosticsStore:
        def mark_buffered_visible_output_flushed(self, *, request_id: str) -> None:
            calls.append(request_id)

    class _FakeEngine:
        _turn_diagnostics_store = _FakeDiagnosticsStore()

    kernel = SimpleNamespace(_engine=_FakeEngine())
    runtime = LoopRuntime(emit=lambda _e: None, request_id="req_mark")

    _mark_buffer_flushed(kernel, runtime)

    assert calls == ["req_mark"]


def test_mark_buffer_flushed_no_op_when_no_engine() -> None:
    """Lines 1019-1024: No exception when kernel has no _engine attribute."""
    kernel = SimpleNamespace()
    runtime = LoopRuntime(emit=lambda _e: None, request_id="req_noop")

    _mark_buffer_flushed(kernel, runtime)  # must not raise


# ---------------------------------------------------------------------------
# _looks_like_generic_greeting_only  (line 1134-1136)
# ---------------------------------------------------------------------------


def test_looks_like_generic_greeting_only_matches_self_introduction() -> None:
    """Lines 1134-1136: Hi + "I'm Jenny" matches the greeting pattern."""
    greeting = "Hi there! I'm Jenny, nice to meet you!"

    result = _looks_like_generic_greeting_only(greeting)

    assert result is True


def test_looks_like_generic_greeting_only_does_not_match_real_response() -> None:
    """Lines 1134-1136: A real answer is NOT treated as a generic greeting."""
    real_response = "Here is the Python snippet you requested:\n```python\nprint('hello')\n```"

    result = _looks_like_generic_greeting_only(real_response)

    assert result is False


# ---------------------------------------------------------------------------
# _looks_like_post_tool_empty_chat_menu  (lines 1177-1178)
# ---------------------------------------------------------------------------


def test_looks_like_post_tool_empty_chat_menu_matches_menu_pattern() -> None:
    """Lines 1177-1178: Full menu text matches the regex."""
    menu_text = (
        "Hi! I'm Jenny. How can I help you today?\n\n"
        "If you're not sure where to start, I can help with things like:\n"
        "* Brain Dump\n\n"
        "Just let me know what's on your mind!"
    )

    result = _looks_like_post_tool_empty_chat_menu(menu_text)

    assert result is True


def test_looks_like_post_tool_empty_chat_menu_returns_false_for_empty_string() -> None:
    """Line 1196: Empty string returns False immediately."""
    result = _looks_like_post_tool_empty_chat_menu("")

    assert result is False


# ---------------------------------------------------------------------------
# _should_issue_tool_nudge  (lines 1253-1254)
# ---------------------------------------------------------------------------


def test_should_issue_tool_nudge_returns_false_when_outcomes_present() -> None:
    """Lines 1253-1254: Returns False when there are existing outcomes."""
    kernel = SimpleNamespace(_config=SimpleNamespace(engine_type="ollama"))
    mode_policy = SimpleNamespace(mode="assist")

    result = _should_issue_tool_nudge(
        kernel=kernel,
        mode_policy=mode_policy,
        outcomes=[_outcome()],
        response_looks_like_fake_tool_use=True,
    )

    assert result is False


def test_should_issue_tool_nudge_returns_false_when_engine_not_ollama() -> None:
    """Lines 1253-1254: Returns False when engine_type is not ollama."""
    kernel = SimpleNamespace(_config=SimpleNamespace(engine_type="openai"))
    mode_policy = SimpleNamespace(mode="assist")

    result = _should_issue_tool_nudge(
        kernel=kernel,
        mode_policy=mode_policy,
        outcomes=[],
        response_looks_like_fake_tool_use=True,
    )

    assert result is False


def test_should_issue_tool_nudge_returns_true_when_all_conditions_met() -> None:
    """Lines 1418-1425: Returns True when ollama + assist + no outcomes + fake tool use."""
    kernel = SimpleNamespace(_config=SimpleNamespace(engine_type="ollama"))
    mode_policy = SimpleNamespace(mode="assist")

    result = _should_issue_tool_nudge(
        kernel=kernel,
        mode_policy=mode_policy,
        outcomes=[],
        response_looks_like_fake_tool_use=True,
    )

    assert result is True


# ---------------------------------------------------------------------------
# _build_stopped_tool_loop_result  with pending_tool_calls  (lines 1431)
# ---------------------------------------------------------------------------


def test_build_stopped_tool_loop_result_with_drained_buffer_marks_flushed() -> None:
    """Lines 691-693: When buffer is drained, chat.token is added and mark called."""
    calls: list[str] = []

    class _FakeDiagnosticsStore:
        def mark_buffered_visible_output_flushed(self, *, request_id: str) -> None:
            calls.append(request_id)

    class _FakeEngine:
        _turn_diagnostics_store = _FakeDiagnosticsStore()

    kernel = SimpleNamespace(_engine=_FakeEngine())

    events: list[object] = []
    runtime = LoopRuntime(emit=events.append, request_id="req_drain_mark")
    runtime.last_iteration_unflushed = ["partial answer"]

    stop_reason = StopReason(
        decision=StopDecision.STOP,
        message="Stop.",
        code="CMP_LOOP_MAX_ITERATIONS",
    )
    streamed: set[str] = set()

    result = _build_stopped_tool_loop_result(
        runtime=runtime,
        kernel=kernel,
        stop_reason=stop_reason,
        streamed_event_types=streamed,
        outcomes=[],
        usage_totals=None,
    )

    assert "chat.token" in streamed
    assert calls == ["req_drain_mark"]
    assert "partial answer" in result.response_text


# ---------------------------------------------------------------------------
# _failed_tool_context_response  (lines 1478)
# ---------------------------------------------------------------------------


def test_failed_tool_context_response_returns_none_when_no_outcomes() -> None:
    """Line 1478 (guard): Returns None when outcomes is empty."""
    result = _failed_tool_context_response([], "I have no context.")

    assert result is None


def test_failed_tool_context_response_returns_summary_when_matches() -> None:
    """Line 1627: Returns a summary when _NO_CONTEXT_AFTER_TOOL_RE matches."""
    failed = _outcome(
        tool_name="write_file",
        output="disk full",
        success=False,
        error_code="CMP-ERR-999",
    )
    # _NO_CONTEXT_AFTER_TOOL_RE matches "no tool results" verbatim
    result = _failed_tool_context_response(
        [failed],
        "I see no tool results in the context.",
    )

    assert result is not None
    assert "write_file" in result
    assert "disk full" in result


def test_failed_tool_context_response_returns_none_when_only_successes() -> None:
    """Lines 1632-1634: Returns None when all outcomes succeeded (no failed summary)."""
    success = _outcome(tool_name="read_file", output="data", success=True)

    result = _failed_tool_context_response(
        [success],
        "I have no tool results at all.",
    )

    assert result is None


# ---------------------------------------------------------------------------
# _summarize_failed_tool_outcomes / _summarize_successful_tool_outcomes
# omitted-label paths  (lines 1653-1655)
# ---------------------------------------------------------------------------


def test_summarize_failed_tool_outcomes_includes_omitted_line_for_many_failures() -> None:
    """Lines 1653-1655: When > 3 failures, an 'additional ... omitted' line is added."""
    outcomes = [
        _outcome(tool_name=f"fail_{i}", output=f"err {i}", success=False, error_code="E")
        for i in range(5)
    ]

    result = _summarize_failed_tool_outcomes(outcomes)

    assert "additional" in result
    assert "omitted" in result


def test_summarize_successful_tool_outcomes_includes_omitted_line_for_many_successes() -> None:
    """Lines 1693-1694: When > 3 successes, an 'additional ... omitted' line is added."""
    outcomes = [
        _outcome(tool_name=f"ok_{i}", output=f"result {i}", success=True)
        for i in range(5)
    ]

    result = _summarize_successful_tool_outcomes(outcomes)

    assert "additional" in result
    assert "omitted" in result


# ---------------------------------------------------------------------------
# _summarize_failed_tool_outcomes output truncation  (line 1699)
# ---------------------------------------------------------------------------


def test_summarize_failed_tool_outcomes_truncates_long_output() -> None:
    """Line 1699: Outputs longer than 500 chars are truncated to 497 + '...'."""
    long_output = "x" * 600
    outcomes = [_outcome(tool_name="t", output=long_output, success=False)]

    result = _summarize_failed_tool_outcomes(outcomes)

    # The summarized output for this entry must be truncated
    assert "..." in result
    # The raw 600-char string should not appear verbatim
    assert long_output not in result
    # Pin the exact truncation boundary: 497 retained chars + "..." ellipsis.
    # This catches off-by-one mutations to the 497 limit that the
    # substring checks above would miss (e.g. 497 -> 499 keeps "..." and
    # still excludes the full 600-char string, but emits 499 'x' chars).
    assert "x" * 497 + "..." in result
    assert "x" * 498 + "..." not in result


# ---------------------------------------------------------------------------
# _web_search_unavailability_reason None statuses  (line 1701)
# ---------------------------------------------------------------------------


def test_web_search_unavailability_reason_returns_none_for_none_statuses() -> None:
    """Line 1701: Returns None when tool_statuses is None."""
    result = _web_search_unavailability_reason(None)

    assert result is None


# ---------------------------------------------------------------------------
# _available_tool_names skips entries with empty names  (line 1715)
# ---------------------------------------------------------------------------


def test_available_tool_names_skips_entries_with_empty_name() -> None:
    """Line 1715: Entries whose descriptor name is empty are excluded."""

    class _Entry:
        def __init__(self, name: str) -> None:
            self.descriptor = SimpleNamespace(name=name)
            self.available = True

    class _Contract:
        entries = [_Entry(""), _Entry("read_file")]

    result = _available_tool_names(_Contract())

    assert "" not in result
    assert "read_file" in result


# ---------------------------------------------------------------------------
# _bind_missing_approval_call_id empty approval_id  (lines 1733-1735)
# ---------------------------------------------------------------------------


def test_bind_missing_approval_call_id_returns_original_when_empty_approval_id() -> None:
    """Lines 1733-1735: Returns original tuple unchanged when approval_call_id is empty."""
    call = ToolCallRequest(tool_id="read_file", arguments={}, call_id="some-id")

    result = _bind_missing_approval_call_id((call,), "")

    assert result == (call,)


def test_bind_missing_approval_call_id_returns_original_when_approval_id_is_none() -> None:
    """Lines 1733-1735: Returns original tuple unchanged when approval_call_id is None."""
    call = ToolCallRequest(tool_id="read_file", arguments={}, call_id="some-id")

    result = _bind_missing_approval_call_id((call,), None)

    assert result == (call,)


# ---------------------------------------------------------------------------
# _post_tool_invalid_response_reason generic_greeting branch  (line 1770-1771)
# ---------------------------------------------------------------------------


def test_post_tool_invalid_response_reason_returns_generic_greeting() -> None:
    """Lines 1770-1771: Returns 'generic_greeting' for a greeting-only response."""
    greeting = "Hey! I'm Jenny, good to see you. How are you?"

    result = _post_tool_invalid_response_reason(
        response_text=greeting,
        harness_inventory_invalid=False,
    )

    assert result == "generic_greeting"


def test_post_tool_invalid_response_reason_returns_empty_for_normal_response() -> None:
    """Lines 1787-1788: Returns '' for a normal (non-greeting) response."""
    result = _post_tool_invalid_response_reason(
        response_text="Here is the file you requested.",
        harness_inventory_invalid=False,
    )

    assert result == ""


# ---------------------------------------------------------------------------
# _current_info_unavailability_response (line 1804)
# ---------------------------------------------------------------------------


def test_current_info_unavailability_response_returns_none_when_not_current_info() -> None:
    """Line 1804: Returns None when the user message is not a current-info request."""
    statuses = [SimpleNamespace(name="web_search", available=False, reason="key missing")]

    result = _current_info_unavailability_response(
        latest_user_content="What is 2 + 2?",
        tool_statuses=statuses,
    )

    assert result is None


def test_current_info_unavailability_response_returns_message_when_unavailable() -> None:
    """Line 1846: Returns a message when web_search is unavailable for current-info."""
    statuses = [SimpleNamespace(name="web_search", available=False, reason="no token")]

    result = _current_info_unavailability_response(
        latest_user_content="what is the current price of gold today?",
        tool_statuses=statuses,
    )

    assert result is not None
    assert "web_search" in result
    assert "no token" in result


def test_current_info_unavailability_response_actionable_for_engine_disabled() -> None:
    """Engine-disabled tools yield a 'switch to a tool-capable model' remedy."""
    from sidecar.ai.tools.assembly import ENGINE_UNSUPPORTED_REASON

    statuses = [
        SimpleNamespace(name="web_search", available=False, reason=ENGINE_UNSUPPORTED_REASON)
    ]

    result = _current_info_unavailability_response(
        latest_user_content="what's the weather in nashville and the 7 day forecast?",
        tool_statuses=statuses,
    )

    assert result is not None
    assert ENGINE_UNSUPPORTED_REASON in result
    assert "tool-capable model" in result


def test_current_info_unavailability_response_actionable_for_web_config_disabled() -> None:
    """Config-disabled web tools point the user at Settings > Tools."""
    from sidecar.ai.tools.assembly import CONFIG_DISABLED_REASON

    statuses = [
        SimpleNamespace(name="web_search", available=False, reason=CONFIG_DISABLED_REASON)
    ]

    result = _current_info_unavailability_response(
        latest_user_content="give me the current weather for nashville tn",
        tool_statuses=statuses,
    )

    assert result is not None
    assert "Settings > Tools" in result


# ---------------------------------------------------------------------------
# _emit_deterministic_response_tokens positive path  (line 1877)
# ---------------------------------------------------------------------------


def test_emit_deterministic_response_tokens_emits_tokens_when_streaming() -> None:
    """Line 1877: Tokens are emitted when streaming=True and chat.token not yet streamed."""
    events: list[object] = []
    runtime = LoopRuntime(emit=events.append, request_id="req_tokens")
    runtime.streaming = True
    streamed: set[str] = set()

    _emit_deterministic_response_tokens(
        runtime=runtime,
        streamed_event_types=streamed,
        response_text="Hello world",
    )

    token_events = [e for e in events if isinstance(e, TokenDeltaEvent)]
    # At least one token event must be emitted and chat.token added
    assert len(token_events) > 0
    joined = "".join(e.delta for e in token_events)  # type: ignore[union-attr]
    assert joined == "Hello world"
    assert "chat.token" in streamed


# ---------------------------------------------------------------------------
# _post_tool_invalid_log_data  (lines 2016-2017)
# ---------------------------------------------------------------------------


def test_post_tool_invalid_log_data_shapes_correctly() -> None:
    """Lines 2016-2017: All mandatory fields present in returned dict."""
    data = _post_tool_invalid_log_data(
        iteration=1,
        response_text="hi",
        invalid_reason="generic_greeting",
        successful_outcome_count=1,
        harness_summary_available=False,
    )

    assert data["iteration"] == 1
    assert data["response_length"] == 2
    assert data["invalid_reason"] == "generic_greeting"
    assert data["successful_outcome_count"] == 1
    assert data["harness_summary_available"] is False


# ---------------------------------------------------------------------------
# _quota_blocked_groups single-item group  (lines 2064-2065)
# ---------------------------------------------------------------------------


def test_quota_blocked_groups_single_item_not_burst() -> None:
    """Lines 2064-2065: A single call forms a single group of length 1."""

    def _blocked(tool_id: str) -> Any:
        return SimpleNamespace(
            call=SimpleNamespace(tool_id=tool_id),
            reason="limit",
            metadata={"quota_scope": "limit"},
        )

    groups = _quota_blocked_groups((_blocked("read_file"),))

    assert len(groups) == 1
    assert len(groups[0]) == 1


# ---------------------------------------------------------------------------
# _summarize_failed_tool_outcomes empty result  (line 2084)
# ---------------------------------------------------------------------------


def test_summarize_failed_tool_outcomes_returns_empty_when_no_failures() -> None:
    """Line 2084: Returns empty string when no failed outcomes."""
    outcomes = [_outcome(success=True)]

    result = _summarize_failed_tool_outcomes(outcomes)

    assert result == ""


# ---------------------------------------------------------------------------
# _bind_missing_approval_call_id unmatched policy key  (line 2213)
# ---------------------------------------------------------------------------


def test_bind_missing_approval_call_id_no_rebind_when_policy_key_does_not_match() -> None:
    """Line 2213: Call is not rebound when policy key does not match approval_call_id."""
    call_no_id = ToolCallRequest(
        tool_id="write_file",
        arguments={"path": "/tmp/out.txt", "content": "hello"},
        call_id=None,
    )
    # Use an approval id that does NOT match the policy key
    result = _bind_missing_approval_call_id(
        (call_no_id,),
        "completely-different-id-that-does-not-match",
    )

    # The call_id should remain unset (None or empty) — not rebound
    assert result[0].call_id is None or result[0].call_id == ""
