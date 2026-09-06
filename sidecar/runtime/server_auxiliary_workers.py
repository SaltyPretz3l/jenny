"""Bounded non-chat workers for the multiplexed sidecar transport."""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from typing import Any, Protocol

from sidecar.ai.error_codes import CMP_RESOURCE_EXCEEDED
from sidecar.protocol import (
    CHAT_COMPACT_METHOD,
    COMMIT_GENERATE_MESSAGE_METHOD,
    HARDWARE_PROFILE_METHOD,
    HARDWARE_VRAM_USAGE_METHOD,
    MCP_INSPECT_METHOD,
    MEMORY_LIST_METHOD,
    MODELS_LIST_METHOD,
    MODELS_OLLAMA_BLOB_METHOD,
    MODELS_RESIDENT_METHOD,
    MODELS_UNLOAD_METHOD,
    SUGGESTIONS_GENERATE_METHOD,
    WORKSPACE_ABANDON_RESTORE_METHOD,
    WORKSPACE_ACKNOWLEDGE_RECOVERY_REVIEW_METHOD,
    WORKSPACE_LIST_CHANGE_SETS_METHOD,
    WORKSPACE_LIST_RECOVERY_REVIEW_METHOD,
    WORKSPACE_PREFLIGHT_UNDO_METHOD,
    WORKSPACE_RESTORE_TRASH_ENTRY_METHOD,
    WORKSPACE_UNDO_CHANGE_SET_METHOD,
)
from sidecar.runtime.chat import session_id_from_params
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.request_dispatch_mcp import (
    complete_mcp_inspection,
    prepare_mcp_inspection,
)
from sidecar.runtime.rpc import error_response, result_response

DEFAULT_MAX_ACTIVE_HARDWARE_PROFILE_WORKERS = 2
# Manual compaction runs a real model inference; one at a time is plenty and
# bounds GPU/queue pressure (JCA-004).
DEFAULT_MAX_ACTIVE_COMPACT_WORKERS = 1
DEFAULT_MAX_ACTIVE_MCP_INSPECT_WORKERS = 1
AUXILIARY_FAMILY_BY_METHOD: dict[str, str] = {
    MODELS_LIST_METHOD: "models",
    MODELS_UNLOAD_METHOD: "models",
    MODELS_RESIDENT_METHOD: "models",
    # Its own family: read-only manifest disk reads that contend with nothing in
    # "models", and llama-server-ipc-handlers.js fans out OLLAMA_SOURCE_BATCH (4)
    # of them at once. Sharing a cap of 2 rejected half of every batch, and the
    # caller caches that rejection as "no GGUF source" for 30s.
    MODELS_OLLAMA_BLOB_METHOD: "blob",
    MEMORY_LIST_METHOD: "memory",
    HARDWARE_VRAM_USAGE_METHOD: "probe",
    SUGGESTIONS_GENERATE_METHOD: "inference",
    COMMIT_GENERATE_MESSAGE_METHOD: "inference",
    WORKSPACE_LIST_CHANGE_SETS_METHOD: "workspace_recovery",
    WORKSPACE_PREFLIGHT_UNDO_METHOD: "workspace_recovery",
    WORKSPACE_UNDO_CHANGE_SET_METHOD: "workspace_recovery",
    WORKSPACE_RESTORE_TRASH_ENTRY_METHOD: "workspace_recovery",
    # WO-26: same off-loop family as the four WO-25a recovery methods above --
    # both touch the same journal store filesystem I/O and must not run on
    # the single-threaded request dispatch loop.
    WORKSPACE_LIST_RECOVERY_REVIEW_METHOD: "workspace_recovery",
    WORKSPACE_ACKNOWLEDGE_RECOVERY_REVIEW_METHOD: "workspace_recovery",
    WORKSPACE_ABANDON_RESTORE_METHOD: "workspace_recovery",
}
DEFAULT_MAX_WORKERS_BY_FAMILY: dict[str, int] = {
    "models": 2,
    # Must stay >= OLLAMA_SOURCE_BATCH in services/main/llama-server-ipc-handlers.js.
    "blob": 4,
    "memory": 2,
    "probe": 1,
    "inference": 1,
    "workspace_recovery": 1,
}
AUXILIARY_WORKER_METHODS = frozenset((
    HARDWARE_PROFILE_METHOD,
    CHAT_COMPACT_METHOD,
    MCP_INSPECT_METHOD,
    *AUXILIARY_FAMILY_BY_METHOD,
))
RequestRunner = Callable[[dict[str, Any], bool], ProcessOutcome]
OutcomeSender = Callable[..., None]


class AuxiliaryTransport(Protocol):
    def send_control(self, message: dict[str, Any]) -> None: ...


class DirectOutcomeTransport:
    """Adapt the legacy direct writer to the auxiliary transport contract."""

    def __init__(self, writer: Callable[[dict[str, Any]], None]) -> None:
        self._writer = writer

    def send_control(self, message: dict[str, Any]) -> None:
        self._writer(message)


class AuxiliaryWorkerGate:
    """Prevent late auxiliary outcomes after shutdown begins."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._closed = False
        self._inflight_deliveries = 0

    @property
    def closed(self) -> bool:
        with self._lock:
            return self._closed

    def close(self) -> int:
        with self._lock:
            self._closed = True
            return self._inflight_deliveries

    def deliver(self, callback: Callable[[], None]) -> bool:
        with self._lock:
            if self._closed:
                return False
            self._inflight_deliveries += 1
        try:
            callback()
            return True
        finally:
            with self._lock:
                self._inflight_deliveries -= 1


def _prune_finished_workers(worker_threads: set[Any]) -> None:
    for thread in [candidate for candidate in worker_threads if not candidate.is_alive()]:
        worker_threads.discard(thread)


def _make_auxiliary_worker(  # noqa: PLR0913
    *,
    method_label: str,
    message: dict[str, Any],
    transport: AuxiliaryTransport,
    request_runner: RequestRunner,
    outcome_sender: OutcomeSender,
    logger: logging.Logger,
    shutdown_gate: AuxiliaryWorkerGate,
    on_finish: Callable[[], None] | None = None,
) -> Callable[[], None]:
    def _worker() -> None:
        try:
            if shutdown_gate.closed:
                return
            outcome = request_runner(message, True)
            shutdown_gate.deliver(
                lambda: outcome_sender(outcome, multiplexer=transport)
            )
        except Exception as error:  # noqa: BLE001
            if shutdown_gate.closed:
                return
            error_type = type(error).__name__
            logger.exception("fatal %s worker error", method_label)
            if message.get("id") is None:
                return
            try:
                shutdown_gate.deliver(
                    lambda: transport.send_control(
                        error_response(
                            message.get("id"),
                            code=-32603,
                            message=f"internal error: {error_type}",
                        )
                    )
                )
            except Exception:  # noqa: BLE001
                logger.debug("failed to send %s worker error", method_label)
        finally:
            if on_finish is not None:
                on_finish()

    return _worker


def start_auxiliary_worker_if_allowed(  # noqa: PLR0913
    *,
    method_label: str,
    limit_event: str,
    limit_reason: str,
    message: dict[str, Any],
    transport: AuxiliaryTransport,
    worker_threads: set[Any],
    request_runner: RequestRunner,
    outcome_sender: OutcomeSender,
    logger: logging.Logger,
    max_active_workers: int,
    shutdown_gate: AuxiliaryWorkerGate | None = None,
    on_finish: Callable[[], None] | None = None,
) -> bool:
    """Start a bounded, shutdown-gated worker for a non-chat method.

    Shared by hardware.profile and chat.compact (JCA-004: any model-inference
    or otherwise slow method must never run inline on the single
    request-dispatch loop, where it would queue Stop and every later control
    request behind it).
    """
    worker_gate = shutdown_gate or AuxiliaryWorkerGate()
    if worker_gate.closed:
        return False
    _prune_finished_workers(worker_threads)
    active_count = len(worker_threads)
    if active_count >= max_active_workers:
        logger.warning(
            "Rejecting %s because active worker cap is reached",
            method_label,
            extra={
                "event": limit_event,
                "active_count": active_count,
                "max_active_workers": max_active_workers,
            },
        )
        if message.get("id") is not None:
            transport.send_control(
                error_response(
                    message.get("id"),
                    code=-32000,
                    message=f"too many active {method_label} requests",
                    data={
                        "code": CMP_RESOURCE_EXCEEDED,
                        "reason": limit_reason,
                        "active_count": active_count,
                        "max_active_workers": max_active_workers,
                    },
                )
            )
        return False

    thread = threading.Thread(
        target=_make_auxiliary_worker(
            method_label=method_label,
            message=message,
            transport=transport,
            request_runner=request_runner,
            outcome_sender=outcome_sender,
            logger=logger,
            shutdown_gate=worker_gate,
            on_finish=on_finish,
        ),
        name=f"sidecar-{method_label.replace('.', '-')}-{message.get('id', 'unknown')}",
        daemon=True,
    )
    worker_threads.add(thread)
    try:
        thread.start()
    except Exception:
        worker_threads.discard(thread)
        if on_finish is not None:
            on_finish()
        logger.exception("failed to start %s worker", method_label)
        if message.get("id") is not None:
            transport.send_control(
                error_response(
                    message.get("id"),
                    code=-32000,
                    message=f"{method_label} worker failed to start",
                )
            )
        return False
    return True


def start_mcp_inspect_worker_if_allowed(  # noqa: PLR0913
    *,
    message: dict[str, Any],
    transport: AuxiliaryTransport,
    worker_threads: set[Any],
    request_runner: RequestRunner,
    outcome_sender: OutcomeSender,
    logger: logging.Logger,
    max_active_workers: int = DEFAULT_MAX_ACTIVE_MCP_INSPECT_WORKERS,
    shutdown_gate: AuxiliaryWorkerGate | None = None,
) -> bool:
    message_id = message.get("id")
    handle, created = prepare_mcp_inspection(message_id)
    if not created:
        if message_id is not None:
            transport.send_control(error_response(
                message_id,
                code=-32600,
                message="duplicate active mcp.inspect request id",
            ))
        return False
    started = start_auxiliary_worker_if_allowed(
        method_label="mcp.inspect",
        limit_event="sidecar.runtime.mcp_inspect_worker_limit_exceeded",
        limit_reason="too_many_mcp_inspect_requests",
        message=message,
        transport=transport,
        worker_threads=worker_threads,
        request_runner=request_runner,
        outcome_sender=outcome_sender,
        logger=logger,
        max_active_workers=max_active_workers,
        shutdown_gate=shutdown_gate,
        on_finish=lambda: complete_mcp_inspection(message_id, handle),
    )
    if not started:
        complete_mcp_inspection(message_id, handle)
    return started


def start_hardware_profile_worker_if_allowed(  # noqa: PLR0913
    *,
    message: dict[str, Any],
    transport: AuxiliaryTransport,
    worker_threads: set[Any],
    request_runner: RequestRunner,
    outcome_sender: OutcomeSender,
    logger: logging.Logger,
    max_active_workers: int = DEFAULT_MAX_ACTIVE_HARDWARE_PROFILE_WORKERS,
    shutdown_gate: AuxiliaryWorkerGate | None = None,
) -> bool:
    return start_auxiliary_worker_if_allowed(
        method_label="hardware.profile",
        limit_event="sidecar.runtime.hardware_profile_worker_limit_exceeded",
        limit_reason="too_many_hardware_profile_requests",
        message=message,
        transport=transport,
        worker_threads=worker_threads,
        request_runner=request_runner,
        outcome_sender=outcome_sender,
        logger=logger,
        max_active_workers=max_active_workers,
        shutdown_gate=shutdown_gate,
    )


def route_auxiliary_request(  # noqa: PLR0913 -- explicit server-loop wiring
    *,
    method: str,
    message: dict[str, Any],
    multiplexer: Any,
    direct_transport: AuxiliaryTransport,
    hardware_worker_threads: set[Any],
    compact_worker_threads: set[Any],
    request_runner: RequestRunner,
    send_outcome: OutcomeSender,
    write_outcome_direct: Callable[[ProcessOutcome], None],
    logger: logging.Logger,
    shutdown_gate: AuxiliaryWorkerGate | None = None,
    mcp_worker_threads: set[Any] | None = None,
    family_worker_threads: dict[str, set[Any]] | None = None,
) -> bool:
    """Route a bounded non-chat method onto its worker family.

    Extracted from the server main loop (sidecar/server.py sits under a
    hotspot line cap): owns transport / outcome-sender selection plus the
    chat.compact active-session guard (JCA-004). Returns True when a worker
    was started; unknown methods return False untouched.

    Every blocking-I/O or model-inference method must be routed here.
    Anything left to dispatch inline runs on the single loop thread, where
    it stalls every later request -- including hardware.profile, whose own
    routing decision is made on that same loop, and chat.cancel.
    """
    transport = multiplexer if multiplexer is not None else direct_transport
    outcome_sender: OutcomeSender = (
        send_outcome
        if multiplexer is not None
        else (lambda outcome, **_kwargs: write_outcome_direct(outcome))
    )
    if method == MCP_INSPECT_METHOD:
        return start_mcp_inspect_worker_if_allowed(
            message=message,
            transport=transport,
            worker_threads=mcp_worker_threads if mcp_worker_threads is not None else set(),
            request_runner=request_runner,
            outcome_sender=outcome_sender,
            logger=logger,
            shutdown_gate=shutdown_gate,
        )
    if method == HARDWARE_PROFILE_METHOD:
        return start_hardware_profile_worker_if_allowed(
            message=message,
            transport=transport,
            worker_threads=hardware_worker_threads,
            request_runner=request_runner,
            outcome_sender=outcome_sender,
            logger=logger,
            shutdown_gate=shutdown_gate,
        )
    if method == CHAT_COMPACT_METHOD:
        # JCA-004 active-session guard: never summarize a session whose live turn
        # is still mutating history — the summary would be computed from a
        # snapshot the turn is about to invalidate. Structured result (not a
        # JSON-RPC error) preserves the chat.compact never-throws contract.
        if multiplexer is not None and multiplexer.has_active_session_turn(
            session_id_from_params(message.get("params"))
        ):
            if message.get("id") is not None:
                multiplexer.send_control(
                    result_response(
                        message.get("id"),
                        {"status": "error", "reason": "session_busy"},
                    )
                )
            return False
        return start_compact_worker_if_allowed(
            message=message,
            transport=transport,
            worker_threads=compact_worker_threads,
            request_runner=request_runner,
            outcome_sender=outcome_sender,
            logger=logger,
            shutdown_gate=shutdown_gate,
        )
    family = AUXILIARY_FAMILY_BY_METHOD.get(method)
    if family is None or family_worker_threads is None:
        if family is not None:
            # Fail closed on a wiring bug. A throwaway set would silently
            # disable the family cap and hide the thread from the shutdown
            # join, so refuse rather than start an untracked worker.
            logger.error(
                "Refusing %s because the family worker registry was not wired",
                method,
                extra={
                    "event": "sidecar.runtime.family_worker_registry_missing",
                    "method": method,
                    "family": family,
                },
            )
        return False
    return start_auxiliary_worker_if_allowed(
        method_label=method,
        limit_event=f"sidecar.runtime.{family}_worker_limit_exceeded",
        limit_reason=f"too_many_{family}_requests",
        message=message,
        transport=transport,
        worker_threads=family_worker_threads.setdefault(family, set()),
        request_runner=request_runner,
        outcome_sender=outcome_sender,
        logger=logger,
        # .get, not [], so a family added without a cap degrades to serial instead
        # of raising KeyError on the dispatch loop, which exits the sidecar.
        max_active_workers=DEFAULT_MAX_WORKERS_BY_FAMILY.get(family, 1),
        shutdown_gate=shutdown_gate,
    )


def start_compact_worker_if_allowed(  # noqa: PLR0913
    *,
    message: dict[str, Any],
    transport: AuxiliaryTransport,
    worker_threads: set[Any],
    request_runner: RequestRunner,
    outcome_sender: OutcomeSender,
    logger: logging.Logger,
    max_active_workers: int = DEFAULT_MAX_ACTIVE_COMPACT_WORKERS,
    shutdown_gate: AuxiliaryWorkerGate | None = None,
) -> bool:
    """JCA-004: chat.compact runs a blocking model inference — off the loop."""
    return start_auxiliary_worker_if_allowed(
        method_label="chat.compact",
        limit_event="sidecar.runtime.chat_compact_worker_limit_exceeded",
        limit_reason="too_many_chat_compact_requests",
        message=message,
        transport=transport,
        worker_threads=worker_threads,
        request_runner=request_runner,
        outcome_sender=outcome_sender,
        logger=logger,
        max_active_workers=max_active_workers,
        shutdown_gate=shutdown_gate,
    )


def join_auxiliary_workers(
    *,
    worker_threads: set[Any],
    timeout_seconds: float,
    logger: logging.Logger,
    shutdown_gate: AuxiliaryWorkerGate | None = None,
) -> None:
    inflight_deliveries = 0
    if shutdown_gate is not None:
        inflight_deliveries = shutdown_gate.close()
    live_threads = [thread for thread in worker_threads if thread.is_alive()]
    deadline = time.monotonic() + max(float(timeout_seconds), 0.0)
    for thread in live_threads:
        thread.join(timeout=max(deadline - time.monotonic(), 0.0))
    abandoned = [thread for thread in live_threads if thread.is_alive()]
    if abandoned:
        logger.warning(
            "sidecar shutdown abandoned active auxiliary workers after grace period",
            extra={
                "event": "sidecar.shutdown.auxiliary_workers_abandoned",
                "abandoned_count": len(abandoned),
                "grace_seconds": timeout_seconds,
                "late_outcomes_suppressed": shutdown_gate is not None,
                "inflight_deliveries": inflight_deliveries,
            },
        )
