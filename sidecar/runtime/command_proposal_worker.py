"""Worker start hook for ``command.execute_proposal`` (kept out of ``sidecar/server.py``).

The method runs as a registered, cancellable multiplexer turn, exactly like
``chat.send``: ``chat.cancel {request_id}`` cancels it and the per-session turn
serialization applies. Only the runner differs.
"""

from __future__ import annotations

import logging
from typing import Any

from sidecar.ai.container import BrainContainer
from sidecar.protocol import COMMAND_EXECUTE_PROPOSAL_METHOD
from sidecar.runtime import server_chat_workers
from sidecar.runtime.multiplexer import StdioTransportMultiplexer


def is_proposal(method: Any) -> bool:
    return method == COMMAND_EXECUTE_PROPOSAL_METHOD


def start_worker(  # noqa: PLR0913
    message: dict[str, Any],
    transport: StdioTransportMultiplexer,
    worker_threads: set[Any],
    active_cancel_handles: dict[Any, Any],
    brain_container: BrainContainer,
    logger: logging.Logger,
    max_active_workers: int,
) -> bool:
    """Start the proposal worker if the turn registry admits it."""
    from sidecar.runtime.command_proposal import process_command_execute_proposal

    def _runner(frame: dict[str, Any], **options: Any) -> Any:
        return process_command_execute_proposal(
            frame, brain_container=brain_container, logger=logger, **options
        )

    return server_chat_workers.start_chat_send_worker_if_allowed(
        message=message,
        transport=transport,
        worker_threads=worker_threads,
        active_cancel_handles=active_cancel_handles,
        chat_send_runner=_runner,
        logger=logger,
        max_active_workers=max_active_workers,
    )


__all__ = ["is_proposal", "start_worker"]
