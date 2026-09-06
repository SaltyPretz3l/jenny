"""Dark-path coverage for sidecar/runtime/chat.py.

Targets uncovered lines:
207-208, 219, 256-257, 262-263, 268, 275, 342, 346, 363, 485, 487, 513, 667,
669, 733, 738-739, 741-744, 854-858, 882, 907, 959, 984, 990, 1086, 1088, 1090,
1092, 1094, 1096, 1100, 1129, 1203-1204, 1211-1213, 1386, 1486, 1542, 1571,
1591, 1639-1640, 1698, 1712, 1889, 1891, 1988, 2037, 2045-2047, 2098, 2103
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.context.builder import ContextBuilder, RuntimeToolStatus, WorkspaceStatus
from sidecar.ai.routing.router import ChatDecision
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.runtime.chat import (
    _approval_resume_descriptor,
    _approval_resume_exhausted_factory,
    _terminal_chat_response,
    build_chat_send_response,
)
from sidecar.runtime.chat_models import ChatRequestContext, ChatRequestError, ChatResponse
from sidecar.runtime.turn_retry import InnerRetryableTurnError
from sidecar.runtime.turn_state import (
    TURN_STATE_PREEMPTED,
)


# ── Helpers ──────────────────────────────────────────────────────────────────

class _TextOnlyEngine:
    supported_modalities = set()
    capabilities = {"text": True, "vision": False}

    def get_model_max_output_tokens(self) -> int | None:
        return None

    def get_model_context_length(self) -> int | None:
        return None


class _StubContextBuilder:
    workspace_root = None

    def build_system_prompt(self, *args: Any, **kwargs: Any) -> str:
        return "System prompt"

    def build_skills_system_message(self, *, tool_statuses: Any = None) -> str:
        return ""

    def build_memory_recall_system_message(self, recalled_memories: Any = None) -> str:
        return ""

    def workspace_status(self) -> WorkspaceStatus:
        return WorkspaceStatus(
            root=None,
            exists=False,
            skills_loaded=0,
            bootstrap_loaded=0,
            instruction_file_name=None,
            instruction_file_present=False,
        )


class _StubRouter:
    def __init__(self, decision: ChatDecision) -> None:
        self._decision = decision
        self.last_kwargs: dict[str, Any] = {}
        self._active_cancel_handle = None

    def build_chat_decision(self, **kwargs: Any) -> ChatDecision:
        self.last_kwargs = dict(kwargs)
        return self._decision

    def _tool_status_entries(self, **kwargs: Any) -> tuple[RuntimeToolStatus, ...]:
        return ()


def _make_brain_container(
    decision: ChatDecision,
    *,
    feature_flags: dict[str, bool] | None = None,
    engine: Any = None,
) -> Any:
    config = SimpleNamespace(
        mode="chat",
        engine_type="openai",
        model="gpt-4.1",
        feature_flags=feature_flags or {},
        system_prompt="Base prompt",
        max_tokens=8192,
        tools_workspace_root=None,
        agent_workspace_root=None,
        background_runtime_root=None,
        electron_state_root=None,
        max_loop_wall_seconds=300.0,
        chunk_inactivity_seconds=60.0,
        model_load_grace_seconds=300.0,
        max_inline_payload_bytes=65_536,
    )
    stack = SimpleNamespace(
        raw_config={},
        config=config,
        router=_StubRouter(decision),
        engine=engine or _TextOnlyEngine(),
        context_builder=_StubContextBuilder(),
        mcp_client=SimpleNamespace(available_tools=[]),
        memory_store=None,
        tool_observations=None,
    )
    return SimpleNamespace(stack=stack, subprocess_manager=None)


def _minimal_response(request_id: str, status: str = "completed") -> ChatResponse:
    from sidecar.runtime.turn_state import build_turn_result

    return ChatResponse(
        request_id=request_id,
        result=build_turn_result(request_id=request_id, status=status),
        notifications=[],
        approval_request=None,
        approval_plan=None,
    )


def _make_request_context(**kwargs: Any) -> ChatRequestContext:
    defaults = dict(
        request_id="req-dark-1",
        trace_id=None,
        session_id="session-dark",
        mode="chat",
        approvals_pre_granted=True,
    )
    defaults.update(kwargs)
    return ChatRequestContext(**defaults)


def test_approval_resume_exhausted_reraises_non_plan_drift() -> None:
    """Line 513: non-plan-drift error is re-raised, not swallowed."""
    plan = SimpleNamespace(
        request_id="req-exhaust",
        trace_id="trace-exhaust",
        session_id="session-exhaust",
    )
    handler = _approval_resume_exhausted_factory(plan)

    error = InnerRetryableTurnError(
        reason="Some other failure",
        retry_prompt="Try again.",
        terminal_subcode="protocol_violation",
    )

    with pytest.raises(InnerRetryableTurnError) as exc_info:
        handler(error, attempts=2)

    assert exc_info.value is error


def test_approval_resume_exhausted_returns_preempted_for_plan_drift(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Line 508-512: plan_drift subcode → preempted terminal response."""
    plan = SimpleNamespace(
        request_id="req-drift",
        trace_id="trace-drift",
        session_id="session-drift",
    )
    handler = _approval_resume_exhausted_factory(plan)
    log_events: list[dict[str, Any]] = []
    monkeypatch.setattr(
        "sidecar.runtime.chat.log_event",
        lambda *args, **kwargs: log_events.append(dict(kwargs)),
    )

    error = InnerRetryableTurnError(
        reason="Plan drifted.",
        retry_prompt="Refresh.",
        terminal_subcode="approval_plan_drift",
        diagnostic_components=("execution_context", "effective_args", "execution_context"),
    )

    result = handler(error, attempts=3)

    assert result.result["status"] == TURN_STATE_PREEMPTED
    assert result.request_id == "req-drift"
    assert len(log_events) == 1
    assert log_events[0] == {
        "component": "runtime.chat_resume",
        "event": "sidecar.runtime.chat_send.approval_plan_drift",
        "message": "Approval plan drifted after resume retries were exhausted.",
        "status": TURN_STATE_PREEMPTED,
        "trace_id": "trace-drift",
        "request_id": "req-drift",
        "session_id": "session-drift",
        "data": {
            "terminal_subcode": "plan_drift",
            "attempt_count": 3,
            "mismatch_components": ["effective_args", "execution_context"],
        },
    }
    assert "Plan drifted" not in repr(log_events)


# ── Tests: tool result ui_payload / generated_artifacts / error_code paths ───

def test_tool_result_notification_includes_ui_payload() -> None:
    """Line 667: ui_payload appears in tool.result notification when present."""
    from sidecar.ai.routing.router import ToolExecutionOutcome

    outcome = ToolExecutionOutcome(
        tool_name="read_file",
        tool_input={"path": "test.txt"},
        success=True,
        output="file contents",
        content_type="text/plain",
        ui_payload={"render": "code"},
        call_id="call-ui-1",
    )
    decision = ChatDecision(
        thinking_text=None,
        response_text="Done.",
        approval_request=None,
        tool_results=(outcome,),
        streamed_event_types=frozenset(),  # not streaming → batch notifications
    )
    brain = _make_brain_container(decision)

    response = build_chat_send_response(
        "msg-ui",
        {"request_id": "req-ui", "messages": [{"role": "user", "content": "read test.txt"}]},
        approvals_pre_granted=True,
        brain_container=brain,
        invalid_params_code=-32602,
    )

    tool_result_notif = next(
        n for n in response.notifications if n.get("method") == "tool.result"
    )
    assert tool_result_notif["params"]["ui_payload"] == {"render": "code"}


def test_tool_result_notification_includes_generated_artifacts() -> None:
    """Line 669: generated_artifacts appears in tool.result notification when present."""
    from sidecar.ai.routing.router import ToolExecutionOutcome

    artifact = {"path": "output.txt", "kind": "file"}
    outcome = ToolExecutionOutcome(
        tool_name="run_code",
        tool_input={"code": "print('hi')"},
        success=True,
        output="hi",
        content_type="text/plain",
        generated_artifacts=[artifact],
        call_id="call-art-1",
    )
    decision = ChatDecision(
        thinking_text=None,
        response_text="Done.",
        approval_request=None,
        tool_results=(outcome,),
        streamed_event_types=frozenset(),
    )
    brain = _make_brain_container(decision)

    response = build_chat_send_response(
        "msg-art",
        {"request_id": "req-art", "messages": [{"role": "user", "content": "run code"}]},
        approvals_pre_granted=True,
        brain_container=brain,
        invalid_params_code=-32602,
    )

    tool_result_notif = next(
        n for n in response.notifications if n.get("method") == "tool.result"
    )
    assert tool_result_notif["params"]["generated_artifacts"] == [artifact]


# ── Tests: context token estimation fallback (lines 733, 738-739, 741-744) ───

def test_context_token_estimation_uses_char_backend_when_tokenizer_unavailable() -> None:
    """Lines 733, 738-744: when context_tokens_estimate is None and TOKEN_BUDGET is on,
    CharEstimationBackend is used as fallback when tokenizer import fails."""
    from sidecar.ai.feature_flags import FEATURE_TOKEN_BUDGET
    import unittest.mock as mock

    decision = ChatDecision(
        thinking_text=None,
        response_text="Result.",
        approval_request=None,
        tool_results=(),
        context_tokens_estimate=None,  # force the fallback branch
    )
    brain = _make_brain_container(decision, feature_flags={FEATURE_TOKEN_BUDGET: True})

    # Force the import of create_tokenizer_backend to fail so CharEstimationBackend is used
    real_import = __builtins__.__import__ if hasattr(__builtins__, "__import__") else __import__

    def _failing_import(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == "sidecar.ai.context.tokenizers":
            raise ImportError("tokenizer unavailable in test")
        return real_import(name, *args, **kwargs)

    with mock.patch("builtins.__import__", side_effect=_failing_import):
        response = build_chat_send_response(
            "msg-token-budget",
            {
                "request_id": "req-token-budget",
                "messages": [{"role": "user", "content": "x" * 100}],
            },
            approvals_pre_granted=True,
            brain_container=brain,
            invalid_params_code=-32602,
        )

    # The response should contain context_tokens_estimate in usage
    done_notif = next(n for n in response.notifications if n.get("method") == "chat.done")
    assert "context_tokens_estimate" in done_notif["params"]["usage"]
    ctx_est = done_notif["params"]["usage"]["context_tokens_estimate"]
    assert isinstance(ctx_est, int)
    # The CharEstimationBackend produces a STRICTLY POSITIVE estimate for a
    # non-empty conversation (a 100-char user turn plus system prompt). A `>= 0`
    # oracle would still pass on a broken backend that silently returns 0; pin
    # the real char-based estimate is positive. Independently verify the fallback
    # backend produces the same order of magnitude for the user turn alone.
    assert ctx_est > 0
    from sidecar.ai.context.token_budget import (
        CharEstimationBackend,
        estimate_messages_tokens,
    )
    user_turn_estimate = estimate_messages_tokens(
        [{"role": "user", "content": "x" * 100}], CharEstimationBackend()
    )
    assert user_turn_estimate > 0
    # The full-context estimate must be at least as large as the user turn alone
    # (it also includes the system prompt), proving the char backend summed
    # every message rather than dropping the body.
    assert ctx_est >= user_turn_estimate


# ── Tests: _approval_resume_descriptor (lines 854-858) ───────────────────────

def test_approval_resume_descriptor_uses_mcp_client_fallback() -> None:
    """Lines 854-857: when tool_contract has no matching entry, falls back to mcp_client."""
    tool_descriptor = SimpleNamespace(side_effecting=True, label="write_file")

    class _FakeMcpClient:
        def tool_descriptor(self, tool_id: str) -> Any:
            return tool_descriptor

    class _FakeToolContract:
        def entry(self, tool_id: str) -> None:
            return None  # no entry found

    kernel = SimpleNamespace(_mcp_client=_FakeMcpClient())
    call = SimpleNamespace(tool_id="write_file", call_id="call-mcp")

    result = _approval_resume_descriptor(
        kernel=kernel,
        tool_contract=_FakeToolContract(),
        call=call,
    )

    assert result is tool_descriptor


def test_approval_resume_descriptor_returns_none_when_no_mcp_client() -> None:
    """Line 858: no mcp_client → None returned."""
    class _FakeToolContract:
        def entry(self, tool_id: str) -> None:
            return None

    kernel = SimpleNamespace()  # no _mcp_client attr
    call = SimpleNamespace(tool_id="write_file", call_id="call-none")

    result = _approval_resume_descriptor(
        kernel=kernel,
        tool_contract=_FakeToolContract(),
        call=call,
    )

    assert result is None


def test_approval_resume_descriptor_returns_descriptor_from_entry() -> None:
    """Lines 851-853: entry() found → returns entry.descriptor."""
    expected_descriptor = SimpleNamespace(side_effecting=False, label="read_file")

    class _FakeEntry:
        descriptor = expected_descriptor

    class _FakeToolContract:
        def entry(self, tool_id: str) -> Any:
            return _FakeEntry()

    kernel = SimpleNamespace()
    call = SimpleNamespace(tool_id="read_file", call_id="call-entry")

    result = _approval_resume_descriptor(
        kernel=kernel,
        tool_contract=_FakeToolContract(),
        call=call,
    )

    assert result is expected_descriptor


# ── Tests: _approval_resume_call_window raise (line 882) ─────────────────────

def test_approval_resume_call_window_raises_when_approved_call_missing() -> None:
    """Line 882: approved call_id not found in tool_calls → InnerRetryableTurnError."""
    from sidecar.runtime.chat import _approval_resume_call_window
    from sidecar.runtime.approval_plan import ApprovalPlan

    plan = SimpleNamespace(
        approved_call_id="call-missing",
        call_id="call-missing",
        tool_calls=(
            SimpleNamespace(call_id="call-other", tool_id="read_file"),
        ),
    )

    class _FakeToolContract:
        def entry(self, tool_id: str) -> None:
            return None

    kernel = SimpleNamespace(_mcp_client=None)

    with pytest.raises(InnerRetryableTurnError) as exc_info:
        _approval_resume_call_window(plan, kernel=kernel, tool_contract=_FakeToolContract())

    assert "approval_plan_drift" == exc_info.value.terminal_subcode
    assert exc_info.value.diagnostic_components == ("approved_call",)


def test_approval_resume_call_window_reports_dropped_reserved_calls() -> None:
    """Reserved calls outside the approved window are RETURNED, not discarded."""
    from sidecar.runtime.chat import _approval_resume_call_window

    entries = {
        "read_file": SimpleNamespace(descriptor=SimpleNamespace(side_effecting=False)),
        "write_file": SimpleNamespace(descriptor=SimpleNamespace(side_effecting=True)),
    }

    class _FakeToolContract:
        def entry(self, tool_id: str) -> Any:
            return entries.get(tool_id)

    kernel = SimpleNamespace(
        _mcp_client=SimpleNamespace(tool_descriptor=lambda _name: None),
    )
    plan = SimpleNamespace(
        approved_call_id="call-approved",
        call_id="call-approved",
        tool_calls=(
            SimpleNamespace(call_id="call-read", tool_id="read_file"),
            SimpleNamespace(call_id="call-early-write", tool_id="write_file"),
            SimpleNamespace(call_id="call-unknown", tool_id="mystery_tool"),
            SimpleNamespace(call_id="call-approved", tool_id="write_file"),
            SimpleNamespace(call_id="call-after", tool_id="read_file"),
        ),
    )

    selected, dropped = _approval_resume_call_window(
        plan,
        kernel=kernel,
        tool_contract=_FakeToolContract(),
    )

    assert [call.call_id for call in selected] == ["call-read", "call-approved"]
    # Earlier side-effecting, earlier null-descriptor, and every post-approval
    # call are reserved against the turn budget and must be reported.
    assert [call.call_id for call in dropped] == [
        "call-early-write",
        "call-unknown",
        "call-after",
    ]
    assert len(selected) + len(dropped) == len(plan.tool_calls)


# ── Tests: _build_live_dynamic_system_messages with plan (line 959) ──────────

def test_build_live_dynamic_system_messages_appends_runtime_messages_from_plan() -> None:
    """Line 959: runtime system messages from plan.working_messages[1:] are appended."""
    from sidecar.runtime.chat import _build_live_dynamic_system_messages

    # Build a plan with a runtime system message in position 1
    from sidecar.ai.context.runtime_message_markers import RUNTIME_SYSTEM_MESSAGE_HEADINGS
    runtime_content = RUNTIME_SYSTEM_MESSAGE_HEADINGS[0] + " some runtime msg"
    plan = SimpleNamespace(
        working_messages=(
            {"role": "system", "content": "primary system prompt"},
            {"role": "system", "content": runtime_content},
            {"role": "user", "content": "hello"},  # stops iteration
        ),
        personality_rendered=False,
    )

    class _FakeContextBuilder:
        def build_dynamic_system_messages(self, **kwargs: Any) -> list[dict[str, Any]]:
            return []

    config = SimpleNamespace(
        feature_flags={},
        engine_type="openai",
        model="gpt-4.1",
    )

    class _FakeRouter:
        _context_builder = _FakeContextBuilder()

    stack = SimpleNamespace(config=config, router=_FakeRouter())
    brain = SimpleNamespace(stack=stack)

    import unittest.mock as mock

    with mock.patch(
        "sidecar.runtime.chat.build_dynamic_system_messages",
        return_value=[],
    ):
        result = _build_live_dynamic_system_messages(
            brain_container=brain,
            tool_statuses=(),
            plan=plan,
        )

    # The runtime message should have been appended
    assert any(
        m.get("content") == runtime_content for m in result
    ), f"Expected runtime content in {result}"


# ── Tests: _build_live_approval_working_messages (line 984, 990) ─────────────

def test_build_live_approval_working_messages_empty_plan_returns_replacement() -> None:
    """Line 984: empty working_messages → replacement returned directly."""
    from sidecar.runtime.chat import _build_live_approval_working_messages

    plan = SimpleNamespace(working_messages=())
    result = _build_live_approval_working_messages(
        plan,
        live_system_prompt="New prompt",
        dynamic_system_messages=[{"role": "system", "content": "dynamic"}],
    )

    assert result[0] == {"role": "system", "content": "New prompt"}
    assert result[1] == {"role": "system", "content": "dynamic"}


def test_build_live_approval_working_messages_stops_at_non_dynamic_message() -> None:
    """Line 990: non-dynamic system message stops prefix scan → retained in tail."""
    from sidecar.runtime.chat import _build_live_approval_working_messages

    # A static (non-dynamic) system message in position 1 stops prefix_end at 1
    plan = SimpleNamespace(
        working_messages=(
            {"role": "system", "content": "old prompt"},
            {"role": "system", "content": "static non-dynamic system message"},
            {"role": "user", "content": "hello"},
        ),
    )

    result = _build_live_approval_working_messages(
        plan,
        live_system_prompt="New prompt",
        dynamic_system_messages=[],
    )

    # Position 0 must be the new prompt
    assert result[0]["content"] == "New prompt"
    # The static system message must be kept in the tail (at position 1)
    assert any(m["content"] == "static non-dynamic system message" for m in result[1:])


# -- Tests: the ``## Personality`` prefix rule (v3) ---------------------------
# ``## Personality`` names TWO different rows: the bare name-line overlay the
# resume path regenerates, and the Electron-compiled personality CONTEXT BLOCK
# carrying the user's note. Which one a plan holds is decided by the PLAN
# (`plan_personality_block_present`), never by position -- with no skills
# configured the live overlay list is empty, so a context block sits at offset 0
# and a positional rule swallows it.

_PERSONALITY_BLOCK = (
    "## Personality\nYour name is Jenny. Personality shapes tone, not facts; the "
    "current request and the runtime, workspace, and tool instructions take "
    "precedence over everything below.\n\n### Voice\n\nOWNER-NOTE-MARKER"
)
_BARE_OVERLAY = (
    "## Personality\nYour name is OldName. Personality shapes tone, not facts; the "
    "current request and the runtime, workspace, and tool instructions take "
    "precedence over everything below."
)
_LIVE_OVERLAY = _BARE_OVERLAY.replace("OldName", "NewName")
_SKILLS_ROW = "## Runtime Skills Overlay\nskills"
_LIVE_SKILLS_ROW = "## Runtime Skills Overlay\nlive skills"


_MINIMAL_CONFIG = SimpleNamespace(
    engine_type="chatgpt", system_prompt_profile="auto", assistant_name="Jenny"
)
_LOCAL_CONFIG = SimpleNamespace(
    engine_type="ollama", system_prompt_profile="auto", assistant_name="Jenny"
)


def _plan_with(rows, *, context_blocks=None, frozen_config=None):
    """Build a plan double with the freeze-time personality decision."""
    from sidecar.ai.context.messages import resolve_personality_rendered

    effective_frozen_config = frozen_config if frozen_config is not None else _LOCAL_CONFIG
    return SimpleNamespace(
        working_messages=tuple(rows),
        request_context=SimpleNamespace(context_blocks=context_blocks or []),
        personality_rendered=resolve_personality_rendered(
            effective_frozen_config, context_blocks or []
        ),
    )


def _rebuild(plan, *, dynamic, live_prompt="old prompt", live_config=None):
    """Call the production seam exactly the way `chat_resume` does."""
    from sidecar.runtime.chat import _build_live_approval_working_messages
    from sidecar.runtime.chat_resume_prefix import personality_row_is_replaceable

    return _build_live_approval_working_messages(
        plan,
        live_system_prompt=live_prompt,
        dynamic_system_messages=dynamic,
        personality_row_replaceable=personality_row_is_replaceable(
            plan, live_config if live_config is not None else _LOCAL_CONFIG
        ),
    )


def _resume_personality_rows(plan, *, live_config):
    """Mirror the WHOLE resume assembly: overlay rebuild + prefix scan.

    Both halves must agree, so a test that exercised only one of them would
    miss exactly the class of defect this block exists to pin.
    """
    from sidecar.ai.context.runtime_overlays import build_dynamic_system_messages
    from sidecar.runtime.chat_resume_prefix import plan_personality_block_present

    dynamic = build_dynamic_system_messages(
        context_builder=ContextBuilder(None),
        config=live_config,
        personality_rendered=plan_personality_block_present(plan),
    )
    rebuilt = _rebuild(plan, dynamic=dynamic, live_prompt="P", live_config=live_config)
    return [
        str(row.get("content") or "")
        for row in rebuilt
        if str(row.get("content") or "").startswith("## Personality")
    ]


def test_personality_block_survives_when_skills_are_absent() -> None:
    """NO SKILLS + a personality block: the block sits at offset 0.

    `build_skills_system_message` returns "" whenever no skills are configured
    (the common case), so the regenerated overlay list is EMPTY. A positional
    rule reads the block as the bare overlay and drops the user's note, and the
    drift hash then reports a phantom `message_history` mismatch on every
    approval resume. Nothing changed live here, so the rebuild must be a
    byte-identical round trip.
    """
    plan = _plan_with(
        [
            {"role": "system", "content": "old prompt"},
            {"role": "system", "content": _PERSONALITY_BLOCK},
            {"role": "system", "content": "GIT-BLOCK-MARKER"},
            {"role": "user", "content": "hello"},
        ],
        context_blocks=[
            {"kind": "personality", "content": "### Voice\n\nOWNER-NOTE-MARKER"},
            {"kind": "git", "content": "GIT-BLOCK-MARKER"},
        ],
        frozen_config=_LOCAL_CONFIG,
    )

    result = _rebuild(plan, dynamic=[])

    assert [dict(row) for row in result] == [dict(row) for row in plan.working_messages]
    contents = [str(row["content"]) for row in result]
    assert contents.count(_PERSONALITY_BLOCK) == 1
    assert "OWNER-NOTE-MARKER" in "\n".join(contents)
    assert "GIT-BLOCK-MARKER" in contents


def test_personality_block_survives_a_sanitized_to_empty_body() -> None:
    """Same shape, but the block body sanitized away to the bare name line.

    The row is byte-identical to a bare overlay, so ONLY the plan can tell them
    apart -- exactly the case a text or position probe gets wrong.
    """
    header_only = (
        "## Personality\nYour name is Jenny. Personality shapes tone, not facts; the "
        "current request and the runtime, workspace, and tool instructions take "
        "precedence over everything below."
    )
    plan = _plan_with(
        [
            {"role": "system", "content": "old prompt"},
            {"role": "system", "content": header_only},
            {"role": "user", "content": "hello"},
        ],
        context_blocks=[{"kind": "personality", "content": ""}],
        frozen_config=_LOCAL_CONFIG,
    )

    result = _rebuild(plan, dynamic=[])

    assert [dict(row) for row in result] == [dict(row) for row in plan.working_messages]


def test_personality_block_survives_alongside_regenerated_skills() -> None:
    """Skills present: the stale overlay IS replaced, the block is NOT."""
    plan = _plan_with(
        [
            {"role": "system", "content": "old prompt"},
            {"role": "system", "content": _SKILLS_ROW},
            {"role": "system", "content": _PERSONALITY_BLOCK},
            {"role": "system", "content": "GIT-BLOCK-MARKER"},
            {"role": "user", "content": "hello"},
        ],
        context_blocks=[{"kind": "personality", "content": "### Voice\n\nOWNER-NOTE-MARKER"}],
        frozen_config=_LOCAL_CONFIG,
    )

    result = _rebuild(
        plan,
        dynamic=[{"role": "system", "content": _LIVE_SKILLS_ROW}],
        live_prompt="New prompt",
    )
    contents = [str(row["content"]) for row in result]

    assert contents[0] == "New prompt"
    assert contents.count(_PERSONALITY_BLOCK) == 1
    assert contents.count(_LIVE_SKILLS_ROW) == 1
    assert _SKILLS_ROW not in contents
    assert "GIT-BLOCK-MARKER" in contents


def test_bare_overlay_is_replaced_exactly_once_when_the_plan_had_no_block() -> None:
    """No block on the plan: the overlay at offset 0 IS regenerated.

    This is the half that must keep working -- a live rename has to reach the
    model, so the stale overlay is replaced, not duplicated and not preserved.
    """
    plan = _plan_with(
        [
            {"role": "system", "content": "old prompt"},
            {"role": "system", "content": _BARE_OVERLAY},
            {"role": "user", "content": "hello"},
        ],
        context_blocks=[],
        frozen_config=_LOCAL_CONFIG,
    )

    result = _rebuild(
        plan,
        dynamic=[{"role": "system", "content": _LIVE_OVERLAY}],
        live_prompt="New prompt",
    )
    contents = [str(row["content"]) for row in result]

    assert _BARE_OVERLAY not in contents
    assert contents.count(_LIVE_OVERLAY) == 1
    assert contents == ["New prompt", _LIVE_OVERLAY, "hello"]


def test_bare_overlay_and_skills_are_both_regenerated_in_assembly_order() -> None:
    """No block: `build_dynamic_system_messages` emits personality THEN skills,
    and the whole run is replaced as one prefix."""
    plan = _plan_with(
        [
            {"role": "system", "content": "old prompt"},
            {"role": "system", "content": _BARE_OVERLAY},
            {"role": "system", "content": _SKILLS_ROW},
            {"role": "system", "content": "GIT-BLOCK-MARKER"},
            {"role": "user", "content": "hello"},
        ],
        context_blocks=[{"kind": "git", "content": "GIT-BLOCK-MARKER"}],
        frozen_config=_LOCAL_CONFIG,
    )

    result = _rebuild(
        plan,
        dynamic=[
            {"role": "system", "content": _LIVE_OVERLAY},
            {"role": "system", "content": _LIVE_SKILLS_ROW},
        ],
        live_prompt="New prompt",
    )
    contents = [str(row["content"]) for row in result]

    assert contents == [
        "New prompt",
        _LIVE_OVERLAY,
        _LIVE_SKILLS_ROW,
        "GIT-BLOCK-MARKER",
        "hello",
    ]
    assert _BARE_OVERLAY not in contents
    assert _SKILLS_ROW not in contents


# -- The engine can change between freeze and approval -------------------------
# `personality_rendered` is RECORDED on the plan at freeze time, not re-derived
# on resume. Re-deriving it against LIVE config is what produced the two bugs
# below: `has_personality_context_block` alone answers "was a block on the
# wire", but the minimal profile suppresses the block even when one was sent,
# so the two questions diverge exactly when the profile changed.

_FROZEN_BLOCK_ROW = (
    "## Personality\nYour name is Jenny. Personality shapes tone, not facts; the "
    "current request and the runtime, workspace, and tool instructions take "
    "precedence over everything below.\n\n### Voice\n\nOWNER-NOTE-MARKER"
)
_WIRE_BLOCKS = [{"kind": "personality", "content": "### Voice\n\nOWNER-NOTE-MARKER"}]


def test_minimal_frozen_turn_resumed_on_a_local_engine_gets_exactly_one_bare_overlay() -> None:
    """Frozen under ChatGPT minimal, approved after switching to a local model.

    The block WAS on the wire, so a structural re-derivation says True and
    suppresses the bare overlay -- but minimal emitted no personality row at
    freeze, so there is nothing in the frozen prefix to keep either. The
    recorded decision (False) is what keeps the resumed non-minimal turn from
    reaching the model with ZERO `## Personality` messages.
    """
    plan = _plan_with(
        [
            {"role": "system", "content": "P"},
            {"role": "user", "content": "hello"},
        ],
        context_blocks=_WIRE_BLOCKS,
        frozen_config=_MINIMAL_CONFIG,
    )
    assert plan.personality_rendered is False

    rows = _resume_personality_rows(plan, live_config=_LOCAL_CONFIG)

    assert len(rows) == 1
    assert rows[0].startswith("## Personality\nYour name is Jenny.")
    # The BARE overlay: header + name line only, no compiled sections.
    assert rows[0].count("\n") == 1
    assert "OWNER-NOTE-MARKER" not in rows[0]


def test_non_minimal_frozen_turn_resumed_on_chatgpt_gets_zero_personality_rows() -> None:
    """Mirror case: minimal suppresses personality regardless of the plan.

    A rebuilt turn under the minimal profile renders no personality row at all,
    so the frozen block row must not survive into it.
    """
    plan = _plan_with(
        [
            {"role": "system", "content": "P"},
            {"role": "system", "content": _FROZEN_BLOCK_ROW},
            {"role": "user", "content": "hello"},
        ],
        context_blocks=_WIRE_BLOCKS,
        frozen_config=_LOCAL_CONFIG,
    )
    assert plan.personality_rendered is True

    assert _resume_personality_rows(plan, live_config=_MINIMAL_CONFIG) == []


def test_unchanged_profile_resume_is_a_byte_identical_round_trip() -> None:
    """The common path: nothing changed live, so nothing may move."""
    plan = _plan_with(
        [
            {"role": "system", "content": "P"},
            {"role": "system", "content": _FROZEN_BLOCK_ROW},
            {"role": "system", "content": "GIT-BLOCK-MARKER"},
            {"role": "user", "content": "hello"},
        ],
        context_blocks=_WIRE_BLOCKS,
        frozen_config=_LOCAL_CONFIG,
    )

    from sidecar.ai.context.runtime_overlays import build_dynamic_system_messages
    from sidecar.runtime.chat_resume_prefix import plan_personality_block_present

    dynamic = build_dynamic_system_messages(
        context_builder=ContextBuilder(None),
        config=_LOCAL_CONFIG,
        personality_rendered=plan_personality_block_present(plan),
    )
    assert dynamic == []
    rebuilt = _rebuild(plan, dynamic=dynamic, live_prompt="P", live_config=_LOCAL_CONFIG)

    assert [dict(row) for row in rebuilt] == [dict(row) for row in plan.working_messages]


def test_build_approval_plan_records_the_freeze_time_personality_decision() -> None:
    """The field is set by the real factory, not only by test doubles."""
    from sidecar.runtime.approval_plan import ApprovalPlan, build_approval_plan

    assert "personality_rendered" in ApprovalPlan.__dataclass_fields__
    assert ApprovalPlan.__dataclass_fields__["personality_rendered"].default is None

    def _plan(config, blocks=_WIRE_BLOCKS):
        return build_approval_plan(
            approved_call_id="call-1",
            request_context=SimpleNamespace(request_id="req-1", context_blocks=blocks),
            latest_user_content="hi",
            request_messages_hash="h",
            working_messages=[{"role": "user", "content": "hi"}],
            generation_result=None,
            tool_calls=(),
            frozen_inputs=(),
            tool_contract=None,
            tool_resolution_context=None,
            read_snapshot_cache={},
            outcomes=(),
            usage_totals=None,
            streamed_event_types=frozenset(),
            system_prompt="P",
            prompt_cache_enabled=False,
            cache_source_key="k",
            remaining_iterations=1,
            tool_payload=[],
            tool_statuses=(),
            config=config,
            engine=SimpleNamespace(),
            resolved_max_tokens=128,
        )

    assert _plan(_LOCAL_CONFIG).personality_rendered is True
    assert _plan(_MINIMAL_CONFIG).personality_rendered is False

    # Derived state, not identity: it must not perturb `approval_plan_hash`.
    # Hold `config` constant (so the model/sampling fingerprints cannot move)
    # and vary ONLY the block presence -- `build_sampling_params_hash` does not
    # read `context_blocks`, so `personality_rendered` is the single difference.
    with_block = _plan(_LOCAL_CONFIG, _WIRE_BLOCKS)
    without_block = _plan(_LOCAL_CONFIG, [])
    assert with_block.personality_rendered != without_block.personality_rendered
    assert with_block.approval_plan_hash == without_block.approval_plan_hash


def test_plan_personality_block_present_reads_the_plan_not_the_messages() -> None:
    from sidecar.runtime.chat_resume_prefix import plan_personality_block_present

    assert plan_personality_block_present(_plan_with([], context_blocks=[])) is False
    assert (
        plan_personality_block_present(
            _plan_with([], context_blocks=[{"kind": "git", "content": "G"}])
        )
        is False
    )
    assert (
        plan_personality_block_present(
            _plan_with([], context_blocks=[{"kind": "personality", "content": ""}])
        )
        is True
    )


# ── Tests: _validate_approval_plan_live_context mismatch clusters ─────────────
# (lines 1086, 1088, 1090, 1092, 1094, 1096, 1100, 1129)

def test_validate_approval_plan_raises_on_tool_contract_mismatch() -> None:
    """Line 1086: tool_contract mismatch → InnerRetryableTurnError with mismatch."""
    from sidecar.runtime.chat import _validate_approval_plan_live_context
    from sidecar.runtime.approval_plan import ApprovalPlan, FrozenExecutionInputs
    from sidecar.runtime.approval_plan import (
        build_effective_args_fingerprint,
        build_execution_context_fingerprint,
        build_message_history_hash,
        stable_hash,
        build_model_identity_fingerprint,
        build_sampling_params_hash,
        build_tool_contract_hash,
    )
    from sidecar.ai.personality import build_personality_system_message

    request_messages = [{"role": "user", "content": "write notes.md"}]
    frozen_input = FrozenExecutionInputs(
        call_id="call-write-1",
        tool_name="write_file",
        visible_tool_arguments={"path": "notes.md", "content": "hello"},
        effective_tool_arguments={"path": "notes.md", "content": "hello"},
        injected_arg_keys=(),
        effective_args_fingerprint=stable_hash({"path": "notes.md", "content": "hello"}),
        execution_context_payload={"session_id": "session-1"},
    )
    dynamic_msgs = [
        {"role": "system", "content": build_personality_system_message(None, "")},
    ]
    working_messages = [
        {"role": "system", "content": "Frozen system prompt"},
        *dynamic_msgs,
        *request_messages,
    ]

    class _FakeToolContract:
        prompt_schemas = ()
        status_entries = ()

        def entry(self, tool_id: str) -> None:
            return None

    original_contract = _FakeToolContract()

    frozen_inputs_tuple = (frozen_input,)
    plan = ApprovalPlan(
        call_id="call-write-1",
        approved_call_id="call-write-1",
        request_id="req-validate",
        trace_id=None,
        session_id="session-1",
        request_context=ChatRequestContext(
            request_id="req-validate",
            trace_id=None,
            session_id="session-1",
            mode="chat",
            approvals_pre_granted=False,
            reasoning_effort="medium",
            plan_mode=False,
            tool_preferences=None,
            session_start_date="2026-06-14",
        ),
        latest_user_content="write notes.md",
        working_messages=tuple(working_messages),
        generation_result=SimpleNamespace(content="Calling write_file"),
        tool_calls=(
            SimpleNamespace(
                tool_id="write_file",
                arguments={"path": "notes.md", "content": "hello"},
                call_id="call-write-1",
            ),
        ),
        frozen_inputs=frozen_inputs_tuple,
        tool_contract=original_contract,
        tool_resolution_context=None,
        read_snapshot_cache={},
        outcomes=(),
        usage_totals=None,
        streamed_event_types=frozenset(),
        system_prompt="Frozen system prompt",
        prompt_cache_enabled=False,
        cache_source_key="req-validate",
        remaining_iterations=2,
        request_messages_hash=build_message_history_hash(request_messages),
        tool_payload=(),
        tool_statuses=(),
        tool_contract_hash=stable_hash({"prompt_schemas": [], "status_entries": []}),
        effective_args_fingerprint=stable_hash(
            [{"call_id": "call-write-1", "tool_name": "write_file",
              "effective_tool_arguments": {"path": "notes.md", "content": "hello"}}]
        ),
        execution_context_fingerprint=stable_hash(
            [{"call_id": "call-write-1", "tool_name": "write_file",
              "execution_context": {"session_id": "session-1"}, "injected_arg_keys": []}]
        ),
        model_identity_fingerprint="example-model-fingerprint",
        system_prompt_hash=stable_hash("Frozen system prompt"),
        sampling_params_hash=stable_hash({
            "max_tokens": 8192,
            "reasoning_effort": "medium",
            "temperature": 0.0,
            "top_p": 1.0,
            "stop_sequences": None,
            "prompt_cache_enabled": False,
        }),
        message_history_hash=build_message_history_hash(working_messages),
        parent_approval_plan_hash="",
        approval_plan_hash="example-approval-hash",
    )

    live_read_snapshot_cache = {"some_file": {"mtime": 1000}}

    class _MismatchRouter:
        _context_builder = SimpleNamespace(
            build_system_prompt=lambda *a, **kw: "New different prompt",
        )
        _cache_break_detector = None

        def _assemble_tool_contract(self, **kwargs: Any) -> Any:
            # Return a contract with DIFFERENT schema → tool_contract mismatch
            class _DifferentContract:
                prompt_schemas = ("extra_schema",)
                status_entries = ()

                def entry(self, tool_id: str) -> None:
                    return None

            return _DifferentContract()

        def _freeze_effective_execution_inputs(  # noqa: PLR0913 - mirrors runtime seam
            self,
            call: Any,
            *,
            session_id: Any,
            read_snapshot_cache: Any,
            tool_contract: Any = None,
            plan_mode: bool = False,
            read_only: bool = False,
            trusted_plan_artifact_write: bool | None = None,
        ) -> FrozenExecutionInputs:
            _ = tool_contract, plan_mode, read_only, trusted_plan_artifact_write
            return frozen_input

        def _rebuild_read_snapshot_cache(self, canonical: Any) -> dict:
            return dict(live_read_snapshot_cache)

        _active_cancel_handle = None

    config = SimpleNamespace(
        feature_flags={},
        engine_type="openai",
        model="gpt-4.1",
        max_tokens=8192,
        system_prompt="New different prompt",
        session_start_date=None,
        tools_workspace_manifest_enabled=False,
        tools_task_capsule_enabled=False,
    )
    engine = _TextOnlyEngine()
    stack = SimpleNamespace(
        config=config,
        router=_MismatchRouter(),
        engine=engine,
    )
    brain = SimpleNamespace(stack=stack)

    import unittest.mock as mock

    with mock.patch(
        "sidecar.runtime.chat._build_live_approval_system_prompt",
        return_value="New different prompt",
    ), mock.patch(
        "sidecar.runtime.chat._build_live_dynamic_system_messages",
        return_value=[],
    ):
        with pytest.raises(InnerRetryableTurnError) as exc_info:
            _validate_approval_plan_live_context(
                plan,
                brain_container=brain,
                live_params=None,
                canonical_session_messages=None,
            )

    assert "approval_plan_drift" == exc_info.value.terminal_subcode
    # The reason text must mention the mismatch component
    assert "tool_contract" in exc_info.value.reason


# ── Tests: build_chat_send_response error branches ────────────────────────────

def test_build_chat_send_response_raises_on_non_dict_params() -> None:
    """Line 1571: non-dict params raises ChatRequestError."""
    decision = ChatDecision(
        thinking_text=None,
        response_text="",
        approval_request=None,
        tool_results=(),
    )
    brain = _make_brain_container(decision)

    with pytest.raises(ChatRequestError) as exc_info:
        build_chat_send_response(
            "msg-bad",
            "not a dict",
            approvals_pre_granted=True,
            brain_container=brain,
            invalid_params_code=-32602,
        )

    assert exc_info.value.rpc_code == -32602
    assert "params must be an object" in exc_info.value.message


def test_build_chat_send_response_raises_on_cancelled_handle() -> None:
    """Line 1591: cancel_handle.raise_if_cancelled() triggers ChatRequestError path."""
    from sidecar.runtime.multiplexer import TurnCancellationHandle

    decision = ChatDecision(
        thinking_text=None,
        response_text="",
        approval_request=None,
        tool_results=(),
    )
    brain = _make_brain_container(decision)

    class _AlreadyCancelledHandle:
        def raise_if_cancelled(self) -> None:
            raise ChatRequestError(
                request_id="req-cancel",
                trace_id=None,
                session_id=None,
                code="CMP-CANCEL-0001",
                message="Turn was cancelled.",
                rpc_code=-32001,
                retryable=False,
            )

    with pytest.raises(ChatRequestError) as exc_info:
        build_chat_send_response(
            "msg-cancel",
            {"request_id": "req-cancel", "messages": [{"role": "user", "content": "hi"}]},
            approvals_pre_granted=True,
            brain_container=brain,
            invalid_params_code=-32602,
            cancel_handle=_AlreadyCancelledHandle(),
        )

    assert exc_info.value.message == "Turn was cancelled."


def test_build_chat_send_response_raises_on_invalid_agent_depth() -> None:
    """Lines 1639-1640: non-numeric agent_depth → clamped to 0, no exception."""
    decision = ChatDecision(
        thinking_text=None,
        response_text="Hello.",
        approval_request=None,
        tool_results=(),
    )
    brain = _make_brain_container(decision)

    response = build_chat_send_response(
        "msg-depth",
        {
            "request_id": "req-depth",
            "messages": [{"role": "user", "content": "hi"}],
            "agent_depth": "not-a-number",
        },
        approvals_pre_granted=True,
        brain_container=brain,
        invalid_params_code=-32602,
    )

    # Should succeed with agent_depth clamped to 0
    assert response.result["status"] == "completed"


def test_build_chat_send_response_raises_on_invalid_interactive_response() -> None:
    """Line 1698: interactive_response present but invalid → ChatRequestError."""
    decision = ChatDecision(
        thinking_text=None,
        response_text="",
        approval_request=None,
        tool_results=(),
    )
    brain = _make_brain_container(decision)

    with pytest.raises(ChatRequestError) as exc_info:
        build_chat_send_response(
            "msg-bad-ir",
            {
                "request_id": "req-bad-ir",
                "messages": [{"role": "user", "content": "hi"}],
                # Present in params + non-None + will normalize to None (invalid payload)
                "interactive_response": "INVALID_NOT_A_DICT",
            },
            approvals_pre_granted=True,
            brain_container=brain,
            invalid_params_code=-32602,
        )

    assert "interactive_response" in exc_info.value.message


# ── Tests: emit_agent_progress optional fields (lines 1889, 1891) ─────────────

def test_emit_agent_progress_includes_parent_agent_id_and_terminal_subcode() -> None:
    """Lines 1889, 1891: parent_agent_id and terminal_subcode appear in payload
    when the AgentProgressEvent has them set."""
    from sidecar.ai.routing.agent_executor import AgentProgressEvent
    from sidecar.runtime.chat import _build_router_response

    captured_notifications: list[dict[str, Any]] = []

    # We patch _build_router_response indirectly by making executor.execute
    # trigger the emit_agent_progress callback with all optional fields.
    # To avoid spawning a real executor, we test the inner callback directly.

    # Extract the callback by monkeypatching AgentExecutor
    import unittest.mock as mock
    from sidecar.ai.feature_flags import FEATURE_AGENT_EXECUTOR

    decision = ChatDecision(
        thinking_text=None,
        response_text="Hello.",
        approval_request=None,
        tool_results=(),
    )

    class _FakeExecutor:
        def __init__(self, **kwargs: Any) -> None:
            # call on_progress immediately with a full event
            on_progress = kwargs.get("on_progress")
            if callable(on_progress):
                on_progress(
                    AgentProgressEvent(
                        task_id="task-1",
                        task_type="tool",
                        source="agent",
                        status="running",
                        stage="executing",
                        percent=50,
                        summary="Running tool",
                        terminal=False,
                        success=False,
                        agent_id="agent-1",
                        parent_agent_id="parent-agent-1",
                        terminal_subcode="some_subcode",
                    )
                )

        def execute(self, **kwargs: Any) -> ChatDecision:
            return decision

    brain = _make_brain_container(
        decision,
        feature_flags={FEATURE_AGENT_EXECUTOR: True},
    )

    with mock.patch(
        "sidecar.runtime.chat.AgentExecutor",
        side_effect=_FakeExecutor,
    ):
        response = build_chat_send_response(
            "msg-progress",
            {
                "request_id": "req-progress",
                "messages": [{"role": "user", "content": "do something"}],
            },
            approvals_pre_granted=True,
            brain_container=brain,
            invalid_params_code=-32602,
        )

    progress_notifs = [
        n for n in response.notifications
        if n.get("method") == "agent.progress"
    ]
    assert len(progress_notifs) >= 1
    payload = progress_notifs[0]["params"]
    assert payload["parent_agent_id"] == "parent-agent-1"
    assert payload["terminal_subcode"] == "some_subcode"


def test_build_router_response_rewraps_tool_execution_failure() -> None:
    """Lines 2061-2075: ToolExecutionFailure → ChatRequestError with error data."""
    from sidecar.ai.error_codes import CMP_TOOL_APPROVAL_DENIED as CMP_TOOL_DENIED

    class _FailingRouter:
        _active_cancel_handle = None

        def build_chat_decision(self, **kwargs: Any) -> ChatDecision:
            raise ToolExecutionFailure(
                code=CMP_TOOL_DENIED,
                message="tool-example-failed",
                retryable=False,
            )

    config = SimpleNamespace(
        mode="chat",
        engine_type="openai",
        model="gpt-4.1",
        feature_flags={},
        system_prompt="Base prompt",
        max_tokens=8192,
        tools_workspace_root=None,
        agent_workspace_root=None,
        background_runtime_root=None,
        electron_state_root=None,
        max_loop_wall_seconds=300.0,
        chunk_inactivity_seconds=60.0,
        model_load_grace_seconds=300.0,
        max_inline_payload_bytes=65_536,
    )
    stack = SimpleNamespace(
        raw_config={},
        config=config,
        router=_FailingRouter(),
        engine=_TextOnlyEngine(),
        context_builder=_StubContextBuilder(),
        mcp_client=SimpleNamespace(available_tools=[]),
        memory_store=None,
        tool_observations=None,
    )
    brain = SimpleNamespace(stack=stack, subprocess_manager=None)

    with pytest.raises(ChatRequestError) as exc_info:
        build_chat_send_response(
            "msg-tool-fail",
            {
                "request_id": "req-tool-fail",
                "messages": [{"role": "user", "content": "do a thing"}],
            },
            approvals_pre_granted=True,
            brain_container=brain,
            invalid_params_code=-32602,
        )

    err = exc_info.value
    assert err.code == CMP_TOOL_DENIED
    assert "tool-example-failed" in err.message


# ── Tests: _validate_approval_plan description with non-list components (1129) ─

def test_validate_approval_plan_builds_summary_with_non_list_components() -> None:
    """Line 1129: describe_approval_plan_changes returns a dict with non-list components."""
    from sidecar.runtime.chat import _validate_approval_plan_live_context
    from sidecar.runtime.approval_plan import (
        ApprovalPlan,
        FrozenExecutionInputs,
        build_message_history_hash,
        stable_hash,
    )
    from sidecar.ai.personality import build_personality_system_message
    import unittest.mock as mock

    request_messages = [{"role": "user", "content": "do something"}]
    frozen_input = FrozenExecutionInputs(
        call_id="call-test",
        tool_name="test_tool",
        visible_tool_arguments={"x": 1},
        effective_tool_arguments={"x": 1},
        injected_arg_keys=(),
        effective_args_fingerprint=stable_hash({"x": 1}),
        execution_context_payload={"session_id": "s1"},
    )
    dynamic_msgs = [
        {"role": "system", "content": build_personality_system_message(None, "")},
    ]
    working_messages = [
        {"role": "system", "content": "Frozen prompt"},
        *dynamic_msgs,
        *request_messages,
    ]

    class _FakeToolContract:
        prompt_schemas = ()
        status_entries = ()

        def entry(self, tool_id: str) -> None:
            return None

    plan = ApprovalPlan(
        call_id="call-test",
        approved_call_id="call-test",
        request_id="req-summary",
        trace_id=None,
        session_id="s1",
        request_context=ChatRequestContext(
            request_id="req-summary",
            trace_id=None,
            session_id="s1",
            mode="chat",
            approvals_pre_granted=False,
            reasoning_effort="medium",
            plan_mode=False,
            tool_preferences=None,
        ),
        latest_user_content="do something",
        working_messages=tuple(working_messages),
        generation_result=SimpleNamespace(content="Calling test_tool"),
        tool_calls=(
            SimpleNamespace(tool_id="test_tool", arguments={"x": 1}, call_id="call-test"),
        ),
        frozen_inputs=(frozen_input,),
        tool_contract=_FakeToolContract(),
        tool_resolution_context=None,
        read_snapshot_cache={},
        outcomes=(),
        usage_totals=None,
        streamed_event_types=frozenset(),
        system_prompt="Frozen prompt",
        prompt_cache_enabled=False,
        cache_source_key="req-summary",
        remaining_iterations=1,
        request_messages_hash=build_message_history_hash(request_messages),
        tool_payload=(),
        tool_statuses=(),
        tool_contract_hash=stable_hash({"prompt_schemas": [], "status_entries": []}),
        effective_args_fingerprint=stable_hash(
            [{"call_id": "call-test", "tool_name": "test_tool",
              "effective_tool_arguments": {"x": 1}}]
        ),
        execution_context_fingerprint=stable_hash(
            [{"call_id": "call-test", "tool_name": "test_tool",
              "execution_context": {"session_id": "s1"}, "injected_arg_keys": []}]
        ),
        model_identity_fingerprint="example-fp",
        system_prompt_hash=stable_hash("Frozen prompt"),
        sampling_params_hash=stable_hash({
            "max_tokens": 8192, "reasoning_effort": "medium",
            "temperature": 0.0, "top_p": 1.0,
            "stop_sequences": None, "prompt_cache_enabled": False,
        }),
        message_history_hash=build_message_history_hash(working_messages),
        parent_approval_plan_hash="",
        approval_plan_hash="example-hash",
    )

    # Fake describe_approval_plan_changes returning a non-list "components" value
    change_summary_with_string_components = [
        {"label": "model_changed", "components": "gpt-4.1 → gpt-4o"}
    ]

    class _MismatchRouter:
        _context_builder = SimpleNamespace(
            build_system_prompt=lambda *a, **kw: "Different prompt",
        )
        _cache_break_detector = None

        def _assemble_tool_contract(self, **kwargs: Any) -> Any:
            class _DiffContract:
                prompt_schemas = ("changed",)
                status_entries = ()

                def entry(self, tool_id: str) -> None:
                    return None

            return _DiffContract()

        def _freeze_effective_execution_inputs(  # noqa: PLR0913 - mirrors runtime seam
            self,
            call: Any,
            *,
            session_id: Any,
            read_snapshot_cache: Any,
            tool_contract: Any = None,
            plan_mode: bool = False,
            read_only: bool = False,
            trusted_plan_artifact_write: bool | None = None,
        ) -> FrozenExecutionInputs:
            _ = (
                call,
                session_id,
                read_snapshot_cache,
                tool_contract,
                plan_mode,
                read_only,
                trusted_plan_artifact_write,
            )
            return frozen_input

        def _rebuild_read_snapshot_cache(self, canonical: Any) -> dict:
            return {}

        _active_cancel_handle = None

    config = SimpleNamespace(
        feature_flags={},
        engine_type="openai",
        model="gpt-4.1",
        max_tokens=8192,
        system_prompt="Different prompt",
        session_start_date=None,
        tools_workspace_manifest_enabled=False,
        tools_task_capsule_enabled=False,
    )
    stack = SimpleNamespace(config=config, router=_MismatchRouter(), engine=_TextOnlyEngine())
    brain = SimpleNamespace(stack=stack)

    with mock.patch(
        "sidecar.runtime.chat._build_live_approval_system_prompt",
        return_value="Different prompt",
    ), mock.patch(
        "sidecar.runtime.chat._build_live_dynamic_system_messages",
        return_value=[],
    ), mock.patch(
        "sidecar.runtime.chat.describe_approval_plan_changes",
        return_value=change_summary_with_string_components,
    ):
        with pytest.raises(InnerRetryableTurnError) as exc_info:
            _validate_approval_plan_live_context(
                plan,
                brain_container=brain,
                live_params=None,
                canonical_session_messages=None,
            )

    # The non-list component ("gpt-4.1 → gpt-4o") must appear in the retry_prompt
    assert "gpt-4.1 → gpt-4o" in exc_info.value.retry_prompt
