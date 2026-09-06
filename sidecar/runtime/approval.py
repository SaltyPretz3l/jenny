"""Blocking tool approval request helpers."""

from __future__ import annotations

import itertools
import json
import queue
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

from sidecar.protocol import (
    API_VERSION,
    CHAT_CANCEL_METHOD,
    JSONRPC_VERSION,
    TOOL_REQUEST_APPROVAL_METHOD,
)
from sidecar.runtime.diagnostics import log_event, sanitize_diagnostic_text
from sidecar.runtime.multiplexer import (
    ApprovalResponseCancelledError,
    TurnCancellationHandle,
)

_APPROVAL_REQUEST_IDS = itertools.count(1_000_000)
_APPROVAL_CORRELATION_MAX_CHARS = 160
_EDITED_PLAN_MAX_BYTES = 16 * 1024
_ResponseReader = Callable[[float], dict[str, Any]]


def _close_response_reader(response_reader: _ResponseReader) -> None:
    close = getattr(response_reader, "close", None)
    if callable(close):
        try:
            close()
        except Exception:  # noqa: BLE001 - cleanup must not mask approval outcome.
            pass


@dataclass(frozen=True)
class ApprovalResolution:
    approved: bool
    status: str
    decision: str = ""
    feedback: str = ""
    edited_plan: dict[str, Any] | None = None

    def __bool__(self) -> bool:
        return self.approved


def _bounded_edited_plan(value: Any) -> tuple[dict[str, Any] | None, bool]:
    if not isinstance(value, dict):
        return None, False
    try:
        payload_size = len(
            json.dumps(
                value,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            ).encode("utf-8")
        )
    except (TypeError, ValueError, OverflowError, RecursionError):
        return None, False
    return (None, True) if payload_size > _EDITED_PLAN_MAX_BYTES else (value, False)


@dataclass(frozen=True)
class _ApprovalLogContext:
    logger: Any
    approval_id: int
    request_id: str | None
    trace_id: str | None
    session_id: str | None
    tool_call_id: str | None


def approval_request_message(params: dict[str, Any]) -> dict[str, Any]:
    return {
        "jsonrpc": JSONRPC_VERSION,
        "api_version": API_VERSION,
        "id": next(_APPROVAL_REQUEST_IDS),
        "method": TOOL_REQUEST_APPROVAL_METHOD,
        "params": {**params, "api_version": API_VERSION},
    }


def approval_resolution_from_response(
    response: dict[str, Any], expected_id: int
) -> ApprovalResolution:
    if response.get("id") != expected_id:
        return ApprovalResolution(approved=False, status="mismatch")

    result = response.get("result")
    if isinstance(result, dict):
        raw_decision = result.get("decision")
        decision = raw_decision.strip().lower() if isinstance(raw_decision, str) else ""
        if decision in {"approved", "approved_auto", "rejected"}:
            raw_feedback = result.get("feedback")
            if raw_feedback is not None and not isinstance(raw_feedback, str):
                return ApprovalResolution(approved=False, status="malformed")
            feedback = str(raw_feedback or "").strip()[:800]
            edited_plan, _oversized = _bounded_edited_plan(result.get("edited_plan"))
            return ApprovalResolution(
                approved=True,
                status=decision,
                decision=decision,
                feedback=feedback,
                edited_plan=edited_plan,
            )
        approved = result.get("approved")
        if isinstance(approved, bool):
            return ApprovalResolution(
                approved=approved,
                status="approved" if approved else "denied",
                decision="approved" if approved else "",
            )
        if isinstance(raw_decision, str):
            approved = decision in {"approve", "allow", "allowed"}
            return ApprovalResolution(
                approved=approved,
                status="approved" if approved else "denied",
                decision="approved" if approved else "",
            )

    return ApprovalResolution(approved=False, status="denied")


def approval_decision_from_response(response: dict[str, Any], expected_id: int) -> bool:
    """Compatibility helper for binary approval callers."""
    return approval_resolution_from_response(response, expected_id).approved


def _incoming_frame_correlation(payload: dict[str, Any]) -> dict[str, Any]:
    params = payload.get("params")
    if not isinstance(params, dict):
        return {}
    correlation: dict[str, Any] = {}
    for key in ("request_id", "trace_id", "session_id", "tool_call_id"):
        value = _correlation_value(params.get(key))
        if value:
            correlation[f"incoming_{key}"] = value
    return correlation


def request_tool_approval(
    approval_request: dict[str, Any],
    *,
    write_message: Callable[[dict[str, Any]], None],
    read_message: Callable[[float], dict[str, Any]],
    response_reader_factory: Callable[..., Callable[[float], dict[str, Any]]] | None = None,
    timeout_seconds: float,
    logger: Any,
    cancel_handle: TurnCancellationHandle | None = None,
) -> ApprovalResolution:
    request_message = approval_request_message(approval_request)
    context = _approval_log_context(
        approval_request=approval_request,
        expected_id=int(request_message["id"]),
        logger=logger,
    )
    normalized_timeout = max(0.0, float(timeout_seconds))
    if normalized_timeout <= 0:
        return _approval_timed_out(context, normalized_timeout)
    _log_approval_requested(context, approval_request, normalized_timeout)
    response_reader = (
        response_reader_factory(context.approval_id, cancel_handle=cancel_handle)
        if callable(response_reader_factory)
        else None
    )
    try:
        write_message(request_message)
        if response_reader is None:
            response_reader = _fallback_response_reader(
                read_message=read_message,
                read_timeout_seconds=normalized_timeout,
                cancel_handle=cancel_handle,
            )
        return _wait_for_approval_resolution(
            context,
            response_reader,
            timeout_seconds=normalized_timeout,
            cancel_handle=cancel_handle,
        )
    finally:
        if response_reader is not None:
            _close_response_reader(response_reader)


def _approval_log_context(
    *,
    approval_request: dict[str, Any],
    expected_id: int,
    logger: Any,
) -> _ApprovalLogContext:
    return _ApprovalLogContext(
        logger=logger,
        approval_id=expected_id,
        request_id=_correlation_value(approval_request.get("request_id")),
        trace_id=_correlation_value(approval_request.get("trace_id")),
        session_id=_correlation_value(approval_request.get("session_id")),
        tool_call_id=_correlation_value(approval_request.get("tool_call_id")),
    )


def _correlation_value(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    return sanitize_diagnostic_text(text, limit=_APPROVAL_CORRELATION_MAX_CHARS) or None


def _log_approval_requested(
    context: _ApprovalLogContext,
    approval_request: dict[str, Any],
    timeout_seconds: float,
) -> None:
    _log_approval_event(
        context,
        20,
        event="sidecar.runtime.approval.requested",
        message="Waiting for tool approval response",
        status="awaiting_approval",
        data={
            "tool_name": approval_request.get("tool_name"),
            "timeout_seconds": timeout_seconds,
        },
    )


def _log_approval_event(
    context: _ApprovalLogContext,
    level: int,
    *,
    event: str,
    message: str,
    status: str,
    data: dict[str, Any] | None = None,
) -> None:
    log_event(
        context.logger,
        level,
        component="runtime.approval",
        event=event,
        message=message,
        status=status,
        approval_id=context.approval_id,
        request_id=context.request_id,
        trace_id=context.trace_id,
        session_id=context.session_id,
        tool_call_id=context.tool_call_id,
        data=data,
    )


def _fallback_response_reader(
    *,
    read_message: Callable[[float], dict[str, Any]],
    read_timeout_seconds: float,
    cancel_handle: TurnCancellationHandle | None,
) -> _ResponseReader:
    # Fallback path for tests and single-threaded mode; the daemon reader keeps
    # the caller free to poll cancellation and timeout state.
    stop_event = threading.Event()
    q: queue.Queue[tuple[dict[str, Any] | None, BaseException | None]] = queue.Queue()

    def _bg_reader() -> None:
        try:
            while not stop_event.is_set():
                try:
                    msg = read_message(read_timeout_seconds)
                    q.put((msg, None))
                except Exception as error:  # noqa: BLE001
                    q.put((None, error))
                    break
        except Exception:  # noqa: BLE001
            pass

    threading.Thread(target=_bg_reader, daemon=True).start()

    def _fallback_reader(timeout: float) -> dict[str, Any]:
        step = 0.05
        elapsed = 0.0
        try:
            while elapsed < timeout:
                _raise_if_approval_cancelled(cancel_handle)
                try:
                    response, error = q.get(timeout=min(step, timeout - elapsed))
                except queue.Empty:
                    elapsed += step
                    continue
                if error is not None:
                    raise error
                if response is None:
                    raise RuntimeError("approval response reader returned no response")
                return response
            raise TimeoutError("timed out waiting for response")
        finally:
            stop_event.set()

    _fallback_reader.close = stop_event.set  # type: ignore[attr-defined]
    return _fallback_reader


def _raise_if_approval_cancelled(cancel_handle: TurnCancellationHandle | None) -> None:
    if cancel_handle is not None and cancel_handle.cancelled:
        raise ApprovalResponseCancelledError("approval wait cancelled")


def _wait_for_approval_resolution(
    context: _ApprovalLogContext,
    response_reader: _ResponseReader,
    *,
    timeout_seconds: float,
    cancel_handle: TurnCancellationHandle | None,
) -> ApprovalResolution:
    deadline = time.monotonic() + max(0.0, timeout_seconds)
    while True:
        if cancel_handle is not None and cancel_handle.cancelled:
            return _approval_cancelled(context, "tool approval request cancelled")
        remaining_seconds = deadline - time.monotonic()
        if remaining_seconds <= 0:
            return _approval_timed_out(context, timeout_seconds)
        try:
            approval_response = response_reader(remaining_seconds)
        except TimeoutError:
            return _approval_timed_out(context, timeout_seconds)
        except ApprovalResponseCancelledError:
            return _approval_cancelled(context, "tool approval request cancelled")
        except Exception:  # noqa: BLE001
            context.logger.exception("tool approval request/response failed")
            return ApprovalResolution(approved=False, status="runtime_error")

        resolution = _handle_approval_response(approval_response, context, cancel_handle)
        if resolution is None:
            continue
        return resolution


def _approval_timed_out(
    context: _ApprovalLogContext,
    timeout_seconds: float,
) -> ApprovalResolution:
    _log_approval_event(
        context,
        30,
        event="sidecar.runtime.approval.timeout",
        message="tool approval response timed out",
        status="timeout",
        data={"timeout_seconds": timeout_seconds},
    )
    return ApprovalResolution(approved=False, status="timeout")


def _approval_cancelled(context: _ApprovalLogContext, message: str) -> ApprovalResolution:
    _log_approval_event(
        context,
        30,
        event="sidecar.runtime.approval.cancelled",
        message=message,
        status="cancelled",
    )
    return ApprovalResolution(approved=False, status="cancelled")


def _handle_approval_response(
    approval_response: dict[str, Any],
    context: _ApprovalLogContext,
    cancel_handle: TurnCancellationHandle | None,
) -> ApprovalResolution | None:
    if approval_response.get("method") == CHAT_CANCEL_METHOD:
        if cancel_handle is not None:
            cancel_handle.cancel(reason="sidecar_cancel")
        return _approval_cancelled(
            context,
            "tool approval request cancelled via incoming cancel command",
        )

    if approval_response.get("id") != context.approval_id:
        _log_approval_mismatch(approval_response, context)
        return None

    result = approval_response.get("result")
    _edited_plan, edited_plan_oversized = _bounded_edited_plan(
        result.get("edited_plan") if isinstance(result, dict) else None
    )
    if edited_plan_oversized:
        _log_approval_event(
            context,
            30,
            event="sidecar.runtime.approval.edited_plan_dropped",
            message="Edited plan exceeded the approval payload limit",
            status="degraded",
            data={"max_bytes": _EDITED_PLAN_MAX_BYTES},
        )
    resolution = approval_resolution_from_response(approval_response, context.approval_id)
    approved = resolution.approved
    status = resolution.status
    _log_approval_event(
        context,
        20 if approved else 30,
        event="sidecar.runtime.approval.resolved",
        message="tool approval response received",
        status=status,
    )
    return resolution


def _log_approval_mismatch(
    approval_response: dict[str, Any],
    context: _ApprovalLogContext,
) -> None:
    _log_approval_event(
        context,
        30,
        event="sidecar.runtime.approval.mismatch",
        message="Ignoring non-matching approval response while waiting for tool approval",
        status="ignored",
        data={
            "incoming_id": approval_response.get("id"),
            "incoming_method": approval_response.get("method"),
            "incoming_jsonrpc": approval_response.get("jsonrpc"),
            **_incoming_frame_correlation(approval_response),
        },
    )
