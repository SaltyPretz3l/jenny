"""Coverage for crediting a human-interaction wait (``ask_user``) back to the
loop's wall-clock terminal check.

``tool_execution.execute_tool`` already pushes ``runtime.wall_clock_deadline``
forward by the measured ``ask_user`` wait once the tool settles (mirroring
``request_dispatch_chat._credit_approval_wait`` for approvals). But
``StopController`` snapshots its own copy of the deadline in ``__init__``
(``tool_loop_run.py`` constructs it with ``wall_clock_deadline=
runtime.wall_clock_deadline`` once, at loop start) -- crediting only the
``LoopRuntime`` field leaves that snapshot unaware the wait ever happened, so
the loop would still terminate on a deadline it did not actually spend
working. This module pins that the check reads the *live* runtime deadline,
not its own frozen copy.
"""

from __future__ import annotations

from sidecar.ai.error_codes import CMP_LOOP_WALL_CLOCK_EXCEEDED
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.loop_stop import LoopState, StopController, StopDecision

REQUEST_ID = "req-wall-clock-credit"


def _state(elapsed_seconds: float = 1.0) -> LoopState:
    return LoopState(iteration=1, max_iterations=8, elapsed_seconds=elapsed_seconds)


def _controller_mirroring_tool_loop_run(runtime: LoopRuntime) -> StopController:
    # Same wiring as ``_ToolLoopRun.__init__`` (tool_loop_run.py): the
    # constructor snapshots ``runtime.wall_clock_deadline`` at loop start.
    return StopController(runtime=runtime, wall_clock_deadline=runtime.wall_clock_deadline)


def test_ordinary_tool_still_stops_when_wall_clock_elapses() -> None:
    """Control case: no credit lands, so the check fires as before."""
    clock = [90.0]
    runtime = LoopRuntime(
        request_id=REQUEST_ID,
        wall_clock_deadline=100.0,
        clock=lambda: clock[0],
    )
    controller = _controller_mirroring_tool_loop_run(runtime)

    # An ordinary (non-ask_user) tool call spends wall time but is never
    # credited back -- the turn genuinely burned its working-time budget.
    clock[0] = 105.0

    reason = controller.evaluate(_state())
    assert reason is not None
    assert reason.decision is StopDecision.STOP
    assert reason.code == CMP_LOOP_WALL_CLOCK_EXCEEDED


def test_credited_ask_user_wait_does_not_trip_the_wall_clock_terminal() -> None:
    """The exact scenario ``execute_tool`` produces for ``ask_user``: the wait
    pushes real (monotonic) time past the ORIGINAL deadline, but the credit
    that lands on ``runtime.wall_clock_deadline`` after the tool settles must
    save the turn -- including in the StopController's own copy.
    """
    clock = [90.0]
    runtime = LoopRuntime(
        request_id=REQUEST_ID,
        wall_clock_deadline=100.0,
        clock=lambda: clock[0],
    )
    controller = _controller_mirroring_tool_loop_run(runtime)

    # The user takes 15s to answer -- longer than the 10s of budget that was
    # left (100 - 90). Real time now sits past the pre-wait deadline.
    wait_started_at = runtime.clock()
    clock[0] = 105.0
    wait_seconds = runtime.clock() - wait_started_at

    # This is exactly what tool_execution.execute_tool's finally-block does
    # once the ask_user dispatch settles: push LoopRuntime's deadline forward
    # by the measured wait.
    runtime.wall_clock_deadline += wait_seconds

    reason = controller.evaluate(_state())
    assert reason is None, "credited wait must not trip the wall-clock terminal"


def test_multiple_sequential_ask_user_waits_each_credit_independently() -> None:
    """Two ask_user calls in one turn must each push the deadline forward by
    their own measured wait, not just the first (or a fixed amount).
    """
    clock = [0.0]
    runtime = LoopRuntime(
        request_id=REQUEST_ID,
        wall_clock_deadline=10.0,
        clock=lambda: clock[0],
    )
    controller = _controller_mirroring_tool_loop_run(runtime)

    # First ask_user: 8s wait (0 -> 8), well inside the original 10s budget.
    started = runtime.clock()
    clock[0] = 8.0
    runtime.wall_clock_deadline += runtime.clock() - started

    # Second ask_user: another 9s wait (8 -> 17), which alone would blow
    # past the (credited) deadline of 18 if it were not credited too.
    started = runtime.clock()
    clock[0] = 17.0
    runtime.wall_clock_deadline += runtime.clock() - started

    assert runtime.wall_clock_deadline == 27.0
    reason = controller.evaluate(_state())
    assert reason is None
