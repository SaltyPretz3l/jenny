"""Chat worker helpers for the JSON-RPC stdio server."""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable

from sidecar.ai.error_codes import (
    CMP_CHAT_INVALID_PARAMS,
    CMP_CHAT_STREAM_FAILED,
    CMP_PROTO_DUPLICATE_REQUEST_ID,
    CMP_RESOURCE_EXCEEDED,
)
from sidecar.runtime.chat import (
    request_id_from_params,
    session_id_from_params,
    trace_id_from_params,
)
from sidecar.runtime.multiplexer import (
    ActiveTurnLimitExceededError,
    DuplicateRequestIdError,
    DuplicateSessionTurnError,
    StdioTransportMultiplexer,
)
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.rpc import error_response
from sidecar.runtime.turn_state import LiveRunModeState, bind_live_run_mode_state

ChatSendRunner = Callable[..., ProcessOutcome]
FrameWriter = Callable[[dict[str, Any]], None]
logger = logging.getLogger(__name__)

INVALID_PARAMS_CODE = -32602
INTERNAL_ERROR_CODE = -32000
MAX_ERROR_CODE_LENGTH = 32
MAX_REASON_CODE_LENGTH = 64


def _initial_live_run_mode(message: dict[str, Any]) -> LiveRunModeState:
    raw_params = message.get("params")
    params = raw_params if isinstance(raw_params, dict) else {}
    return LiveRunModeState(
        approval_mode=(
            "auto_run" if params.get("approval_mode") == "auto_run" else "prompt"
        ),
        read_only=params.get("plan_mode") is True,
    )


def send_outcome(
    outcome: ProcessOutcome,
    *,
    multiplexer: StdioTransportMultiplexer,
) -> None:
    """Resolve a multiplexed outcome through the ordered terminal bundle.

    EVERY outcome routes here, including one whose ``notifications`` list is
    empty. During live streaming ``emit()`` writes each notification straight
    to the wire and leaves ``ChatResponse.notifications`` EMPTY, so gating the
    terminal bundle on a non-empty list put the resolving response on the
    CONTROL lane -- and the writer drains control strictly before data, so the
    response overtook chat.token/chat.done frames that were already queued.
    Electron deletes the per-request notification handler the moment a response
    resolves, so those overtaken frames were dropped as
    ``sidecar.unmatched_notification``: lost turnUsage, lost streamSawDone, lost
    authoritative terminal text, silently truncated assistant output.

    ``send_terminal_result`` lands the whole bundle on the data queue as one
    all-or-none batch, so the response stays FIFO behind every already-queued
    data frame while keeping the control-sized backpressure headroom.
    ``enqueue_batch`` returns early on an empty frame tuple, so an outcome with
    neither notifications nor a response is still a no-op.
    """
    multiplexer.send_terminal_result(list(outcome.notifications), outcome.response)
    _run_post_settlement_callback(outcome)


def write_outcome_direct(outcome: ProcessOutcome, *, write_message: FrameWriter) -> None:
    for notification in outcome.notifications:
        write_message(notification)
    if outcome.response is not None:
        write_message(outcome.response)
    _run_post_settlement_callback(outcome)


def _run_post_settlement_callback(outcome: ProcessOutcome) -> None:
    callback = getattr(outcome, "post_settlement_callback", None)
    if not callable(callback):
        return
    try:
        callback()
    except Exception as error:  # noqa: BLE001 - terminal delivery already succeeded.
        logger.warning(
            "post-settlement callback failed closed",
            extra={
                "event": "sidecar.runtime.post_settlement.failed",
                "error_type": type(error).__name__,
            },
        )


def runtime_frame_writer(
    multiplexer: StdioTransportMultiplexer,
) -> FrameWriter:
    def _write(message: dict[str, Any]) -> None:
        if isinstance(message, dict) and message.get("method"):
            if str(message.get("method") or "").strip() == "tool.request_approval":
                multiplexer.send_control(message)
                return
            multiplexer.send_data(message)
            return
        multiplexer.send_control(message)

    return _write


def make_chat_send_worker(  # noqa: PLR0913
    *,
    message: dict[str, Any],
    transport: StdioTransportMultiplexer,
    cancel_handle: Any,
    request_id: str,
    chat_send_runner: ChatSendRunner,
    logger: logging.Logger,
    plugin_runtime_admission: Any | None = None,
) -> Callable[[], None]:
    def _worker() -> None:
        try:
            runner_options: dict[str, Any] = {
                "write_frame": runtime_frame_writer(transport),
                "approval_response_waiter_factory": transport.approval_reader_factory,
                "cancel_handle": cancel_handle,
            }
            if plugin_runtime_admission is not None:
                runner_options["plugin_runtime_admission"] = plugin_runtime_admission
            live_run_mode = getattr(cancel_handle, "live_run_mode", None)
            if not isinstance(live_run_mode, LiveRunModeState):
                live_run_mode = _initial_live_run_mode(message)
            with bind_live_run_mode_state(live_run_mode):
                outcome = chat_send_runner(message, **runner_options)
            send_outcome(outcome, multiplexer=transport)
        except Exception as error:  # noqa: BLE001
            logger.exception("fatal chat.send worker error")
            try:
                transport.send_control(
                    error_response(
                        message.get("id"),
                        code=-32603,
                        message=f"internal error: {type(error).__name__}",
                        data={
                            "code": CMP_CHAT_STREAM_FAILED,
                            "reason": "chat_worker_failed",
                            "retryable": False,
                        },
                    )
                )
            except Exception:  # noqa: BLE001
                logger.debug("failed to send chat.send worker error")
        finally:
            if plugin_runtime_admission is not None:
                plugin_runtime_admission.release()
            transport.unregister_turn(request_id, expected_handle=cancel_handle)

    return _worker


def prune_finished_chat_workers(
    worker_threads: set[Any],
    active_cancel_handles: dict[Any, Any],
) -> None:
    for stale_thread in [thread for thread in worker_threads if not thread.is_alive()]:
        worker_threads.discard(stale_thread)
        active_cancel_handles.pop(stale_thread, None)


def _message_transport_ids(message: dict[str, Any]) -> tuple[str, str | None, str | None]:
    params = message.get("params")
    message_id = message.get("id")
    return (
        request_id_from_params(params, message_id),
        trace_id_from_params(params, message_id),
        session_id_from_params(params),
    )


def _chat_worker_limit_error_response(
    message: dict[str, Any],
    *,
    active_count: int,
    max_active_workers: int,
) -> dict[str, Any]:
    return error_response(
        message.get("id"),
        code=INTERNAL_ERROR_CODE,
        message="too many active chat.send turns",
        data={
            "code": CMP_RESOURCE_EXCEEDED,
            "reason": "too_many_active_turns",
            "active_count": active_count,
            "max_active_workers": max_active_workers,
        },
    )


def _duplicate_request_id_error_response(
    message: dict[str, Any],
    *,
    request_id: str,
) -> dict[str, Any]:
    return error_response(
        message.get("id"),
        code=INVALID_PARAMS_CODE,
        message="duplicate active chat.send request_id",
        data={
            "code": CMP_PROTO_DUPLICATE_REQUEST_ID,
            "reason": "duplicate_request_id",
            "request_id": request_id,
        },
    )


def _session_busy_error_response(
    message: dict[str, Any],
    *,
    session_id: str,
) -> dict[str, Any]:
    return error_response(
        message.get("id"),
        code=INVALID_PARAMS_CODE,
        message="session already has an active chat.send turn",
        data={
            "code": CMP_RESOURCE_EXCEEDED,
            "reason": "session_busy",
            "session_id": session_id,
        },
    )


def _plugin_authority_error_response(
    message: dict[str, Any],
    error: Exception,
) -> dict[str, Any]:
    raw_code = str(getattr(error, "code", CMP_CHAT_INVALID_PARAMS))
    code = (
        raw_code
        if raw_code.startswith("CMP-") and len(raw_code) <= MAX_ERROR_CODE_LENGTH
        else CMP_CHAT_INVALID_PARAMS
    )
    raw_reason = str(getattr(error, "reason_code", "plugin_authority_invalid"))
    reason = (
        raw_reason
        if raw_reason.replace("_", "").isalnum()
        and len(raw_reason) <= MAX_REASON_CODE_LENGTH
        else "plugin_authority_invalid"
    )
    return error_response(
        message.get("id"),
        code=INVALID_PARAMS_CODE,
        message="chat.send plugin runtime authority rejected",
        data={
            "code": code,
            "reason": reason,
            "retryable": getattr(error, "retryable", False) is True,
        },
    )


def _release_plugin_runtime_admission(admission: Any) -> None:
    if admission is not None:
        admission.release()


def _resolve_plugin_runtime_admission(
    message: dict[str, Any],
    *,
    transport: StdioTransportMultiplexer,
    resolver: Callable[[dict[str, Any]], Any] | None,
) -> tuple[bool, Any]:
    if resolver is None:
        return True, None
    try:
        return True, resolver(message)
    except Exception as error:  # noqa: BLE001 - normalized before the wire
        transport.send_control(_plugin_authority_error_response(message, error))
        return False, None


def _register_chat_turn(  # noqa: PLR0913
    message: dict[str, Any],
    *,
    transport: StdioTransportMultiplexer,
    request_id: str,
    trace_id: str | None,
    session_id: str | None,
    generation: int | None,
    max_active_workers: int,
    plugin_runtime_admission: Any,
) -> tuple[bool, Any]:
    try:
        cancel_handle = transport.register_turn(
            request_id=request_id,
            trace_id=trace_id,
            session_id=session_id,
            generation=generation,
        )
        try:
            cancel_handle.live_run_mode = _initial_live_run_mode(message)
        except (AttributeError, TypeError):
            pass
    except DuplicateRequestIdError:
        _release_plugin_runtime_admission(plugin_runtime_admission)
        transport.send_control(_duplicate_request_id_error_response(message, request_id=request_id))
        return False, None
    except DuplicateSessionTurnError:
        _release_plugin_runtime_admission(plugin_runtime_admission)
        transport.send_control(
            _session_busy_error_response(message, session_id=str(session_id or ""))
        )
        return False, None
    except ActiveTurnLimitExceededError:
        _release_plugin_runtime_admission(plugin_runtime_admission)
        transport.send_control(
            _chat_worker_limit_error_response(
                message,
                active_count=max_active_workers,
                max_active_workers=max_active_workers,
            )
        )
        return False, None
    return True, cancel_handle


def start_chat_send_worker_if_allowed(  # noqa: PLR0913
    *,
    message: dict[str, Any],
    transport: StdioTransportMultiplexer,
    worker_threads: set[Any],
    active_cancel_handles: dict[Any, Any],
    chat_send_runner: ChatSendRunner,
    logger: logging.Logger,
    max_active_workers: int,
    plugin_admission_resolver: Callable[[dict[str, Any]], Any] | None = None,
) -> bool:
    prune_finished_chat_workers(worker_threads, active_cancel_handles)
    admitted, plugin_runtime_admission = _resolve_plugin_runtime_admission(
        message,
        transport=transport,
        resolver=plugin_admission_resolver,
    )
    if not admitted:
        return False
    live_worker_count = len(worker_threads)
    if live_worker_count >= max_active_workers:
        logger.warning(
            "Rejecting chat.send because active worker cap is reached",
            extra={
                "event": "sidecar.runtime.chat_worker_limit_exceeded",
                "active_count": live_worker_count,
                "max_active_workers": max_active_workers,
            },
        )
        transport.send_control(
            _chat_worker_limit_error_response(
                message,
                active_count=live_worker_count,
                max_active_workers=max_active_workers,
            )
        )
        _release_plugin_runtime_admission(plugin_runtime_admission)
        return False

    request_id, trace_id, session_id = _message_transport_ids(message)
    raw_params = message.get("params")
    params: dict[str, Any] = raw_params if isinstance(raw_params, dict) else {}
    raw_generation = params.get("generation")
    generation = (
        raw_generation
        if isinstance(raw_generation, int) and not isinstance(raw_generation, bool)
        and raw_generation > 0
        else None
    )
    registered, cancel_handle = _register_chat_turn(
        message,
        transport=transport,
        request_id=request_id,
        trace_id=trace_id,
        session_id=session_id,
        generation=generation,
        max_active_workers=max_active_workers,
        plugin_runtime_admission=plugin_runtime_admission,
    )
    if not registered:
        return False

    # JCA-007: registration and worker startup are one exception-safe ownership
    # transfer. If thread construction, bookkeeping, or start() raises, the
    # registered turn must be released — the worker body's ``finally`` (the only
    # other unregister site) is unreachable when startup itself fails, and a
    # leaked registration rejects every later turn for the session until restart.
    thread: threading.Thread | None = None
    try:
        thread = threading.Thread(
            target=make_chat_send_worker(
                message=message,
                transport=transport,
                cancel_handle=cancel_handle,
                request_id=request_id,
                chat_send_runner=chat_send_runner,
                logger=logger,
                plugin_runtime_admission=plugin_runtime_admission,
            ),
            name=f"sidecar-chat-send-{request_id or 'unknown'}",
            daemon=True,
        )
        worker_threads.add(thread)
        active_cancel_handles[thread] = cancel_handle
        thread.start()
    except Exception as error:  # noqa: BLE001 -- startup failure must not leak the turn
        if thread is not None:
            worker_threads.discard(thread)
            active_cancel_handles.pop(thread, None)
        try:
            transport.unregister_turn(request_id, expected_handle=cancel_handle)
        except Exception:  # noqa: BLE001
            logger.debug("failed to unregister turn after chat.send worker start failure")
        _release_plugin_runtime_admission(plugin_runtime_admission)
        logger.exception(
            "failed to start chat.send worker",
            extra={
                "event": "sidecar.runtime.chat_worker_start_failed",
                "request_id": request_id,
                "session_id": session_id,
                "error_type": type(error).__name__,
            },
        )
        if message.get("id") is not None:
            try:
                transport.send_control(
                    error_response(
                        message.get("id"),
                        code=INTERNAL_ERROR_CODE,
                        message="chat.send worker failed to start",
                        data={
                            "reason": "worker_start_failed",
                            "request_id": request_id,
                        },
                    )
                )
            except Exception:  # noqa: BLE001
                logger.debug("failed to send chat.send worker start-failure error")
        return False
    return True


def cancel_and_join_live_chat_workers(
    *,
    worker_threads: set[Any],
    active_cancel_handles: dict[Any, Any],
    shutdown_worker_grace_seconds: float,
    logger: logging.Logger,
) -> None:
    live_threads = [thread for thread in worker_threads if thread.is_alive()]
    for thread in live_threads:
        handle = active_cancel_handles.get(thread)
        if handle is not None:
            try:
                handle.cancel(reason="sidecar_shutdown")
            except Exception:  # noqa: BLE001
                logger.debug("failed to signal cancel on active chat worker during shutdown")
    deadline = time.monotonic() + shutdown_worker_grace_seconds
    for thread in live_threads:
        remaining = max(0.0, deadline - time.monotonic())
        thread.join(timeout=remaining)
    abandoned = [thread for thread in live_threads if thread.is_alive()]
    if abandoned:
        logger.warning(
            "sidecar shutdown abandoned active chat workers after grace period",
            extra={
                "event": "sidecar.shutdown.workers_abandoned",
                "abandoned_count": len(abandoned),
                "grace_seconds": shutdown_worker_grace_seconds,
            },
        )
