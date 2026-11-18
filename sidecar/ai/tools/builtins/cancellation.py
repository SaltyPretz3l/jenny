"""Cross-thread cancellation slot for the builtin MCP server's active tool call.

The builtin server executes one ``tools/call`` at a time on its dispatch
thread while a reader thread keeps draining stdin.  When the reader observes
a ``notifications/cancelled`` for the in-flight request it sets the abort
event registered here; long-running tool handlers (``run_command``) poll the
event through :func:`current_abort_event` and abort their owned subprocess.

The slot also remembers bounded cancellations that arrive *before* the dispatch
thread registers their calls (the reader thread can outrun dispatch), so
``begin_tool_call`` returns an already-set event instead of losing the
cancellation to the race.

Agent steering (row 180) adds a second, per-call WAKE event next to the abort event. The
reader thread sets it on ``notifications/jenny_wake`` (the person sent a message); a
background-job wait polls it through :func:`current_wake_event` and ends early while the job
keeps running. A wake never aborts a call, and a call's wake never outlives the call.
"""

from __future__ import annotations

import threading

_lock = threading.Lock()
_active_request_id: object | None = None
_active_event: threading.Event | None = None
_active_wake_event: threading.Event | None = None
_MAX_PRE_CANCELLED_REQUESTS = 128
_pre_cancelled_request_ids: list[object] = []
_pre_woken_request_ids: list[object] = []


def _ids_match(left: object, right: object) -> bool:
    if left is None or right is None:
        return False
    # JSON-RPC ids survive a JSON round trip, but int/str drift between the
    # transport and a hand-written client must not defeat cancellation.
    return left == right or str(left) == str(right)


def begin_tool_call(request_id: object) -> threading.Event:
    """Register the in-flight call and return its abort event."""
    global _active_request_id, _active_event, _active_wake_event  # noqa: PLW0603
    event = threading.Event()
    wake = threading.Event()
    with _lock:
        _active_request_id = request_id
        _active_event = event
        _active_wake_event = wake
        for index, woken_id in enumerate(_pre_woken_request_ids):
            if _ids_match(woken_id, request_id):
                _pre_woken_request_ids.pop(index)
                wake.set()
                break
        for index, cancelled_id in enumerate(_pre_cancelled_request_ids):
            if _ids_match(cancelled_id, request_id):
                _pre_cancelled_request_ids.pop(index)
                event.set()
                break
    return event


def end_tool_call() -> None:
    """Clear the slot once the in-flight call has produced its response."""
    global _active_request_id, _active_event, _active_wake_event  # noqa: PLW0603
    with _lock:
        had_active_call = _active_event is not None
        _active_request_id = None
        _active_event = None
        _active_wake_event = None
        if not had_active_call:
            _pre_cancelled_request_ids.clear()
            _pre_woken_request_ids.clear()


def cancel_request(request_id: object) -> bool:
    """Abort the matching in-flight call; remember an early cancellation.

    Returns True when an active call was aborted.
    """
    if request_id is None:
        return False
    with _lock:
        if _active_event is not None and _ids_match(_active_request_id, request_id):
            _active_event.set()
            return True
        if not any(
            _ids_match(cancelled_id, request_id)
            for cancelled_id in _pre_cancelled_request_ids
        ):
            if len(_pre_cancelled_request_ids) >= _MAX_PRE_CANCELLED_REQUESTS:
                _pre_cancelled_request_ids.pop(0)
            _pre_cancelled_request_ids.append(request_id)
    return False


def wake_request(request_id: object) -> bool:
    """Wake the matching in-flight call (a person's message arrived); remember an early wake.

    Returns True when an active call was woken. Never sets the abort event.
    """
    if request_id is None:
        return False
    with _lock:
        if _active_wake_event is not None and _ids_match(_active_request_id, request_id):
            _active_wake_event.set()
            return True
        if not any(_ids_match(woken_id, request_id) for woken_id in _pre_woken_request_ids):
            if len(_pre_woken_request_ids) >= _MAX_PRE_CANCELLED_REQUESTS:
                _pre_woken_request_ids.pop(0)
            _pre_woken_request_ids.append(request_id)
    return False


def current_wake_event() -> threading.Event | None:
    """Wake event of the in-flight tool call, if any (for background-job waits)."""
    with _lock:
        return _active_wake_event


def current_abort_event() -> threading.Event | None:
    """Abort event of the in-flight tool call, if any (for tool handlers)."""
    with _lock:
        return _active_event
