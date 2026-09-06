"""Internal background task JSON-RPC dispatch helpers."""

from __future__ import annotations

import logging
from typing import Any

from sidecar.ai.container import BrainContainer
from sidecar.ai.error_codes import (
    CMP_BACKGROUND_INVALID_PARAMS,
    CMP_PROTO_VERSION_MISMATCH,
)
from sidecar.protocol import BACKGROUND_RUN_METHOD
from sidecar.runtime.background_tasks import run_background_task
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.rpc import error_response, result_response, validate_accept_version

INVALID_PARAMS_CODE = -32602
PROTOCOL_VERSION_MISMATCH = CMP_PROTO_VERSION_MISMATCH


def background_error_payload(message: str) -> dict[str, str]:
    return {
        "code": CMP_BACKGROUND_INVALID_PARAMS,
        "detail": message,
    }


def _outcome(
    *,
    initialized: bool,
    response: dict[str, Any] | None,
) -> ProcessOutcome:
    return ProcessOutcome(
        initialized=initialized,
        shutdown_requested=False,
        response=response,
        notifications=[],
    )


def process_background_method(  # noqa: PLR0913 - dispatcher signature mirrors sibling handlers.
    method: str,
    message_id: Any,
    params: Any,
    initialized: bool,
    brain_container: BrainContainer,
    logger: logging.Logger,
) -> ProcessOutcome | None:
    """Dispatch internal background.* JSON-RPC methods."""

    if method != BACKGROUND_RUN_METHOD:
        return None
    if message_id is None:
        return _outcome(
            initialized=initialized,
            response=None,
        )
    version_error = validate_accept_version(
        method=method,
        message_id=message_id,
        params=params,
        invalid_params_code=INVALID_PARAMS_CODE,
        version_mismatch_code=PROTOCOL_VERSION_MISMATCH,
    )
    if version_error is not None:
        return _outcome(
            initialized=initialized,
            response=version_error,
        )
    task = str((params.get("task") if isinstance(params, dict) else "") or "").strip().lower()
    if not task:
        return _outcome(
            initialized=initialized,
            response=error_response(
                message_id,
                code=INVALID_PARAMS_CODE,
                message="background.run invalid params",
                data=background_error_payload("task is required"),
            ),
        )
    result = run_background_task(
        task=task,
        params=params if isinstance(params, dict) else {},
        config=brain_container.stack.config,
        raw_config=brain_container.stack.raw_config,
        subprocess_manager=brain_container.subprocess_manager,
        secrets=brain_container.stack.secrets,
    )
    logger.debug("background.run result: %s", result)
    return _outcome(
        initialized=initialized,
        response=result_response(message_id, result),
    )
