"""Deadline-driven cleanup for the sidecar stdio server."""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from time import perf_counter
from typing import Any, Callable

from sidecar.runtime.diagnostics import log_event

SHUTDOWN_GRACE_SECONDS = 4.5
SHUTDOWN_WORKER_GRACE_SECONDS = 2.5


@dataclass(frozen=True)
class ShutdownContext:
    logger: logging.Logger
    parent_watchdog: Any
    worker_threads: set[Any]
    active_cancel_handles: dict[Any, Any]
    auxiliary_worker_threads: set[Any]
    auxiliary_shutdown_gate: Any
    multiplexer: Any
    brain_container: Any
    subprocess_manager: Any
    cancel_and_join_chat_workers: Callable[..., None]
    join_auxiliary_workers: Callable[..., None]
    shutdown_logging: Callable[..., Any]


def remaining_seconds(deadline: float) -> float:
    return max(deadline - perf_counter(), 0.0)


def log_shutdown_stage(
    logger: logging.Logger,
    stage: str,
    status: str,
    timing: tuple[float, float],
    data: dict[str, Any] | None = None,
) -> None:
    started_at, deadline = timing
    log_event(
        logger,
        logging.INFO if status == "ok" else logging.WARNING,
        component="runtime.shutdown",
        event="sidecar.runtime.shutdown_stage",
        message="sidecar shutdown stage completed",
        status=status,
        duration_ms=max((perf_counter() - started_at) * 1000.0, 0.0),
        data={
            "stage": stage,
            "remaining_budget_ms": remaining_seconds(deadline) * 1000.0,
            "forced": False,
            "confirmed": status == "ok",
            **(data or {}),
        },
    )


def _close_container_bounded(context: ShutdownContext, deadline: float) -> bool:
    completed = threading.Event()
    failed = threading.Event()

    def close_container() -> None:
        try:
            context.brain_container.close()
        except Exception:  # noqa: BLE001
            failed.set()
            context.logger.exception("sidecar container close failed")
        finally:
            completed.set()

    threading.Thread(
        target=close_container,
        name="sidecar-container-close",
        daemon=True,
    ).start()
    completed.wait(timeout=remaining_seconds(deadline))
    return completed.is_set() and not failed.is_set()


def shutdown_server_runtime(context: ShutdownContext) -> None:  # noqa: PLR0915
    """Drain every shutdown stage under one monotonic process deadline."""

    shutdown_started_at = perf_counter()
    shutdown_deadline = shutdown_started_at + SHUTDOWN_GRACE_SECONDS
    shutdown_confirmed = True
    if context.parent_watchdog is not None:
        try:
            context.parent_watchdog.stop()
        except Exception:  # noqa: BLE001
            shutdown_confirmed = False
            context.logger.exception("parent watchdog stop failed during sidecar shutdown")

    worker_deadline = min(
        shutdown_deadline,
        shutdown_started_at + SHUTDOWN_WORKER_GRACE_SECONDS,
    )
    chat_started_at = perf_counter()
    chat_count = sum(thread.is_alive() for thread in context.worker_threads)
    chat_failed = False
    try:
        context.cancel_and_join_chat_workers(
            worker_threads=context.worker_threads,
            active_cancel_handles=context.active_cancel_handles,
            shutdown_worker_grace_seconds=remaining_seconds(worker_deadline),
            logger=context.logger,
        )
    except Exception:  # noqa: BLE001
        chat_failed = True
        context.logger.exception("chat worker drain failed during sidecar shutdown")
    chat_remaining = sum(thread.is_alive() for thread in context.worker_threads)
    shutdown_confirmed = shutdown_confirmed and not chat_failed and chat_remaining == 0
    log_shutdown_stage(
        context.logger,
        "chat_worker_drain",
        "ok" if not chat_failed and chat_remaining == 0 else "timeout",
        (chat_started_at, shutdown_deadline),
        data={
            "worker_count": min(chat_count, 1000),
            "remaining_worker_count": min(chat_remaining, 1000),
        },
    )

    auxiliary_started_at = perf_counter()
    auxiliary_count = sum(
        thread.is_alive() for thread in context.auxiliary_worker_threads
    )
    auxiliary_failed = False
    try:
        context.join_auxiliary_workers(
            worker_threads=context.auxiliary_worker_threads,
            timeout_seconds=remaining_seconds(worker_deadline),
            logger=context.logger,
            shutdown_gate=context.auxiliary_shutdown_gate,
        )
    except Exception:  # noqa: BLE001
        auxiliary_failed = True
        context.logger.exception("auxiliary worker drain failed during sidecar shutdown")
    auxiliary_remaining = sum(
        thread.is_alive() for thread in context.auxiliary_worker_threads
    )
    shutdown_confirmed = (
        shutdown_confirmed and not auxiliary_failed and auxiliary_remaining == 0
    )
    log_shutdown_stage(
        context.logger,
        "auxiliary_worker_drain",
        "ok" if not auxiliary_failed and auxiliary_remaining == 0 else "timeout",
        (auxiliary_started_at, shutdown_deadline),
        data={
            "worker_count": min(auxiliary_count, 1000),
            "remaining_worker_count": min(auxiliary_remaining, 1000),
        },
    )

    transport_started_at = perf_counter()
    transport_result = None
    if context.multiplexer is not None:
        try:
            transport_result = context.multiplexer.close(
                timeout_seconds=remaining_seconds(shutdown_deadline)
            )
        except Exception:  # noqa: BLE001
            context.logger.exception("transport drain failed during sidecar shutdown")
        transport_drained = transport_result is not None and transport_result.drained
        shutdown_confirmed = shutdown_confirmed and transport_drained
        transport_data = (
            {
                "reader_worker_alive": transport_result.reader.worker_alive,
                "writer_worker_alive": transport_result.writer.worker_alive,
                "pending_frame_count": min(transport_result.writer.pending_frames, 100_000),
            }
            if transport_result is not None
            else {}
        )
    else:
        transport_drained = True
        transport_data = {"skipped": True}
    log_shutdown_stage(
        context.logger,
        "transport_drain",
        "ok" if transport_drained else "timeout",
        (transport_started_at, shutdown_deadline),
        data=transport_data,
    )

    container_started_at = perf_counter()
    container_closed = _close_container_bounded(context, shutdown_deadline)
    shutdown_confirmed = shutdown_confirmed and container_closed
    log_shutdown_stage(
        context.logger,
        "container_resources",
        "ok" if container_closed else "timeout",
        (container_started_at, shutdown_deadline),
    )

    subprocess_started_at = perf_counter()
    try:
        subprocess_result = context.subprocess_manager.close(
            timeout_seconds=remaining_seconds(shutdown_deadline),
        )
    except Exception:  # noqa: BLE001
        subprocess_result = None
        context.logger.exception("owned subprocess cleanup failed during sidecar shutdown")
    subprocess_drained = subprocess_result is not None and subprocess_result.drained
    shutdown_confirmed = shutdown_confirmed and subprocess_drained
    log_shutdown_stage(
        context.logger,
        "owned_subprocesses",
        "ok" if subprocess_drained else "timeout",
        (subprocess_started_at, shutdown_deadline),
        data=(
            {
                "child_count": min(subprocess_result.child_count, 1000),
                "reservation_count": min(subprocess_result.reservation_count, 1000),
                "unreaped_count": min(subprocess_result.unreaped_count, 1000),
                "manager_count": min(subprocess_result.manager_count, 1000),
            }
            if subprocess_result is not None
            else {}
        ),
    )

    try:
        context.shutdown_logging(
            timeout_seconds=min(2.0, remaining_seconds(shutdown_deadline)),
            shutdown_started_at=shutdown_started_at,
            shutdown_deadline=shutdown_deadline,
            shutdown_confirmed=shutdown_confirmed,
        )
    except Exception:  # noqa: BLE001
        context.logger.exception("diagnostics flush failed during sidecar shutdown")
