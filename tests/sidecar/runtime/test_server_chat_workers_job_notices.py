"""The chat worker hands its turn handle's job-notice queue to the runner (row 71).

``session.job_settled`` parks jobs on ``TurnCancellationHandle.pending_job_notices``; the tool
loop only sees them through the contextvar the worker binds, so without this binding the feature
would silently do nothing (the post-turn wake would hide it).
"""

from __future__ import annotations

from typing import Any

from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.server_chat_workers import make_chat_send_worker
from sidecar.runtime.turn_job_notices import current_pending_job_notices

from .test_server_chat_workers import FakeTransport, RecordingLogger, _make_outcome


def _run_worker(cancel_handle: Any) -> list[Any]:
    seen: list[Any] = []

    def runner(msg: Any, **_options: Any) -> ProcessOutcome:
        seen.append(current_pending_job_notices())
        return _make_outcome()

    worker = make_chat_send_worker(
        message={"jsonrpc": "2.0", "id": "req-1", "method": "chat.send", "params": {}},
        transport=FakeTransport(cancel_handle=cancel_handle),
        cancel_handle=cancel_handle,
        request_id="req-1",
        chat_send_runner=runner,
        logger=RecordingLogger(),
    )
    worker()
    return seen


def test_the_runner_drains_the_queue_its_turn_handle_owns() -> None:
    handle = TurnCancellationHandle(request_id="req-1", session_id="sess-1")
    seen = _run_worker(handle)
    assert seen == [handle.pending_job_notices]
    assert current_pending_job_notices() is None, "the binding ends with the runner"


def test_a_handle_without_a_queue_still_gets_a_fresh_one() -> None:
    class _BareHandle:
        def cancel(self, *, reason: str = "chat_cancelled") -> None:
            pass

    (queue,) = _run_worker(_BareHandle())
    assert queue is not None
    assert queue.drain() == []
