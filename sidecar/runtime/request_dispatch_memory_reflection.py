"""memory.reflect dispatch (row 58 W2), shaped like suggestions.generate.

It runs on the auxiliary ``inference`` worker family (cap 1), so chat.cancel
reaches it by ``request_id`` and a cancel answers -32000
``auxiliary_cancelled`` from the worker. Admission refusals and cancels
propagate to that worker; params errors are -32602, an unavailable store or
a failed engine call is -32000 with a coded payload. Writes nothing.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from sidecar.ai.container import BrainContainer
from sidecar.ai.error_codes import CMP_MEMORY_FAILED, CMP_PROTO_VERSION_MISMATCH
from sidecar.exceptions import MemoryStoreError
from sidecar.protocol import MEMORY_REFLECT_METHOD
from sidecar.runtime.inference_admission import (
    build_auxiliary_inference_admission_callback,
    inference_context_from_params,
)
from sidecar.runtime.memory import memory_error_payload
from sidecar.runtime.memory_reflection import (
    ReflectionInferenceError,
    ReflectRequest,
    parse_reflect_request,
    reflect_memories,
)
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.request_dispatch_memory import _require_memory_service, emit_log_event
from sidecar.runtime.rpc import error_response, result_response, validate_accept_version

INVALID_PARAMS_CODE = -32602
INTERNAL_ERROR_CODE = -32000
NOT_INITIALIZED_CODE = -32002


def _prepare(
    method: str, message_id: Any, params: Any, initialized: bool, brain: BrainContainer
) -> tuple[dict[str, Any] | None, Any, ReflectRequest | None]:
    """(error response, inference context, request): exactly one side is set."""

    version_error = validate_accept_version(
        method=method,
        message_id=message_id,
        params=params,
        invalid_params_code=INVALID_PARAMS_CODE,
        version_mismatch_code=CMP_PROTO_VERSION_MISMATCH,
    )
    if version_error is not None:
        return version_error, None, None
    try:
        inference_context = inference_context_from_params(params)
        request = parse_reflect_request(params)
    except ValueError as error:
        return error_response(
            message_id,
            code=INVALID_PARAMS_CODE,
            message=f"{method} invalid params",
            data=memory_error_payload(error),
        ), None, None
    if not initialized or brain.stack is None:
        return error_response(
            message_id,
            code=NOT_INITIALIZED_CODE,
            message="Sidecar not initialized — engine unavailable.",
        ), None, None
    return None, inference_context, request


def _reflect_response(  # noqa: PLR0913 - the dispatch ports, passed through
    method: str,
    message_id: Any,
    brain: BrainContainer,
    logger: logging.Logger,
    request: ReflectRequest,
    admission: Any,
) -> dict[str, Any]:
    try:
        payload = reflect_memories(
            stack=brain.stack,
            backend=_require_memory_service(brain.stack),
            request=request,
            logger=logger,
            inference_admission=admission,
        )
    except MemoryStoreError as error:
        return error_response(
            message_id,
            code=INTERNAL_ERROR_CODE,
            message=f"{method} failed",
            data=memory_error_payload(error),
        )
    except ReflectionInferenceError as error:
        emit_log_event(
            logger,
            logging.WARNING,
            component="runtime.memory_reflection",
            event="memory.reflect.inference_failed",
            message="Reflection inference failed.",
            status="failed",
            data={"error_type": str(error), "reason": error.reason},
        )
        return error_response(
            message_id,
            code=INTERNAL_ERROR_CODE,
            message=f"{method} failed",
            data={"code": CMP_MEMORY_FAILED, "reason": error.reason},
        )
    return result_response(message_id, payload)


def process_memory_reflect_method(  # noqa: PLR0913 - uniform request-dispatch hook contract
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
    """Dispatch memory.reflect; None for any other method."""

    if method != MEMORY_REFLECT_METHOD:
        return None
    response: dict[str, Any] | None = None
    if message_id is not None:
        response, inference_context, request = _prepare(
            method, message_id, params, initialized, brain_container
        )
        if request is not None:
            response = _reflect_response(
                method,
                message_id,
                brain_container,
                logger,
                request,
                build_auxiliary_inference_admission_callback(
                    context=inference_context,
                    write_message=write_message,
                    response_reader_factory=response_reader_factory,
                ),
            )
    return ProcessOutcome(
        initialized=initialized, shutdown_requested=False, response=response, notifications=[]
    )
