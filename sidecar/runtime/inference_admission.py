"""Request-bound application admission for one provider inference attempt."""

from __future__ import annotations

import itertools
import json
import secrets
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Callable, Iterator, Mapping

from sidecar.ai.engines.admitted import (
    InferenceAdmissionDeferred,
    InferenceAdmissionRefused,
    InferenceAttemptContext,
    InferenceAttemptOutcome,
)
from sidecar.protocol import API_VERSION, JSONRPC_VERSION, RUNTIME_OPERATION_METHOD
from sidecar.runtime.execution_context import ExecutionContext
from sidecar.runtime.multiplexer import ApprovalResponseCancelledError

_RPC_IDS = itertools.count(40_000_000)
_MAX_TOKEN_CEILING = 1_000_000_000_000
_MAX_REQUEST_BYTES = 1024 * 1024
_MAX_REQUEST_TOKEN_CHARS = 128
_MAX_OPERATION_TOKEN_CHARS = 256
_MAX_ENGINE_TYPE_CHARS = 128
_MAX_CONTEXT_BYTES = 16 * 1024
_CONTROL_CODE_BOUNDARY = 32
_RESULT_FIELDS = frozenset({"schema_version", "operation_id", "status", "reason"})
_REQUIRED_RESULT_FIELDS = _RESULT_FIELDS - {"reason"}
_ADMIT_TIMEOUT_SECONDS = 30.0
_SETTLE_TIMEOUT_SECONDS = 5.0
_INFERENCE_CONTEXT_FIELDS = frozenset(
    {"schema_version", "request_id", "session_id", "authority_revision", "engine_type"}
)


@dataclass(frozen=True, slots=True)
class AuxiliaryInferenceContext:
    """Closed application-authored authority for one inference-only request."""

    schema_version: int
    request_id: str
    session_id: str | None
    authority_revision: str
    engine_type: str


def _token(value: Any, field: str, limit: int) -> str:
    token = value if isinstance(value, str) else ""
    if not token or token != token.strip() or len(token) > limit or any(
        ord(char) < _CONTROL_CODE_BOUNDARY for char in token
    ):
        raise InferenceAdmissionRefused(f"inference_{field}_invalid")
    return token


def _reason(value: Any, fallback: str) -> str:
    reason = value if isinstance(value, str) else ""
    return str(reason or fallback)[:200]


@contextmanager
def _closing(reader: Callable[[float], dict[str, Any]]) -> Iterator[None]:
    try:
        yield
    finally:
        close = getattr(reader, "close", None)
        if callable(close):
            close()


def _response_error_reason(response: Mapping[str, Any]) -> str | None:
    error = response.get("error")
    if not isinstance(error, Mapping):
        return None
    data = error.get("data")
    if isinstance(data, Mapping):
        return _reason(data.get("reason") or data.get("message"), "inference_rejected")
    return _reason(error.get("message"), "inference_rejected")


def _exchange(  # noqa: C901, PLR0912, PLR0913
    *,
    params: dict[str, Any],
    operation_id: str,
    expected_statuses: frozenset[str],
    write_message: Callable[[dict[str, Any]], None] | None,
    response_reader_factory: Callable[..., Callable[[float], dict[str, Any]]] | None,
    cancel_handle: Any,
    timeout_seconds: float,
) -> dict[str, Any]:
    if not callable(write_message) or not callable(response_reader_factory):
        raise InferenceAdmissionRefused("inference_authority_bridge_unavailable")
    rpc_id = next(_RPC_IDS)
    message = {
        "jsonrpc": JSONRPC_VERSION,
        "api_version": API_VERSION,
        "id": rpc_id,
        "method": RUNTIME_OPERATION_METHOD,
        "params": params,
    }
    try:
        encoded_size = len(json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode())
    except (TypeError, ValueError, OverflowError) as error:
        raise InferenceAdmissionRefused("inference_request_not_serializable") from error
    if encoded_size > _MAX_REQUEST_BYTES:
        raise InferenceAdmissionRefused("inference_request_too_large")

    try:
        reader = response_reader_factory(rpc_id, cancel_handle=cancel_handle)
    except Exception as error:
        raise InferenceAdmissionRefused("inference_response_bridge_unavailable") from error
    with _closing(reader):
        try:
            write_message(message)
        except Exception as error:
            raise InferenceAdmissionRefused("inference_request_write_failed") from error
        deadline = time.monotonic() + min(max(float(timeout_seconds), 0.1), 30.0)
        while True:
            if cancel_handle is not None and bool(getattr(cancel_handle, "cancelled", False)):
                raise InferenceAdmissionRefused("inference_admission_cancelled")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise InferenceAdmissionRefused("inference_authority_timeout")
            try:
                response = reader(remaining)
            except (TimeoutError, ApprovalResponseCancelledError) as error:
                raise InferenceAdmissionRefused("inference_authority_incomplete") from error
            except Exception as error:
                raise InferenceAdmissionRefused("inference_response_read_failed") from error
            if not isinstance(response, Mapping) or response.get("id") != rpc_id:
                continue
            response_error = _response_error_reason(response)
            if response_error is not None:
                raise InferenceAdmissionRefused(response_error)
            result = response.get("result")
            if (
                not isinstance(result, dict)
                or not _REQUIRED_RESULT_FIELDS.issubset(result)
                or set(result) - _RESULT_FIELDS
                or result.get("schema_version") != 1
                or result.get("operation_id") != operation_id
                or result.get("status") not in expected_statuses
                or ("reason" in result and not isinstance(result["reason"], str))
            ):
                raise InferenceAdmissionRefused("inference_authority_response_malformed")
            return result


class RuntimeInferenceLease:
    """Settle one granted inference operation over an uncancelled control read."""

    def __init__(
        self,
        *,
        base_params: dict[str, Any],
        operation_id: str,
        write_message: Callable[[dict[str, Any]], None] | None,
        response_reader_factory: Callable[..., Callable[[float], dict[str, Any]]] | None,
    ) -> None:
        self._base_params = dict(base_params)
        self._operation_id = operation_id
        self._write_message = write_message
        self._response_reader_factory = response_reader_factory
        self._lock = threading.Lock()
        self._settled = False

    def settle(self, outcome: InferenceAttemptOutcome) -> None:
        status = getattr(outcome, "status", None)
        cleanup = getattr(outcome, "cleanup", None)
        consumption = getattr(outcome, "consumption", None)
        charge_consumption = getattr(outcome, "charge_consumption", None)
        if (
            status not in {"succeeded", "failed", "cancelled"}
            or cleanup not in {"confirmed", "uncertain"}
            or consumption != "unknown"
            or charge_consumption is not True
        ):
            raise InferenceAdmissionRefused("inference_settlement_invalid")
        with self._lock:
            if self._settled:
                return
            self._settled = True
        try:
            result = _exchange(
                params={
                    **self._base_params,
                    "phase": "settle",
                    "status": status,
                    "cleanup": cleanup,
                    "consumption": "unknown",
                    "charge_consumption": True,
                },
                operation_id=self._operation_id,
                expected_statuses=frozenset({"settled", "rejected"}),
                write_message=self._write_message,
                response_reader_factory=self._response_reader_factory,
                # The provider is already closed before settlement. The original
                # request cancellation must not tear down this final control read.
                cancel_handle=None,
                timeout_seconds=_SETTLE_TIMEOUT_SECONDS,
            )
        except BaseException:
            # A failed exchange proved nothing: keep the lease settleable so
            # the owner can retry instead of silently dropping the settlement.
            with self._lock:
                self._settled = False
            raise
        if result["status"] == "rejected":
            raise InferenceAdmissionRefused(
                _reason(result.get("reason"), "inference_settlement_rejected")
            )


def _reservation_maxima(context: InferenceAttemptContext) -> dict[str, int]:
    input_tokens, output_tokens = context.input_token_ceiling, context.output_token_ceiling
    if (not isinstance(input_tokens, int) or isinstance(input_tokens, bool)
            or not 0 < input_tokens <= _MAX_TOKEN_CEILING
            or not isinstance(output_tokens, int) or isinstance(output_tokens, bool)
            or not 0 < output_tokens <= _MAX_TOKEN_CEILING):
        raise InferenceAdmissionRefused("inference_budget_ceiling_unavailable")
    return {"inference_requests": 1, "input_tokens": input_tokens, "output_tokens": output_tokens}


def _build_callback(  # noqa: PLR0913
    *,
    request_id: str,
    session_id: str | None,
    authority_revision: str,
    engine_type: str,
    write_message: Callable[[dict[str, Any]], None] | None,
    response_reader_factory: Callable[..., Callable[[float], dict[str, Any]]] | None,
    cancel_handle: Any,
    attempt_request_id: str | None = None,
    require_budget: bool = False,
) -> Callable[[InferenceAttemptContext], RuntimeInferenceLease]:
    trusted_request_id = _token(request_id, "request_id", _MAX_REQUEST_TOKEN_CHARS)
    trusted_session_id = (
        None
        if session_id is None
        else _token(session_id, "session_id", _MAX_REQUEST_TOKEN_CHARS)
    )
    trusted_authority_revision = _token(
        authority_revision, "authority_revision", _MAX_REQUEST_TOKEN_CHARS
    )
    trusted_engine_type = _token(engine_type, "engine_type", _MAX_ENGINE_TYPE_CHARS)
    expected_attempt_request_id = (
        trusted_request_id
        if attempt_request_id is None
        else _token(attempt_request_id, "request_id", _MAX_REQUEST_TOKEN_CHARS)
    )

    def _admit(context: InferenceAttemptContext) -> RuntimeInferenceLease:
        if (
            context.request_id != expected_attempt_request_id
            or context.session_id != str(trusted_session_id or "")
            or context.provider != trusted_engine_type
        ):
            raise InferenceAdmissionRefused("inference_route_context_mismatch")
        operation_id = f"inference_{secrets.token_hex(16)}"
        base_params = {
            "api_version": API_VERSION,
            "schema_version": 1,
            "kind": "inference",
            "request_id": trusted_request_id,
            "session_id": trusted_session_id,
            "authority_revision": trusted_authority_revision,
            "operation_id": operation_id,
        }
        result = _exchange(
            params={
                **base_params,
                "phase": "admit",
                "engine_type": trusted_engine_type,
                **({"maxima": _reservation_maxima(context)} if require_budget else {}),
            },
            operation_id=operation_id,
            expected_statuses=frozenset({"granted", "waiting", "rejected"}),
            write_message=write_message,
            response_reader_factory=response_reader_factory,
            cancel_handle=cancel_handle,
            timeout_seconds=_ADMIT_TIMEOUT_SECONDS,
        )
        if result["status"] == "waiting":
            raise InferenceAdmissionDeferred(
                _reason(result.get("reason"), "inference_capacity_waiting")
            )
        if result["status"] == "rejected":
            raise InferenceAdmissionRefused(
                _reason(result.get("reason"), "inference_capacity_rejected")
            )
        return RuntimeInferenceLease(
            base_params=base_params,
            operation_id=operation_id,
            write_message=write_message,
            response_reader_factory=response_reader_factory,
        )

    def _bind_request(
        *, request_id: str, session_id: str | None,
    ) -> Callable[[InferenceAttemptContext], RuntimeInferenceLease]:
        child_session_id = str(session_id or "")
        if child_session_id != str(trusted_session_id or ""):
            raise InferenceAdmissionRefused("inference_child_session_mismatch")
        return _build_callback(
            request_id=trusted_request_id,
            session_id=trusted_session_id,
            authority_revision=trusted_authority_revision,
            engine_type=trusted_engine_type,
            write_message=write_message,
            response_reader_factory=response_reader_factory,
            cancel_handle=cancel_handle,
            attempt_request_id=request_id,
            require_budget=require_budget,
        )

    _admit.requires_budget = require_budget  # type: ignore[attr-defined]
    _admit.bind_request = _bind_request  # type: ignore[attr-defined]
    def _bind_provider(provider: str) -> Callable[[InferenceAttemptContext], RuntimeInferenceLease]:
        # Only the configured fallback executor uses this capability. The app
        # independently validates provider locality, current grants and budget.
        return _build_callback(request_id=trusted_request_id, session_id=trusted_session_id,
            authority_revision=trusted_authority_revision, engine_type=provider,
            write_message=write_message, response_reader_factory=response_reader_factory,
            cancel_handle=cancel_handle, attempt_request_id=expected_attempt_request_id,
            require_budget=require_budget)
    _admit.bind_provider = _bind_provider  # type: ignore[attr-defined]
    return _admit


def build_inference_admission_callback(  # noqa: PLR0913
    *,
    request_id: str,
    session_id: str | None,
    execution_context: ExecutionContext | None,
    engine_type: str,
    write_message: Callable[[dict[str, Any]], None] | None,
    response_reader_factory: Callable[..., Callable[[float], dict[str, Any]]] | None,
    cancel_handle: Any,
    require_budget: bool = False,
) -> Callable[[InferenceAttemptContext], RuntimeInferenceLease] | None:
    """Build application admission for a chat request's execution authority."""

    if execution_context is None:
        if require_budget:
            raise InferenceAdmissionRefused("inference_budget_authority_required")
        return None
    trusted_session_id = _token(
        str(session_id or ""), "session_id", _MAX_REQUEST_TOKEN_CHARS
    )
    return _build_callback(
        request_id=request_id,
        session_id=trusted_session_id,
        authority_revision=execution_context.authority_revision,
        engine_type=engine_type,
        write_message=write_message,
        response_reader_factory=response_reader_factory,
        cancel_handle=cancel_handle,
        require_budget=require_budget,
    )


def inference_context_from_params(params: Any) -> AuxiliaryInferenceContext | None:
    """Parse the exact inference-only context; omission preserves legacy callers."""

    if not isinstance(params, dict) or "inference_context" not in params:
        return None
    value = params.get("inference_context")
    if not isinstance(value, dict) or set(value) != _INFERENCE_CONTEXT_FIELDS:
        raise ValueError("params.inference_context must be an exact version-1 object")
    try:
        encoded_size = len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError("params.inference_context must be JSON serializable") from error
    if encoded_size > _MAX_CONTEXT_BYTES:
        raise ValueError("params.inference_context exceeds the size limit")
    if isinstance(value.get("schema_version"), bool) or value.get("schema_version") != 1:
        raise ValueError("params.inference_context.schema_version is unsupported")
    try:
        request_id = _token(
            value.get("request_id"), "request_id", _MAX_REQUEST_TOKEN_CHARS
        )
        authority_revision = _token(
            value.get("authority_revision"),
            "authority_revision",
            _MAX_REQUEST_TOKEN_CHARS,
        )
        engine_type = _token(
            value.get("engine_type"), "engine_type", _MAX_ENGINE_TYPE_CHARS
        )
        session_id = (
            None
            if value.get("session_id") is None
            else _token(
                value.get("session_id"), "session_id", _MAX_REQUEST_TOKEN_CHARS
            )
        )
    except InferenceAdmissionRefused as error:
        raise ValueError(f"params.inference_context is invalid: {error.reason}") from error
    return AuxiliaryInferenceContext(
        schema_version=1,
        request_id=request_id,
        session_id=session_id,
        authority_revision=authority_revision,
        engine_type=engine_type,
    )


def build_auxiliary_inference_admission_callback(
    *,
    context: AuxiliaryInferenceContext | None,
    write_message: Callable[[dict[str, Any]], None] | None,
    response_reader_factory: Callable[..., Callable[[float], dict[str, Any]]] | None,
) -> Callable[[InferenceAttemptContext], RuntimeInferenceLease] | None:
    """Build admission for an application-authorized off-transcript request."""

    if context is None:
        return None
    return _build_callback(
        request_id=context.request_id,
        session_id=context.session_id,
        authority_revision=context.authority_revision,
        engine_type=context.engine_type,
        write_message=write_message,
        response_reader_factory=response_reader_factory,
        cancel_handle=None,
    )


__all__ = [
    "AuxiliaryInferenceContext",
    "RuntimeInferenceLease",
    "build_auxiliary_inference_admission_callback",
    "build_inference_admission_callback",
    "inference_context_from_params",
]
