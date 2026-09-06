"""``resumable_stop`` coverage for the chat.done render seam."""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
from typing import Any

from sidecar.ai.tools.models import GenerationResult
from sidecar.protocol import CHAT_DONE_METHOD
from sidecar.runtime.chat_decision_render import _chat_response_from_decision
from sidecar.runtime.chat_models import ChatRequestContext
from tests.sidecar.ai.routing.test_stream_incomplete_surfacing import _Engine, _decision_for


def _render(decision: Any) -> dict[str, Any]:
    brain = SimpleNamespace(
        stack=SimpleNamespace(
            config=SimpleNamespace(
                background_runtime_root=None,
                engine_type="ollama",
                feature_flags={},
                max_inline_payload_bytes=65_536,
                model="qwen",
            ),
            engine=_Engine(GenerationResult(content="", finish_reason="stop")),
            tool_observations=None,
            turn_diagnostics=None,
        )
    )
    response = _chat_response_from_decision(
        request_context=ChatRequestContext(
            request_id="req_resumable_stop",
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
    return next(
        entry for entry in response.notifications if entry.get("method") == CHAT_DONE_METHOD
    )


def test_ordinary_turn_omits_resumable_stop() -> None:
    decision = _decision_for("stop")

    assert decision.resumable_stop is None
    assert "resumable_stop" not in _render(decision)["params"]


def test_budget_stop_emits_resumable_stop_without_changing_stop_reason() -> None:
    done = _render(replace(_decision_for("stop"), resumable_stop="context_budget"))

    assert done["params"]["resumable_stop"] == "context_budget"
    assert done["params"]["stop_reason"] == "end_turn"


def test_approval_resume_propagates_resumable_stop_to_chat_done(tmp_path, monkeypatch) -> None:
    """A turn that took an approval and THEN hit a budget must still signal it.

    ``chat_resume`` builds its ``ChatDecision`` by hand instead of going through
    ``_build_chat_decision``, so this path needs its own propagation line. The
    stubbed loop result is the only way to force a budget stop on the resumed
    leg; everything else here is the real approval-resume machinery.
    """
    import dataclasses

    from sidecar.ai import feature_flags as _feature_flags
    from sidecar.ai.routing import tool_loop as _tool_loop
    from sidecar.runtime.chat import resume_chat_send_response_from_approval_plan
    from tests.sidecar.ai.routing.test_replay_blanket_approval import (
        ToolPolicySnapshot,
        _build_replay_router,
        _read_then_write_file_script,
    )

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "notes.md").write_text("before approval", encoding="utf-8")
    router = _build_replay_router(
        tmp_path,
        snapshot=ToolPolicySnapshot.empty(),
        script_path=_read_then_write_file_script(tmp_path),
    )
    prompt = "Read notes.md, then update it with a short greeting."
    messages = [{"role": "user", "content": prompt}]
    decision = router.build_chat_decision(
        request_id="req-resume-budget",
        messages=messages,
        latest_user_content=prompt,
        mode="assist",
        approvals_pre_granted=False,
    )
    assert decision.approval_plan is not None

    resume_config = dataclasses.replace(
        router._config,  # noqa: SLF001 - harness config injection
        feature_flags={
            **(router._config.feature_flags or {}),  # noqa: SLF001
            _feature_flags.FEATURE_CANONICAL_TURN_EVENTS: True,
        },
    )
    brain_container = SimpleNamespace(
        stack=SimpleNamespace(
            config=resume_config,
            engine=router._engine,  # noqa: SLF001
            router=router,
            tool_observations=None,
        ),
        subprocess_manager=None,
    )

    def _budget_stopped_loop(**kwargs: Any) -> Any:
        runtime = kwargs["runtime"]
        return _tool_loop.ToolLoopResult(
            thinking_text=None,
            thinking_kind="status",
            persist_thinking=False,
            response_text="Reached this turn's tool limit (20).",
            approval_request=None,
            approval_plan=None,
            outcomes=[],
            usage_totals=None,
            streamed_event_types=set(runtime.streamed_event_types)
            if getattr(runtime, "streamed_event_types", None)
            else set(),
            completion_source="model",
            resumable_stop="tool_cap",
        )

    monkeypatch.setattr(_tool_loop, "run_tool_loop", _budget_stopped_loop)

    response = resume_chat_send_response_from_approval_plan(
        decision.approval_plan,
        brain_container=brain_container,
        live_params={"messages": messages},
        canonical_session_messages=[],
        stream_notifications=False,
    )

    done = next(
        entry
        for entry in (response.notifications or [])
        if entry.get("method") == CHAT_DONE_METHOD
    )
    assert done["params"]["resumable_stop"] == "tool_cap"
    assert done["params"]["stop_reason"] == "end_turn"
