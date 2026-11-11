"""Human-interaction wait credit for ``tool_execution.execute_tool``.

``ask_user`` and Electron's ``session_message.send`` can wait on a human; that wait
must not burn the turn's working-time budget (mirrors approval-wait crediting
in ``sidecar.runtime.request_dispatch_chat._credit_approval_wait``). The pair
below measures the wait and, once dispatch settles -- answered, declined, or
errored -- pushes ``runtime.wall_clock_deadline`` forward by the elapsed
amount. ``StopController`` reads that field live (``loop_stop._check_wall_clock``),
so the credit takes effect immediately, not just at the next loop restart.
"""

from __future__ import annotations

import math
from typing import Any

from sidecar.ai.routing.iteration_limits import BROWSER_USE_TOOL_ID
from sidecar.ai.tools.models import ToolCallRequest

# Electron's consent guard can extend a pending answer to 4 hours at most.
_MAX_BROWSER_CONSENT_WAIT_SECONDS = 4 * 60 * 60.0


def ask_user_wait_started_at(
    runtime: Any | None, call: ToolCallRequest, descriptor: Any = None,
) -> float | None:
    """Measure only an answer or a trusted exact-content message consent."""
    message_consent = (
        call.tool_id == "session_message" and call.arguments.get("action") == "send"
        and getattr(descriptor, "server_name", "") == "electron_tool_bridge"
    )
    if runtime is None or (call.tool_id != "ask_user" and not message_consent):
        return None
    return runtime.clock()


def credit_ask_user_wait(runtime: Any | None, wait_started_at: float | None) -> None:
    """Credit the measured human-interaction wait back to the working deadline.

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


def credit_browser_consent_wait(
    runtime: Any | None, call: ToolCallRequest, descriptor: Any, outcome: Any,
) -> None:
    """Credit the human consent wait the Electron browser tool reports in its result.

    A whole-dispatch measurement would also credit page loads, so the browser
    tool reports ``human_wait_ms`` in its result metadata and only that is
    credited. Trusted only from the Electron bridge descriptor (the same check
    ``session_message`` uses); only a finite non-negative number counts, clamped
    to the 4-hour consent window. Never raises: a malformed report credits nothing.
    """
    try:
        if (
            runtime is None
            or call.tool_id != BROWSER_USE_TOOL_ID
            or getattr(descriptor, "server_name", "") != "electron_tool_bridge"
        ):
            return
        deadline = runtime.wall_clock_deadline
        metadata = getattr(outcome, "metadata", None)
        raw = metadata.get("human_wait_ms") if isinstance(metadata, dict) else None
        if deadline is None or isinstance(raw, bool) or not isinstance(raw, int | float):
            return
        if not math.isfinite(raw) or raw < 0:
            return
        runtime.wall_clock_deadline = deadline + min(
            raw / 1000.0, _MAX_BROWSER_CONSENT_WAIT_SECONDS
        )
    except Exception:  # noqa: BLE001 - accounting must never fail a completed tool call.
        return
