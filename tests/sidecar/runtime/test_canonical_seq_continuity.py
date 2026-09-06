"""W2-30-F07: one request-owned canonical sequence for the whole turn.

The dispatcher owns ``canonical_seq_state``; the router turn, the approval
requested/resolved emissions, the resume runtime, and the terminal decision
serializer must all advance that one counter. Pre-fix, router/resume/render
each restarted at zero, so an approval resume re-issued duplicate seq values
(and event ids derived from them) within a single turn.
"""

from __future__ import annotations

import dataclasses

from sidecar.ai.feature_flags import FEATURE_CANONICAL_TURN_EVENTS
from sidecar.ai.routing.router import ChatDecision
from sidecar.protocol import TURN_EVENT_METHOD
from sidecar.runtime.chat import (
    build_chat_send_response,
    resume_chat_send_response_from_approval_plan,
)
from tests.sidecar.ai.routing.test_replay_blanket_approval import (
    SimpleNamespace,
    ToolPolicySnapshot,
    _build_replay_router,
    _read_then_write_file_script,
)
from tests.sidecar.runtime.test_chat import _build_brain_container


def _turn_event_seqs(messages: list[dict[str, object]]) -> list[int]:
    return [
        int(message["params"]["seq"])  # type: ignore[index, call-overload]
        for message in messages
        if isinstance(message, dict) and message.get("method") == TURN_EVENT_METHOD
    ]


def test_router_turn_continues_the_request_owned_canonical_seq() -> None:
    decision = ChatDecision(
        thinking_text=None,
        response_text="Ready.",
        approval_request=None,
        tool_results=(),
    )
    container = _build_brain_container(
        decision,
        feature_flags={FEATURE_CANONICAL_TURN_EVENTS: True},
    )
    written: list[dict[str, object]] = []
    seq_state = {"seq": 5}

    response = build_chat_send_response(
        "msg-seq",
        {
            "request_id": "req-seq-router",
            "messages": [{"role": "user", "content": "hello"}],
        },
        approvals_pre_granted=True,
        brain_container=container,
        invalid_params_code=-32602,
        stream_notifications=True,
        notification_writer=written.append,
        canonical_seq_state=seq_state,
    )

    seqs = _turn_event_seqs([*written, *(response.notifications or [])])
    assert seqs, "expected canonical turn events"
    assert min(seqs) == 6, "router turn must continue after the injected floor"
    assert seqs == sorted(seqs)
    assert len(set(seqs)) == len(seqs)
    assert seq_state["seq"] == max(seqs), "shared state must record consumed seqs"


def test_approval_resume_continues_the_request_owned_canonical_seq(tmp_path) -> None:
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
        request_id="req-seq-resume",
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
            FEATURE_CANONICAL_TURN_EVENTS: True,
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
    written: list[dict[str, object]] = []
    seq_state = {"seq": 40}

    response = resume_chat_send_response_from_approval_plan(
        decision.approval_plan,
        brain_container=brain_container,
        live_params={"messages": messages},
        canonical_session_messages=[],
        stream_notifications=True,
        notification_writer=written.append,
        canonical_seq_state=seq_state,
    )

    seqs = _turn_event_seqs([*written, *(response.notifications or [])])
    assert seqs, "expected canonical turn events on resume"
    assert min(seqs) == 41, "resume must continue, never restart at 1"
    assert seqs == sorted(seqs)
    assert len(set(seqs)) == len(seqs)
    assert seq_state["seq"] == max(seqs)
