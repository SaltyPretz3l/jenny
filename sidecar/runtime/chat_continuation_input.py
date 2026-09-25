"""Strict decoder for the private chat continuation resume carrier."""

from __future__ import annotations

import base64
import binascii
from typing import TYPE_CHECKING, Any

from sidecar.runtime.chat_models import continuation_identity_from_params
from sidecar.runtime.continuation_codec import MAX_CONTINUATION_BODY_BYTES
from sidecar.runtime.continuation_context import ContinuationContext
from sidecar.runtime.execution_context import ExecutionContext, execution_context_from_params

if TYPE_CHECKING:
    from sidecar.runtime.chat_continuation_resume import HydratedBeforeToolDispatchResume

_FIELD = "runtime_continuation_resume"
_MIN_BYTES = 2
_KEYS = frozenset(
    {
        "checkpoint_body",
        "checkpoint_sha256",
        "checkpoint_ref",
        "resolved_source_attempt",
        "tool_batch_bytes",
        "tool_batch_sha256",
        "frozen_input_bytes",
        "frozen_input_sha256",
    }
)


def _bytes(value: Any, name: str) -> bytes:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{_FIELD}.{name} must be canonical base64")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError(f"{_FIELD}.{name} must be canonical base64") from error
    if (
        base64.b64encode(decoded).decode("ascii") != value
        or not _MIN_BYTES <= len(decoded) <= MAX_CONTINUATION_BODY_BYTES
    ):
        raise ValueError(f"{_FIELD}.{name} must be bounded canonical base64")
    return decoded


def runtime_continuation_resume_from_params(  # noqa: PLR0913
    params: dict[str, Any],
    *,
    request_id: str,
    session_id: str | None,
    logical_turn_id: str,
    continuation_context: ContinuationContext | None,
    execution_context: ExecutionContext | None,
) -> HydratedBeforeToolDispatchResume | None:
    """Decode an optional app-owned resume carrier before router inference."""

    if _FIELD not in params:
        return None
    # Resume execution is request-only; eager loading expands the server startup graph.
    from sidecar.runtime.chat_continuation_resume import (  # noqa: PLC0415
        HydratedBeforeToolDispatchResume,
    )

    value = params.get(_FIELD)
    if not isinstance(value, dict) or set(value) not in (
        _KEYS, _KEYS | {"canonical_events_bytes"},
        _KEYS | {"canonical_events_bytes", "approval_inputs_bytes"},
    ):
        raise ValueError(f"{_FIELD} must be an exact continuation artifact object")
    if (
        continuation_context is None
        or execution_context is None
        or continuation_context.source_attempt.stream_id != request_id
        or continuation_context.turn_id != logical_turn_id
        or continuation_context.enclosing_session_id != str(session_id or "")
    ):
        raise ValueError(f"{_FIELD} requires matching continuation identity")
    try:
        hydrated = HydratedBeforeToolDispatchResume.from_artifacts(
            checkpoint_body=_bytes(value["checkpoint_body"], "checkpoint_body"),
            checkpoint_sha256=value["checkpoint_sha256"],
            checkpoint_ref=value["checkpoint_ref"],
            resolved_source_attempt=value["resolved_source_attempt"],
            tool_batch_bytes=_bytes(value["tool_batch_bytes"], "tool_batch_bytes"),
            tool_batch_sha256=value["tool_batch_sha256"],
            frozen_input_bytes=_bytes(value["frozen_input_bytes"], "frozen_input_bytes"),
            frozen_input_sha256=value["frozen_input_sha256"],
            canonical_events_bytes=(
                _bytes(value["canonical_events_bytes"], "canonical_events_bytes")
                if "canonical_events_bytes" in value
                else None
            ),
            approval_inputs_bytes=(_bytes(value["approval_inputs_bytes"], "approval_inputs_bytes")
                                   if "approval_inputs_bytes" in value else None),
            allow_dependency=params.get("runtime_children_enabled") is True,
        )
    except (TypeError, ValueError) as error:
        raise ValueError(f"{_FIELD} is invalid: {error}") from error
    checkpoint = hydrated.checkpoint()
    if (
        checkpoint["identity"]["work_id"] != continuation_context.work_id
        or checkpoint["identity"]["turn_id"] != logical_turn_id
        or checkpoint["identity"]["session_id"] != session_id
        or checkpoint["authority"] != continuation_context.authority.to_wire()
        or checkpoint["route"] != continuation_context.route.to_wire()
    ):
        raise ValueError(f"{_FIELD} does not match the admitted request")
    return hydrated


__all__ = ["runtime_continuation_resume_from_params"]


def continuation_request_state_from_params(
    params: dict[str, Any],
    *,
    request_id: str,
    session_id: str | None,
) -> tuple[
    ExecutionContext | None,
    str,
    ContinuationContext | None,
    HydratedBeforeToolDispatchResume | None,
]:
    """Parse the related request identities once at the chat boundary."""

    execution = execution_context_from_params(params)
    logical_turn, continuation = continuation_identity_from_params(
        params,
        request_id=request_id,
        session_id=session_id,
        execution_context=execution,
    )
    hydrated = runtime_continuation_resume_from_params(
        params,
        request_id=request_id,
        session_id=session_id,
        logical_turn_id=logical_turn,
        continuation_context=continuation,
        execution_context=execution,
    )
    return execution, logical_turn, continuation, hydrated


__all__.append("continuation_request_state_from_params")
