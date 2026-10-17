"""``command.execute_proposal``: the exact-command Run adapter (row 59 checkpoint 3).

One chat-shaped turn that runs ONE already-proposed ``run_command`` call with no
model. The call goes through the same owners a model-issued ``run_command`` uses
(prevalidation, tool policy, command classifier, one-off approval, runtime
operation admission, resource lease, the builtin or Electron/Docker executor) and
emits the same ``tool.*`` / ``turn.event`` notifications, then a terminal
``chat.done`` / ``chat.error``. It is a registered turn, so the existing
``chat.cancel {request_id}`` cancels it; there is no new cancel method.

The Run click is never an approval (DB1) and no client boolean skips policy. The
digest, binding and capability are verified before any effect (see
``command_proposal_request``). This module is the worker entry: refusals, hosted
denial and the stack lease; ``command_proposal_run`` owns the pipeline.
"""

from __future__ import annotations

import logging
from contextlib import nullcontext
from typing import Any, Callable

from sidecar.ai.container import BrainContainer
from sidecar.ai.error_codes import CMP_PROTO_VERSION_MISMATCH
from sidecar.ai.host_policy import container_host_policy_is_enforced
from sidecar.ai.routing.request_safety import with_request_safety
from sidecar.protocol import COMMAND_EXECUTE_PROPOSAL_METHOD
from sidecar.runtime.chat_helpers import (
    chat_error_notification,
    request_id_from_params,
    session_id_from_params,
    trace_id_from_params,
)
from sidecar.runtime.chat_models import ChatRequestError
from sidecar.runtime.command_proposal_outcome import STATUS_CANCELLED, CommandOutcome
from sidecar.runtime.command_proposal_request import (
    CommandProposalRefusal,
    CommandProposalRequest,
    parse_command_proposal_params,
    refusal_error,
)
from sidecar.runtime.diagnostics import diagnostics_context
from sidecar.runtime.outcomes import ProcessOutcome, chat_error_outcome
from sidecar.runtime.request_dispatch_chat import TOOL_APPROVAL_TIMEOUT_SECONDS
from sidecar.runtime.rpc import error_response, result_response, validate_accept_version
from sidecar.runtime.turn_state import TURN_STATE_CANCELLED, build_turn_result

INVALID_PARAMS_CODE = -32602
METHOD_NOT_FOUND_CODE = -32601


def _error_outcome(message_id: Any, error: ChatRequestError) -> ProcessOutcome:
    return chat_error_outcome(
        initialized=True,
        message_id=message_id,
        error=error,
        error_response=error_response,
        chat_error_notification=chat_error_notification,
    )


def _hosted_rejection(message_id: Any) -> ProcessOutcome:
    response = (
        None
        if message_id is None
        else error_response(
            message_id,
            code=METHOD_NOT_FOUND_CODE,
            message="method unavailable in hosted runtime",
            data={"reason": "host_method_not_allowed", "host_mode": "server"},
        )
    )
    return ProcessOutcome(True, False, response, [])


def _cancelled_before_start(
    message_id: Any,
    request: CommandProposalRequest,
    handle: Any,
) -> ProcessOutcome:
    result: dict[str, Any] = dict(
        build_turn_result(
            request_id=request.request_id,
            status=TURN_STATE_CANCELLED,
            terminal_subcode=getattr(handle, "reason", None),
        )
    )
    result["command_outcome"] = CommandOutcome(STATUS_CANCELLED, None, None).to_wire()
    return ProcessOutcome(True, False, result_response(message_id, result), [])


@with_request_safety
def _run_under_boundary(
    *,
    params: Any,
    request: CommandProposalRequest,
    message_id: Any,
    brain_container: BrainContainer,
    **run_kwargs: Any,
) -> ProcessOutcome:
    """Bind the request safety fields, then run inside the request boundary."""
    del params  # consumed by with_request_safety
    from sidecar.runtime.command_proposal_run import run_exact_command

    with (
        diagnostics_context(
            trace_id=request.trace_id,
            request_id=request.request_id,
            session_id=request.session_id,
        ),
        brain_container.request_boundary(
            COMMAND_EXECUTE_PROPOSAL_METHOD,
            request_id=request.request_id,
            session_id=request.session_id,
        ),
    ):
        try:
            return run_exact_command(
                request=request,
                message_id=message_id,
                brain_container=brain_container,
                **run_kwargs,
            )
        except ChatRequestError as error:
            return _error_outcome(message_id, error)


def process_command_execute_proposal(  # noqa: PLR0913
    message: dict[str, Any],
    *,
    brain_container: BrainContainer,
    logger: logging.Logger,
    write_frame: Callable[[dict[str, Any]], None],
    approval_response_waiter_factory: Callable[..., Callable[[float], dict[str, Any]]]
    | None = None,
    cancel_handle: Any | None = None,
    approval_timeout_seconds: float = TOOL_APPROVAL_TIMEOUT_SECONDS,
) -> ProcessOutcome:
    """Worker entry: refuse before any effect, else run the one exact call."""
    message_id = message.get("id")
    params = message.get("params")
    request_id = request_id_from_params(params, message_id)
    trace_id = trace_id_from_params(params, message_id)
    session_id = session_id_from_params(params)
    if container_host_policy_is_enforced(brain_container):
        return _hosted_rejection(message_id)
    if message_id is None:
        return ProcessOutcome(True, False, None, [])
    if (
        validate_accept_version(
            method=COMMAND_EXECUTE_PROPOSAL_METHOD,
            message_id=message_id,
            params=params,
            invalid_params_code=INVALID_PARAMS_CODE,
            version_mismatch_code=CMP_PROTO_VERSION_MISMATCH,
        )
        is not None
    ):
        return _error_outcome(
            message_id,
            refusal_error(
                request_id,
                trace_id,
                session_id,
                "accept_version_mismatch",
                code=CMP_PROTO_VERSION_MISMATCH,
            ),
        )
    try:
        request = parse_command_proposal_params(params)
    except CommandProposalRefusal as error:
        return _error_outcome(
            message_id, refusal_error(request_id, trace_id, session_id, error.reason)
        )
    if cancel_handle is not None and cancel_handle.cancelled:
        return _cancelled_before_start(message_id, request, cancel_handle)
    lease = getattr(brain_container, "stack_lease", None)
    with lease() if callable(lease) else nullcontext():
        return _run_under_boundary(
            params=params,
            request=request,
            message_id=message_id,
            brain_container=brain_container,
            logger=logger,
            write_frame=write_frame,
            waiter_factory=approval_response_waiter_factory,
            cancel_handle=cancel_handle,
            approval_timeout_seconds=approval_timeout_seconds,
        )


__all__ = ["process_command_execute_proposal"]
