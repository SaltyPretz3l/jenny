"""Suggestions method dispatch helpers extracted from request_dispatch.py.

Handles the ``suggestions.generate`` JSON-RPC method for producing
contextual prompt chips on the empty-chat splash page.
"""

from __future__ import annotations

import logging
import sys
from typing import Any, Callable

from sidecar.ai.container import BrainContainer
from sidecar.ai.error_codes import CMP_PROTO_VERSION_MISMATCH
from sidecar.protocol import SUGGESTIONS_GENERATE_METHOD
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.inference_admission import (
    build_auxiliary_inference_admission_callback,
    inference_context_from_params,
)
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.rpc import error_response, result_response, validate_accept_version
from sidecar.runtime.suggestions import generate_suggestions

INVALID_PARAMS_CODE = -32602
NOT_INITIALIZED_CODE = -32002
PROTOCOL_VERSION_MISMATCH = CMP_PROTO_VERSION_MISMATCH


def _emit_log_event(logger: logging.Logger, level: int, **kwargs: Any) -> None:
    request_dispatch_module = sys.modules.get("sidecar.runtime.request_dispatch")
    log_event_fn = getattr(request_dispatch_module, "log_event", log_event)
    log_event_fn(logger, level, **kwargs)


def process_suggestions_method(  # noqa: PLR0917 -- uniform request-dispatch hook contract
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
    """Dispatch suggestions.generate JSON-RPC method.

    Returns None if method is not a suggestions method.
    """
    if method != SUGGESTIONS_GENERATE_METHOD:
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
            component="runtime.request_dispatch_suggestions",
            event="suggestions.not_initialized",
            message="Suggestions requested before sidecar initialization",
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

    context = {
        "time_of_day": str(safe_params.get("time_of_day", "")),
        "companion_mode": str(safe_params.get("companion_mode", "")),
        "framing_hint": str(safe_params.get("framing_hint", "")),
        "briefing_summary": str(safe_params.get("briefing_summary", "")),
        "recent_memory_titles": safe_params.get("recent_memory_titles", []),
        "recent_session_titles": safe_params.get("recent_session_titles", []),
        "personality_name": str(safe_params.get("personality_name", "")),
    }

    suggestions = generate_suggestions(
        brain_container,
        context,
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
        response=result_response(message_id, {"suggestions": suggestions}),
        notifications=[],
    )
