"""Chat-name method dispatch helper extracted from request_dispatch.py.

Handles the ``session.generate_title`` JSON-RPC method: a one-shot,
off-transcript generation of a short chat name from the first user message and
the first assistant reply. Neither enters the chat transcript.
"""

from __future__ import annotations

import logging
import sys
from typing import Any, Callable

from sidecar.ai.container import BrainContainer
from sidecar.ai.error_codes import CMP_PROTO_VERSION_MISMATCH
from sidecar.protocol import SESSION_GENERATE_TITLE_METHOD
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.inference_admission import (
    build_auxiliary_inference_admission_callback,
    inference_context_from_params,
)
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.rpc import error_response, result_response, validate_accept_version
from sidecar.runtime.session_title import generate_session_title

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


def process_session_title_method(  # noqa: PLR0913 -- uniform request-dispatch hook contract
    method: str,
    message_id: Any,
    params: Any,
    initialized: bool,
    brain_container: BrainContainer,
    logger: logging.Logger,
    *,
    write_message: Callable[[dict[str, Any]], None] | None = None,
    response_reader_factory: Callable[..., Callable[[float], dict[str, Any]]] | None = None,
) -> ProcessOutcome | None:
    """Dispatch the session.generate_title JSON-RPC method.

    Returns None if method is not the chat-name method.
    """
    if method != SESSION_GENERATE_TITLE_METHOD:
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

    safe_params = params if isinstance(params, dict) else {}
    try:
        inference_context = inference_context_from_params(safe_params)
    except ValueError as error:
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response=error_response(
                message_id,
                code=INVALID_PARAMS_CODE,
                message="invalid inference_context",
                data={"detail": str(error)},
            ),
            notifications=[],
        )
    if not initialized:
        _emit_log_event(
            logger,
            logging.WARNING,
            component="runtime.request_dispatch_session_title",
            event="session_title.not_initialized",
            message="Chat name requested before sidecar initialization",
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

    user_message = safe_params.get("user_message")
    assistant_message = safe_params.get("assistant_message")
    title = generate_session_title(
        brain_container,
        user_message if isinstance(user_message, str) else "",
        assistant_message if isinstance(assistant_message, str) else "",
        logger,
        request_id=inference_context.request_id if inference_context is not None else None,
        inference_admission=build_auxiliary_inference_admission_callback(
            context=inference_context,
            write_message=write_message,
            response_reader_factory=response_reader_factory,
        ),
    )

    return ProcessOutcome(
        initialized=initialized,
        shutdown_requested=False,
        response=result_response(message_id, {"title": title}),
        notifications=[],
    )
