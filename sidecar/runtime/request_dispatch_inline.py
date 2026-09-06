"""Inline-completion method dispatch helper extracted from request_dispatch.py.

Handles the ``inline.complete`` JSON-RPC method: a one-shot, off-transcript
fill-in-the-middle completion for the editor cursor position. The edited file
content stays on the machine and never enters the chat transcript.
"""

from __future__ import annotations

import logging
import sys
from typing import Any

from sidecar.ai.container import BrainContainer
from sidecar.ai.error_codes import CMP_PROTO_VERSION_MISMATCH
from sidecar.protocol import (
    INLINE_COMPLETE_METHOD,
    INLINE_LOADED_MODELS_METHOD,
    INLINE_UNLOAD_METHOD,
)
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.inline_completion import (
    generate_inline_completion,
    list_loaded_inline_models,
    unload_inline_model,
)
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.rpc import error_response, result_response, validate_accept_version

INLINE_METHODS = frozenset(
    {INLINE_COMPLETE_METHOD, INLINE_LOADED_MODELS_METHOD, INLINE_UNLOAD_METHOD}
)

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


def process_inline_method(  # noqa: PLR0913 -- uniform request-dispatch hook contract
    method: str,
    message_id: Any,
    params: Any,
    initialized: bool,
    brain_container: BrainContainer,
    logger: logging.Logger,
) -> ProcessOutcome | None:
    """Dispatch the inline.* JSON-RPC methods (complete / loaded_models / unload).

    Returns None if method is not an inline-completion method.
    """
    if method not in INLINE_METHODS:
        return None
    version_error = (
        None
        if message_id is None
        else validate_accept_version(
            method=method,
            message_id=message_id,
            params=params,
            invalid_params_code=INVALID_PARAMS_CODE,
            version_mismatch_code=PROTOCOL_VERSION_MISMATCH,
        )
    )
    if message_id is None or version_error is not None:
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
            component="runtime.request_dispatch_inline",
            event="inline_completion.not_initialized",
            message="Inline completion requested before sidecar initialization",
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

    if method == INLINE_LOADED_MODELS_METHOD:
        loaded = list_loaded_inline_models(logger)
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response=result_response(message_id, {"loaded": loaded}),
            notifications=[],
        )

    if method == INLINE_UNLOAD_METHOD:
        ok = unload_inline_model(str(safe_params.get("model", "")), logger)
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response=result_response(message_id, {"ok": ok}),
            notifications=[],
        )

    completion = generate_inline_completion(
        brain_container,
        prefix=str(safe_params.get("prefix", "")),
        suffix=str(safe_params.get("suffix", "")),
        model=str(safe_params.get("model", "")),
        # The legacy use_gpu request input is intentionally ignored. Leaving
        # Ollama's num_gpu unset delegates placement to its live capability/
        # resource policy rather than claiming a user-selected CPU/GPU target.
        max_tokens=safe_params.get("max_tokens", 96),
        logger=logger,
    )

    return ProcessOutcome(
        initialized=initialized,
        shutdown_requested=False,
        response=result_response(
            message_id,
            {
                "completion": completion,
                "compute_target": "automatic",
                "compute_reason": "ollama_runtime_resource_policy",
            },
        ),
        notifications=[],
    )
