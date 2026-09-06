"""Commit-message method dispatch helper extracted from request_dispatch.py.

Handles the ``commit.generate_message`` JSON-RPC method: a one-shot,
off-transcript generation of a Conventional Commit message from a staged diff.
The diff stays on the machine and never enters the chat transcript.
"""

from __future__ import annotations

import logging
import sys
from typing import Any

from sidecar.ai.container import BrainContainer
from sidecar.ai.error_codes import CMP_PROTO_VERSION_MISMATCH
from sidecar.protocol import COMMIT_GENERATE_MESSAGE_METHOD
from sidecar.runtime.commit_message import (
    generate_commit_message,
    summarize_diff_truncation,
)
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.rpc import error_response, result_response, validate_accept_version

INVALID_PARAMS_CODE = -32602
NOT_INITIALIZED_CODE = -32002
PROTOCOL_VERSION_MISMATCH = CMP_PROTO_VERSION_MISMATCH


def _emit_log_event(logger: logging.Logger, level: int, **kwargs: Any) -> None:
    # Route through request_dispatch's ``log_event`` symbol when present so a test
    # that monkeypatches the parent module's logger also captures this helper's
    # events; fall back to the directly-imported ``log_event`` otherwise. Mirrors
    # the sibling request_dispatch_* dispatchers.
    request_dispatch_module = sys.modules.get("sidecar.runtime.request_dispatch")
    log_event_fn = getattr(request_dispatch_module, "log_event", log_event)
    log_event_fn(logger, level, **kwargs)


def process_commit_method(  # noqa: PLR0913 -- uniform request-dispatch hook contract
    method: str,
    message_id: Any,
    params: Any,
    initialized: bool,
    brain_container: BrainContainer,
    logger: logging.Logger,
) -> ProcessOutcome | None:
    """Dispatch the commit.generate_message JSON-RPC method.

    Returns None if method is not the commit-message method.
    """
    if method != COMMIT_GENERATE_MESSAGE_METHOD:
        return None
    if message_id is None:
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response=None,
            notifications=[],
        )

    version_error = validate_accept_version(
        method=method,
        message_id=message_id,
        params=params,
        invalid_params_code=INVALID_PARAMS_CODE,
        version_mismatch_code=PROTOCOL_VERSION_MISMATCH,
    )
    if version_error is not None:
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response=version_error,
            notifications=[],
        )

    if not initialized:
        _emit_log_event(
            logger,
            logging.WARNING,
            component="runtime.request_dispatch_commit",
            event="commit_message.not_initialized",
            message="Commit-message requested before sidecar initialization",
        )
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response=error_response(
                message_id,
                code=NOT_INITIALIZED_CODE,
                message="Sidecar not initialized — engine unavailable.",
            ),
            notifications=[],
        )

    safe_params = params if isinstance(params, dict) else {}
    diff = str(safe_params.get("diff", ""))
    message = generate_commit_message(brain_container, diff, logger)

    # Deterministically report (no extra model call) when the staged diff
    # overflowed the model's input cap so the renderer can warn the user the
    # message was written from a partial view. Computed on the stripped diff to
    # match exactly what generate_commit_message clipped before the model saw it.
    result_payload: dict[str, Any] = {"message": message}
    truncation = summarize_diff_truncation(diff.strip())
    if truncation["truncated"]:
        result_payload["truncated"] = True
        result_payload["omitted_files"] = truncation["omitted_files"]
        result_payload["total_files"] = truncation["total_files"]

    return ProcessOutcome(
        initialized=initialized,
        shutdown_requested=False,
        response=result_response(message_id, result_payload),
        notifications=[],
    )
