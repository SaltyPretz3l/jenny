"""Model-facing normalization must not latch into tool-loop state.

``normalize_messages_for_model`` bundles two very different concerns:

* structural history hygiene (drop thinking-only assistant rows, strip thinking
  from the trailing assistant, drop blank assistant rows), and
* the ``(no content)`` empty-assistant backfill, which is a provider-API
  presentation detail.

Both used to be written back into ``working_messages`` in place
(``tool_loop_run``/``tool_loop_recovery``), which meant fabricated placeholder
text entered live loop state, the deep-copied ``ApprovalPlan`` snapshot, and
every replayed resume. The engine-side symptom (models imitating "(no content)"
as visible chat text) was fixed in the ChatGPT-subscription serializer; these
tests pin the structural half:

* the backfill only ever lands on the per-generation copy
  (``build_generation_messages``);
* history hygiene runs ONCE at loop entry (``normalize_history_for_loop``), so
  the model-facing prefix — and therefore prompt-cache reuse — stays stable
  across iterations instead of re-stripping a different trailing row each time.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

import sidecar.ai.routing.tool_loop as tool_loop_hub
from sidecar.ai.config import ToolPolicyRule, ToolPolicyRuleMatch, ToolPolicySnapshot
from sidecar.ai.context.messages import (
    EMPTY_ASSISTANT_CONTENT_PLACEHOLDER,
    build_generation_messages,
    normalize_history_for_loop,
    normalize_messages_for_model,
    strip_thinking_from_all_messages,
)
from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.runtime.approval_plan import build_message_history_hash
from tests.sidecar.ai.routing.test_tool_loop import (
    _build_router,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)


def _read_descriptor() -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name="read_file",
        description="Read a file",
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
        side_effecting=False,
        server_name="tools",
        tool_family="filesystem",
    )


def _list_descriptor() -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name="list_files",
        description="List files",
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
        side_effecting=False,
        server_name="tools",
        tool_family="filesystem",
    )


def _tool_plan(tool_id: str, call_id: str) -> _ToolPlan:
    return _ToolPlan(
        result=GenerationResult(
            content="",
            finish_reason="tool_calls",
            tool_calls=(
                ToolCallRequest(
                    tool_id=tool_id,
                    arguments={"path": "README.md"},
                    call_id=call_id,
                ),
            ),
        ),
    )


def _read_tool_plan(call_id: str) -> _ToolPlan:
    return _tool_plan("read_file", call_id)


def _tool_router(engine: _ToolLoopEngine):
    return _build_router(
        engine=engine,
        mcp_client=_StubMCPClient((_read_descriptor(), _list_descriptor())),
        extra_snapshot_tools=("list_files",),
    )


def _ask_read_policy() -> ToolPolicySnapshot:
    return ToolPolicySnapshot(
        version=2,
        rules=(
            ToolPolicyRule(
                id="ask-reads",
                decision="ask",
                reason="Review all file reads",
                match=ToolPolicyRuleMatch(tool_id="read_file"),
            ),
        ),
    )


def _pausing_router(engine: _ToolLoopEngine):
    router = _tool_router(engine)
    router._config = replace(router._config, tool_policy_snapshot=_ask_read_policy())
    return router


# History whose LAST assistant row carries a thinking block plus a separate
# thinking-only row: exercises every structural pass at once.
def _history_with_thinking() -> list[dict[str, Any]]:
    return [
        {"role": "user", "content": "first question"},
        {"role": "assistant", "content": "<think>orphaned reasoning</think>"},
        {"role": "user", "content": "second question"},
        {"role": "assistant", "content": "<think>planning</think>Prior answer."},
        {"role": "user", "content": "read README"},
    ]


def _run_decision(router, *, runtime: LoopRuntime, messages: list[dict[str, Any]] | None = None):
    return router.build_chat_decision(
        request_id="req_message_normalization",
        messages=messages if messages is not None else [{"role": "user", "content": "read README"}],
        latest_user_content="read README",
        mode="assist",
        approvals_pre_granted=False,
        runtime=runtime,
    )


def _assistant_rows(messages: Any) -> list[dict[str, Any]]:
    return [
        message
        for message in messages
        if str(message.get("role") or "") == "assistant"
    ]


def _contains_placeholder(messages: Any) -> bool:
    return any(
        str(message.get("content") or "") == EMPTY_ASSISTANT_CONTENT_PLACEHOLDER
        for message in messages
    )


# ---------------------------------------------------------------------------
# messages.py — the split itself
# ---------------------------------------------------------------------------


def test_normalize_history_for_loop_leaves_empty_assistant_rows_alone() -> None:
    messages = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "", "tool_calls": [{"name": "read_file"}]},
    ]

    normalized = normalize_history_for_loop(messages)

    # Structural hygiene keeps the tool-call row and must NOT invent content:
    # the placeholder is a model-facing concern only.
    assert normalized[-1]["content"] == ""
    assert not _contains_placeholder(normalized)


def test_build_generation_messages_copies_instead_of_mutating() -> None:
    row = {"role": "assistant", "content": "", "tool_calls": [{"name": "read_file"}]}
    messages = [{"role": "user", "content": "hi"}, row]

    generation_messages = build_generation_messages(messages)

    assert generation_messages[-1]["content"] == EMPTY_ASSISTANT_CONTENT_PLACEHOLDER
    assert row["content"] == ""
    assert messages[-1] is row
    assert generation_messages[-1] is not row


def test_normalize_messages_for_model_still_composes_both_halves() -> None:
    messages = _history_with_thinking() + [
        {"role": "assistant", "content": "", "tool_calls": [{"name": "read_file"}]},
    ]

    composed = normalize_messages_for_model(messages)

    assert composed == build_generation_messages(normalize_history_for_loop(messages))
    # Trailing-thinking stripping is deliberately positional: it targets the
    # LAST assistant row (here the tool-call row), not every historical one.
    # Only fully thinking-only rows are dropped outright.
    assert "orphaned reasoning" not in "".join(
        str(item.get("content") or "") for item in composed
    )
    assert any("<think>planning</think>" in str(item.get("content") or "") for item in composed)
    assert all(str(item.get("content") or "").strip() for item in _assistant_rows(composed))
    assert composed[-1]["content"] == EMPTY_ASSISTANT_CONTENT_PLACEHOLDER


# ---------------------------------------------------------------------------
# Tool loop — the placeholder must not reach loop state
# ---------------------------------------------------------------------------


def test_placeholder_reaches_the_engine_but_never_loop_state(monkeypatch) -> None:
    engine = _ToolLoopEngine(
        plans=[
            _read_tool_plan("call_norm_1"),
            _ToolPlan(result=GenerationResult(content="Here is the file.", finish_reason="stop")),
        ]
    )
    router = _tool_router(engine)

    # The argument handed to build_generation_messages IS live loop state; the
    # return value is the throwaway model-facing copy.
    observed_loop_state: list[list[dict[str, Any]]] = []
    real_build = tool_loop_hub.build_generation_messages

    def _recording_build(messages: Any) -> list[dict[str, Any]]:
        observed_loop_state.append([dict(item) for item in messages])
        return real_build(messages)

    monkeypatch.setattr(tool_loop_hub, "build_generation_messages", _recording_build)

    decision = _run_decision(router, runtime=LoopRuntime(max_iterations=4))

    assert decision.response_text == "Here is the file."
    assert len(observed_loop_state) == 2, "expected one generation per iteration"
    for snapshot in observed_loop_state:
        assert not _contains_placeholder(snapshot)
    # ...and the second snapshot really did carry the empty tool-call row that
    # would otherwise have been backfilled in place by the old normalize.
    tool_call_rows = [
        message
        for message in observed_loop_state[1]
        if str(message.get("role") or "") == "assistant" and message.get("tool_calls")
    ]
    assert tool_call_rows, "iteration 2 loop state has no assistant tool-call row"
    assert all(row["content"] == "" for row in tool_call_rows)

    # The engine still sees non-empty assistant content: provider APIs reject
    # empty assistant rows, which is the whole reason the backfill exists.
    engine_tool_call_rows = [
        message
        for message in engine.requests[1]["messages"]
        if str(message.get("role") or "") == "assistant" and message.get("tool_calls")
    ]
    assert engine_tool_call_rows
    assert all(
        row["content"] == EMPTY_ASSISTANT_CONTENT_PLACEHOLDER for row in engine_tool_call_rows
    )


def test_model_facing_prefix_is_stable_across_iterations() -> None:
    """Iteration N+1 must extend iteration N's prompt, never rewrite its prefix.

    ``filter_trailing_thinking_from_last_assistant`` is position-sensitive. Run
    per iteration against a growing list it would strip history's last assistant
    row on iteration 1 and then, once tool rows are appended, hand that same row
    back WITH its thinking on iteration 2 — a mid-turn prefix rewrite that voids
    the prompt cache. Running it once at loop entry keeps the prefix stable.
    """
    engine = _ToolLoopEngine(
        plans=[
            _read_tool_plan("call_prefix_1"),
            _ToolPlan(result=GenerationResult(content="Done.", finish_reason="stop")),
        ]
    )
    router = _tool_router(engine)

    _run_decision(
        router,
        runtime=LoopRuntime(max_iterations=4),
        messages=_history_with_thinking(),
    )

    first = engine.requests[0]["messages"]
    second = engine.requests[1]["messages"]
    assert len(second) > len(first)
    assert second[: len(first)] == first
    # Hygiene really did fire (otherwise prefix stability would be vacuous).
    assert not any("<think>" in str(item.get("content") or "") for item in first)


def _pause_after_one_completed_tool_round(messages: list[dict[str, Any]] | None = None):
    """Pause on iteration 2 so the snapshot contains a real tool-call row.

    Pausing on the FIRST tool call would snapshot only the system run plus
    history — no empty assistant row exists yet, so placeholder assertions
    against it would pass vacuously. Let ``list_files`` run to completion first
    (its assistant row is appended with ``content: ""``), then trip the ask
    policy on ``read_file``.
    """
    engine = _ToolLoopEngine(
        plans=[
            _tool_plan("list_files", "call_entry_auto"),
            _read_tool_plan("call_entry_gated"),
        ]
    )
    decision = _run_decision(
        _pausing_router(engine),
        runtime=LoopRuntime(max_iterations=4),
        messages=messages,
    )
    plan = decision.approval_plan
    assert plan is not None, "expected the ask-gated read_file call to pause the loop"
    return plan


def test_history_hygiene_is_applied_once_at_loop_entry() -> None:
    """Loop entry mutates the caller's list, but only structurally.

    ``chat``/``chat_resume`` read message count, context-token estimate, and
    budget messages off the same list object the loop appends into, so the entry
    pass has to land in place — it must just never fabricate content.
    """
    plan = _pause_after_one_completed_tool_round(messages=_history_with_thinking())
    snapshot = [dict(item) for item in plan.working_messages]

    # The completed list_files round is in the snapshot, and its assistant row
    # still carries the honest empty content — not a backfilled placeholder.
    completed_tool_call_rows = [
        message
        for message in snapshot
        if str(message.get("role") or "") == "assistant" and message.get("tool_calls")
    ]
    assert completed_tool_call_rows, "snapshot has no completed tool-call row to check"
    assert all(row["content"] == "" for row in completed_tool_call_rows)
    assert not _contains_placeholder(snapshot)
    assert not any("<think>" in str(item.get("content") or "") for item in snapshot)
    assert "orphaned reasoning" not in "".join(
        str(item.get("content") or "") for item in snapshot
    )
    assert any("Prior answer." in str(item.get("content") or "") for item in snapshot)
    # Entry hygiene is idempotent, so re-entering the loop on resume with this
    # snapshot is a no-op — which is what keeps the resume hash comparison
    # (chat_resume._validate_approval_plan_live_context) stable.
    assert normalize_history_for_loop(snapshot) == snapshot
    assert build_message_history_hash(
        normalize_history_for_loop(snapshot)
    ) == build_message_history_hash(snapshot)


def test_approval_pause_resume_round_trip_keeps_snapshot_clean() -> None:
    plan = _pause_after_one_completed_tool_round(messages=_history_with_thinking())
    assert not _contains_placeholder(plan.working_messages)

    # Mirror chat_resume: a fresh loop SEEDED FROM the deep-copied snapshot —
    # the replayed history is the loop's message list, exactly as
    # resume_chat_send_response_from_approval_plan hands plan.working_messages
    # back to the loop.
    resume_messages = [dict(item) for item in plan.working_messages]
    frozen_hash = build_message_history_hash(resume_messages)

    resume_engine = _ToolLoopEngine(
        plans=[_ToolPlan(result=GenerationResult(content="Resumed.", finish_reason="stop"))]
    )
    resume_router = _tool_router(resume_engine)

    resume_decision = resume_router.build_chat_decision(
        request_id="req_message_normalization_resume",
        messages=resume_messages,
        latest_user_content="read README",
        mode="assist",
        approvals_pre_granted=False,
        runtime=LoopRuntime(
            max_iterations=plan.remaining_iterations or 1,
            iteration_base=plan.completed_iterations,
        ),
    )

    assert resume_decision.response_text == "Resumed."
    # The replayed loop generated FROM the snapshot: the engine saw the prior
    # completed tool round with the model-facing placeholder on its empty
    # tool-call row...
    engine_rows = resume_engine.requests[0]["messages"]
    engine_tool_call_rows = [
        message
        for message in engine_rows
        if str(message.get("role") or "") == "assistant" and message.get("tool_calls")
    ]
    assert engine_tool_call_rows, "resume generation did not replay the snapshot history"
    assert all(
        row["content"] == EMPTY_ASSISTANT_CONTENT_PLACEHOLDER for row in engine_tool_call_rows
    )
    # ...while the replayed loop state itself stayed placeholder-free, and
    # re-running entry hygiene on it changes nothing, so the plan hash a resume
    # recomputes still matches the frozen one
    # (chat_resume._validate_approval_plan_live_context).
    assert not _contains_placeholder(resume_messages)
    assert build_message_history_hash(normalize_history_for_loop(resume_messages)) == frozen_hash


def test_non_thinking_fallback_path_still_backfills_placeholder() -> None:
    """``generation_runtime`` fallback re-derives its own model-facing copy.

    It calls ``strip_thinking_from_all_messages`` on the messages handed to
    ``_generate_step``; that helper ends in ``ensure_non_empty_assistant_content``
    itself, so the fallback engine gets non-empty assistant content whether or
    not the caller already backfilled.
    """
    loop_state = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "", "tool_calls": [{"name": "read_file"}]},
        {"role": "assistant", "content": "<think>reasoning</think>Answer."},
    ]

    fallback_messages = strip_thinking_from_all_messages(loop_state)

    assert fallback_messages[1]["content"] == EMPTY_ASSISTANT_CONTENT_PLACEHOLDER
    assert fallback_messages[2]["content"] == "Answer."
    assert loop_state[1]["content"] == ""
