"""JSON-RPC stdio server.

IMPORTANT: This module is the only sidecar runtime module that writes to stdout.
"""

from __future__ import annotations

import logging
import sys
import threading
from pathlib import Path
from time import perf_counter
from typing import Any, Callable

from sidecar.ai.container import BrainContainer
from sidecar.ai.feature_flags import (
    FEATURE_CHAT_CANCEL,
    FEATURE_MULTIPLEXER,
    is_feature_flag_enabled,
)
from sidecar.protocol import (
    CHAT_SEND_METHOD,
    CONTENT_LENGTH_HEADER,
    JSONRPC_VERSION,
)
from sidecar.runtime import request_dispatch_mcp as _mcp_dispatch
from sidecar.runtime import server_auxiliary_workers as _aux_workers
from sidecar.runtime import server_chat_workers
from sidecar.runtime.diagnostics import (
    configure_sidecar_logging,
    emit_startup_audit_mark,
    shutdown_sidecar_logging,
)
from sidecar.runtime.framing import (
    RecoverablePayloadError,
    TransportDesynchronizedError,
    read_framed_message,
    write_framed_body,
    write_framed_message,
)
from sidecar.runtime.message_reader import BackgroundMessageReader
from sidecar.runtime.multiplexer import StdioTransportMultiplexer, TransportBackpressureError
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.parent_watchdog import start_parent_death_watchdog
from sidecar.runtime.request_dispatch import (
    process_chat_send_request as runtime_process_chat_send_request,
)
from sidecar.runtime.request_dispatch import (
    process_message as runtime_process_message,
)
from sidecar.runtime.rpc import JsonRpcEnvelopeError, validate_jsonrpc_envelope
from sidecar.runtime.server_shutdown import (
    SHUTDOWN_GRACE_SECONDS,
    ShutdownContext,
    log_shutdown_stage,
    shutdown_server_runtime,
)
from sidecar.runtime.subprocess_manager import SubprocessManager
from sidecar.runtime.telemetry import capture_exception

logger = logging.getLogger(__name__)

MAX_CONTENT_LENGTH_BYTES = 10 * 1024 * 1024
TOOL_APPROVAL_TIMEOUT_SECONDS = 600.0
MAX_ACTIVE_CHAT_WORKERS = 16
MAX_ACTIVE_HARDWARE_PROFILE_WORKERS = _aux_workers.DEFAULT_MAX_ACTIVE_HARDWARE_PROFILE_WORKERS
MAX_ACTIVE_COMPACT_WORKERS = _aux_workers.DEFAULT_MAX_ACTIVE_COMPACT_WORKERS
ApprovalResponseWaiterFactory = Callable[..., Callable[[float], dict[str, Any]]]
_SUBPROCESS_MANAGER = SubprocessManager()
_BRAIN_CONTAINER = BrainContainer(subprocess_manager=_SUBPROCESS_MANAGER)
_SIDECAR_ENTRYPOINT_STARTED_AT = perf_counter()
_STDOUT_WRITE_LOCK = threading.Lock()


def _log_path() -> Path:
    home = Path.home()
    return home / ".companion" / "logs" / "sidecar.log"


def configure_logging() -> None:
    path = _log_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    configure_sidecar_logging(path, mirror_to_stderr=True)


def read_message() -> dict[str, Any]:
    """Read one Content-Length framed JSON-RPC payload from stdin."""
    return read_framed_message(
        stdin_buffer=sys.stdin.buffer,
        content_length_header=CONTENT_LENGTH_HEADER,
        max_content_length_bytes=MAX_CONTENT_LENGTH_BYTES,
    )


def write_message(message: dict[str, Any]) -> None:
    """Write one Content-Length framed JSON-RPC payload to stdout."""
    with _STDOUT_WRITE_LOCK:
        write_framed_message(
            stdout_buffer=sys.stdout.buffer,
            content_length_header=CONTENT_LENGTH_HEADER,
            message=message,
        )


def write_message_body(body: bytes) -> None:
    """Write one pre-encoded framed body to stdout under the write lock."""
    with _STDOUT_WRITE_LOCK:
        write_framed_body(
            stdout_buffer=sys.stdout.buffer,
            content_length_header=CONTENT_LENGTH_HEADER,
            body=body,
        )


def process_message(message: dict[str, Any], initialized: bool) -> ProcessOutcome:
    """Process a JSON-RPC message in the default non-interactive mode."""
    return runtime_process_message(
        message,
        initialized,
        brain_container=_BRAIN_CONTAINER,
        logger=logger,
        write_message=write_message,
        read_message=read_message,
    )


def _batch4_transport_enabled() -> bool:
    feature_flags = getattr(_BRAIN_CONTAINER.stack.config, "feature_flags", {}) or {}
    return is_feature_flag_enabled(feature_flags, FEATURE_MULTIPLEXER) and is_feature_flag_enabled(
        feature_flags,
        FEATURE_CHAT_CANCEL,
    )


def _run_chat_send_with_optional_approval(  # noqa: PLR0913
    message: dict[str, Any],
    *,
    write_frame: Callable[[dict[str, Any]], None] | None = None,
    approval_response_reader: Callable[[float], dict[str, Any]] | None = None,
    approval_response_waiter_factory: ApprovalResponseWaiterFactory | None = None,
    cancel_handle: Any | None = None,
    plugin_runtime_admission: Any | None = None,
) -> ProcessOutcome:
    """Run chat.send with blocking tool-approval flow enabled."""
    frame_writer = write_frame or write_message
    return runtime_process_chat_send_request(
        message_id=message.get("id"),
        params=message.get("params"),
        initialized=True,
        interactive_approval=True,
        brain_container=_BRAIN_CONTAINER,
        logger=logger,
        write_message=frame_writer,
        read_message=read_message,
        approval_response_reader=approval_response_reader,
        approval_response_waiter_factory=approval_response_waiter_factory,
        approval_timeout_seconds=TOOL_APPROVAL_TIMEOUT_SECONDS,
        stream_notifications=True,
        cancel_handle=cancel_handle,
        plugin_runtime_admission=plugin_runtime_admission,
    )


_send_outcome = server_chat_workers.send_outcome
_cancel_and_join_live_chat_workers = server_chat_workers.cancel_and_join_live_chat_workers


def _write_outcome_direct(outcome: ProcessOutcome) -> None:
    server_chat_workers.write_outcome_direct(outcome, write_message=write_message)


def _start_chat_send_worker_if_allowed(
    *,
    message: dict[str, Any],
    transport: StdioTransportMultiplexer,
    worker_threads: set[Any],
    active_cancel_handles: dict[Any, Any],
    max_active_workers: int = MAX_ACTIVE_CHAT_WORKERS,
) -> bool:
    return server_chat_workers.start_chat_send_worker_if_allowed(
        message=message,
        transport=transport,
        worker_threads=worker_threads,
        active_cancel_handles=active_cancel_handles,
        chat_send_runner=_run_chat_send_with_optional_approval,
        logger=logger,
        max_active_workers=max_active_workers,
        plugin_admission_resolver=lambda request: _BRAIN_CONTAINER.admit_plugin_runtime(
            request.get("params", {}).get("plugin_runtime_authority")
            if isinstance(request.get("params"), dict) else None
        ),
    )


def main() -> None:
    configure_logging()
    logger.info("sidecar server started")
    emit_startup_audit_mark(
        logger,
        "sidecar-entrypoint",
        data={"entrypoint_perf_counter_ms": round(_SIDECAR_ENTRYPOINT_STARTED_AT * 1000, 3)},
    )

    # Real-time guard against orphaning: if Electron dies (esp. SIGKILL on
    # Windows, which closes no stdin) while the main loop is blocked inside a
    # child subprocess and never reaches stdin-EOF, this watchdog self-exits the
    # sidecar within one poll interval. See sidecar/runtime/parent_watchdog.py.
    # Fail-open: arming the safety net must never prevent the sidecar from
    # starting -- a failure here only loses real-time orphan protection.
    try:
        parent_watchdog = start_parent_death_watchdog(subprocess_manager=_SUBPROCESS_MANAGER)
    except Exception:  # noqa: BLE001
        logger.exception("failed to start parent-death watchdog")
        parent_watchdog = None

    multiplexer: StdioTransportMultiplexer | None = None
    direct_outcome_transport = _aux_workers.DirectOutcomeTransport(write_message)
    initialized = False
    worker_threads: set[Any] = set()
    hardware_profile_workers: set[Any] = set()
    compact_workers: set[Any] = set()
    mcp_inspect_workers: set[Any] = set()
    family_workers: dict[str, set[Any]] = {}
    # One gate covers every auxiliary worker family: shutdown suppresses late outcomes.
    auxiliary_shutdown_gate = _aux_workers.AuxiliaryWorkerGate()
    active_cancel_handles: dict[Any, Any] = {}
    shutdown_request_started_at: float | None = None
    try:
        while True:
            shutdown_requested = False
            try:
                if multiplexer is not None:
                    message = multiplexer.read_request()
                else:
                    message = validate_jsonrpc_envelope(read_message()).payload
                method = message.get("method")
                if _mcp_dispatch.process_mcp_cancel_notification(message):
                    continue
                if method == "shutdown":
                    shutdown_request_started_at = perf_counter()
                    _mcp_dispatch.cancel_all_mcp_inspections()
                if initialized and method in _aux_workers.AUXILIARY_WORKER_METHODS:
                    _aux_workers.route_auxiliary_request(
                        method=method,
                        message=message,
                        multiplexer=multiplexer,
                        direct_transport=direct_outcome_transport,
                        hardware_worker_threads=hardware_profile_workers,
                        compact_worker_threads=compact_workers,
                        request_runner=process_message,
                        send_outcome=_send_outcome,
                        write_outcome_direct=_write_outcome_direct,
                        logger=logger,
                        shutdown_gate=auxiliary_shutdown_gate,
                        mcp_worker_threads=mcp_inspect_workers,
                        family_worker_threads=family_workers,
                    )
                    continue
                if multiplexer is not None and method == CHAT_SEND_METHOD and initialized:
                    _start_chat_send_worker_if_allowed(
                        message=message,
                        transport=multiplexer,
                        worker_threads=worker_threads,
                        active_cancel_handles=active_cancel_handles,
                    )
                    continue
                else:
                    outcome = process_message(message, initialized)

                initialized = outcome.initialized
                shutdown_requested = outcome.shutdown_requested
                if multiplexer is not None:
                    _send_outcome(outcome, multiplexer=multiplexer)
                else:
                    _write_outcome_direct(outcome)
                    if initialized and _batch4_transport_enabled():
                        multiplexer = StdioTransportMultiplexer(
                            reader=read_message,
                            write_message=write_message,
                            write_frame_body=write_message_body,
                            logger=logger,
                            message_reader_cls=BackgroundMessageReader,
                        )
                if shutdown_requested:
                    ack_started_at = shutdown_request_started_at or perf_counter()
                    log_shutdown_stage(
                        logger,
                        "request_acknowledgement",
                        "ok",
                        (ack_started_at, perf_counter() + SHUTDOWN_GRACE_SECONDS),
                    )
                    break
            except JsonRpcEnvelopeError as error:
                logger.warning(
                    "Rejected invalid inbound JSON-RPC envelope",
                    extra={
                        "event": "sidecar.runtime.transport.invalid_envelope",
                        "reason": error.reason,
                        "has_id": error.should_respond,
                    },
                )
                if error.should_respond:
                    write_message(error.response())
                continue
            except RecoverablePayloadError as error:
                logger.warning(
                    "Rejected malformed JSON-RPC payload after consuming its frame",
                    extra={
                        "event": "sidecar.runtime.transport.invalid_payload",
                        "error_type": type(error).__name__,
                    },
                )
                continue
            except TransportDesynchronizedError as error:
                logger.error(
                    "Terminating desynchronized sidecar input transport",
                    extra={
                        "event": "sidecar.runtime.transport.desynchronized",
                        "error_type": type(error).__name__,
                    },
                )
                break
            except ValueError as error:
                logger.warning("malformed message from client, skipping: %s", error)
                continue
            except EOFError:
                logger.info("stdin closed, exiting")
                break
            except TransportBackpressureError as error:
                if shutdown_requested:
                    logger.warning(
                        "shutdown acknowledgement rejected by transport backpressure; exiting",
                        extra={
                            "event": (
                                "sidecar.runtime.transport.shutdown_acknowledgement_rejected"
                            ),
                            "error_type": type(error).__name__,
                        },
                    )
                    break
                # SP-14 defense in depth: a backpressured outbound frame from any
                # dispatch path is never fatal to the main loop.
                logger.warning(
                    "sidecar main loop absorbed transport backpressure without exiting",
                    extra={
                        "event": "sidecar.runtime.transport.main_loop_backpressure_absorbed",
                        "error_type": type(error).__name__,
                    },
                )
                continue
            except Exception as error:  # noqa: BLE001
                logger.exception("fatal error in sidecar main loop")
                capture_exception(error)
                message_id = None
                try:
                    message_id = message.get("id") if isinstance(message, dict) else None  # noqa: F821
                except Exception:  # noqa: BLE001
                    pass
                if message_id is not None:
                    try:
                        write_message(
                            {
                                "jsonrpc": JSONRPC_VERSION,
                                "id": message_id,
                                "error": {
                                    "code": -32603,
                                    "message": f"internal error: {type(error).__name__}",
                                },
                            }
                        )
                    except Exception:  # noqa: BLE001
                        logger.debug("failed to send error response before exit")
                break
    finally:
        _mcp_dispatch.cancel_all_mcp_inspections()
        family_threads = set().union(*family_workers.values()) if family_workers else set()
        shutdown_server_runtime(
            ShutdownContext(
                logger=logger,
                parent_watchdog=parent_watchdog,
                worker_threads=worker_threads,
                active_cancel_handles=active_cancel_handles,
                # Snapshot union is safe because join_auxiliary_workers only reads the set.
                auxiliary_worker_threads=(
                    hardware_profile_workers | compact_workers
                    | mcp_inspect_workers | family_threads
                ),
                auxiliary_shutdown_gate=auxiliary_shutdown_gate,
                multiplexer=multiplexer,
                brain_container=_BRAIN_CONTAINER,
                subprocess_manager=_SUBPROCESS_MANAGER,
                cancel_and_join_chat_workers=_cancel_and_join_live_chat_workers,
                join_auxiliary_workers=_aux_workers.join_auxiliary_workers,
                shutdown_logging=shutdown_sidecar_logging,
            )
        )


if __name__ == "__main__":
    main()
