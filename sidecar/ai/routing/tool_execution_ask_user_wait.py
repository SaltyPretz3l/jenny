"""ask_user human-answer wait-credit bookkeeping for ``tool_execution.execute_tool``.

``ask_user`` blocks inside tool dispatch waiting on a human answer; that wait
must not burn the turn's working-time budget (mirrors approval-wait crediting
in ``sidecar.runtime.request_dispatch_chat._credit_approval_wait``). The pair
below measures the wait and, once dispatch settles -- answered, declined, or
errored -- pushes ``runtime.wall_clock_deadline`` forward by the elapsed
amount. ``StopController`` reads that field live (``loop_stop._check_wall_clock``),
so the credit takes effect immediately, not just at the next loop restart.
"""

from __future__ import annotations

from typing import Any

from sidecar.ai.tools.models import ToolCallRequest


def ask_user_wait_started_at(runtime: Any | None, call: ToolCallRequest) -> float | None:
    """Return the wait's start time for an ``ask_user`` call, else ``None``."""
    if runtime is None or call.tool_id != "ask_user":
        return None
    return runtime.clock()


def credit_ask_user_wait(runtime: Any | None, wait_started_at: float | None) -> None:
    """Credit a measured ``ask_user`` wait back onto ``runtime.wall_clock_deadline``.

    Call from a ``finally`` around the dispatch so the credit lands on every
    outcome. A no-op when there was no wait to credit (``wait_started_at`` is
    ``None``) or the turn has no deadline to push.
    """
    if wait_started_at is None or runtime is None:
        return
    deadline = runtime.wall_clock_deadline
    if deadline is None:
        return
    runtime.wall_clock_deadline = deadline + max(0.0, runtime.clock() - wait_started_at)
