"""Reverse-RPC persistence callback for one eligible tool continuation."""

from __future__ import annotations

import base64
import hashlib
import itertools
import json
import math
import re
import time
from contextlib import contextmanager
from typing import Any, Callable, Iterator, Mapping, NoReturn

from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.routing.tool_dependency_wait import BeforeDependencyWaitContinuation
from sidecar.ai.routing.tool_quota_state import decode_quota_state
from sidecar.ai.routing.tool_resource_deferral import BeforeToolDispatchContinuation
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.protocol import API_VERSION, JSONRPC_VERSION, RUNTIME_OPERATION_METHOD
from sidecar.runtime.continuation_context import ContinuationContext
from sidecar.runtime.multiplexer import ApprovalResponseCancelledError

MAX_CHECKPOINT_REQUEST_BYTES = 1024 * 1024
MAX_CHECKPOINT_SNAPSHOT_BYTES = 1024 * 1024
MIN_CHECKPOINT_SNAPSHOT_BYTES = 2
_MAX_REASON_CHARS = 200
_MAX_TOOL_CALLS = 256
_MAX_ITERATIONS = 10_000
_MAX_ACTIVE_BUDGET_MS = 7 * 24 * 60 * 60 * 1000
_RPC_IDS = itertools.count(70_000_000)
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_TOOL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_CHECKPOINT_ID = re.compile(r"checkpoint_[0-9a-f]{64}\Z")
_TOOL_CALL_KEYS = frozenset(
    {
        "call_id", "tool_id", "arguments", "idempotency_key", "coerced",
        "malformed_arguments", "argument_repairs",
    }
)
_FROZEN_INPUT_KEYS = frozenset(
    {
        "call_id", "tool_name", "visible_tool_arguments", "effective_tool_arguments",
        "injected_arg_keys", "effective_args_fingerprint", "execution_context_payload",
    }
)
_SOURCE_ATTEMPT_KEYS = frozenset(
    {"attempt_id", "stream_id", "incarnation", "authority_revision"}
)
_CHECKPOINT_REF_KEYS = frozenset(
    {"schema_version", "checkpoint_id", "sha256", "bytes", "source_attempt"}
)


def _failure(reason: str, *, retryable: bool = False) -> ToolExecutionFailure:
    normalized = str(reason or "continuation_checkpoint_failed")[:_MAX_REASON_CHARS]
    return ToolExecutionFailure(
        code=CMP_TOOL_EXECUTION_FAILED,
        message=f"Continuation checkpoint failed: {normalized}",
        retryable=retryable,
    )


def _fail(reason: str, *, retryable: bool = False) -> NoReturn:
    raise _failure(reason, retryable=retryable)


def _counter(value: Any, name: str, *, minimum: int = 0, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        _fail(f"continuation_{name}_invalid")
    return value


def _timeout(value: Any) -> float:
    try:
        timeout = float(value)
    except (TypeError, ValueError, OverflowError) as error:
        raise _failure("continuation_checkpoint_timeout_invalid") from error
    if not math.isfinite(timeout):
        _fail("continuation_checkpoint_timeout_invalid")
    return min(max(timeout, 0.1), 30.0)


def _canonical_value(body: Any, digest: Any, name: str) -> Any:
    if (
        not isinstance(body, bytes)
        or not MIN_CHECKPOINT_SNAPSHOT_BYTES <= len(body) <= MAX_CHECKPOINT_SNAPSHOT_BYTES
        or not isinstance(digest, str)
        or _SHA256.fullmatch(digest) is None
        or hashlib.sha256(body).hexdigest() != digest
    ):
        _fail(f"continuation_{name}_bytes_invalid")
    try:
        value = json.loads(
            body.decode("utf-8", errors="strict"),
            parse_constant=lambda _value: _fail(f"continuation_{name}_encoding_invalid"),
        )
        canonical = json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False,
        ).encode("utf-8")
    except ToolExecutionFailure:
        raise
    except (
        UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError, OverflowError,
    ) as error:
        raise _failure(f"continuation_{name}_encoding_invalid") from error
    if canonical != body:
        _fail(f"continuation_{name}_encoding_invalid")
    return value


def _normalize_tool_batch(
    continuation: BeforeToolDispatchContinuation,
) -> tuple[list[dict[str, Any]], bytes]:
    body = continuation.tool_batch_bytes
    value = _canonical_value(body, continuation.tool_batch_sha256, "tool_batch")
    if not isinstance(value, dict) or set(value) != {"calls"}:
        _fail("continuation_tool_batch_invalid")
    calls = value["calls"]
    if not isinstance(calls, list) or not 1 <= len(calls) <= _MAX_TOOL_CALLS:
        _fail("continuation_tool_batch_invalid")
    normalized: list[dict[str, Any]] = []
    for call in calls:
        if not isinstance(call, dict) or set(call) != _TOOL_CALL_KEYS:
            _fail("continuation_tool_call_invalid")
        if (
            not isinstance(call["call_id"], str) or _ID.fullmatch(call["call_id"]) is None
            or not isinstance(call["tool_id"], str) or _TOOL_ID.fullmatch(call["tool_id"]) is None
            or not isinstance(call["arguments"], dict)
            or not isinstance(call["idempotency_key"], str)
            or not isinstance(call["coerced"], bool)
            or not isinstance(call["malformed_arguments"], bool)
            or not isinstance(call["argument_repairs"], list)
            or any(not isinstance(item, str) for item in call["argument_repairs"])
        ):
            _fail("continuation_tool_call_invalid")
        normalized.append(dict(call))
    if tuple(call["call_id"] for call in normalized) != tuple(continuation.ordered_call_ids):
        _fail("continuation_tool_batch_identity_mismatch")
    return normalized, body


def _normalize_frozen_input(
    continuation: BeforeToolDispatchContinuation,
) -> tuple[dict[str, Any], bytes]:
    pending = continuation.pending
    body = pending.frozen_input_bytes
    value = _canonical_value(body, pending.frozen_input_sha256, "frozen_input")
    if not isinstance(value, dict) or set(value) != _FROZEN_INPUT_KEYS:
        _fail("continuation_frozen_input_invalid")
    if (
        value["call_id"] != pending.call_id
        or value["tool_name"] != pending.tool_id
        or not isinstance(value["visible_tool_arguments"], dict)
        or not isinstance(value["effective_tool_arguments"], dict)
        or not isinstance(value["injected_arg_keys"], list)
        or any(not isinstance(item, str) for item in value["injected_arg_keys"])
        or not isinstance(value["execution_context_payload"], dict)
        or value["effective_args_fingerprint"] != pending.effective_args_sha256
        or not isinstance(value["effective_args_fingerprint"], str)
        or _SHA256.fullmatch(value["effective_args_fingerprint"]) is None
    ):
        _fail("continuation_frozen_input_invalid")
    effective_body = json.dumps(
        value["effective_tool_arguments"],
        sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False,
    ).encode("utf-8")
    if hashlib.sha256(effective_body).hexdigest() != pending.effective_args_sha256:
        _fail("continuation_effective_args_mismatch")
    return dict(value), body


def _position(continuation: BeforeToolDispatchContinuation) -> dict[str, Any]:
    completed = _counter(
        continuation.completed_iterations, "completed_iterations",
        minimum=1, maximum=_MAX_ITERATIONS,
    )
    remaining = _counter(
        continuation.remaining_iterations, "remaining_iterations", maximum=_MAX_ITERATIONS,
    )
    current = _counter(
        continuation.current_iteration, "current_iteration",
        minimum=1, maximum=_MAX_ITERATIONS,
    )
    limit = _counter(
        continuation.tool_call_limit, "tool_call_limit", minimum=1, maximum=_MAX_TOOL_CALLS,
    )
    consumed = _counter(
        continuation.tool_calls_consumed, "tool_calls_consumed",
        minimum=1, maximum=limit,
    )
    ordered = list(continuation.ordered_call_ids)
    budget = continuation.active_budget_ms_remaining
    if budget is not None:
        budget = _counter(budget, "active_budget_ms_remaining", maximum=_MAX_ACTIVE_BUDGET_MS)
    if (
        current != completed
        or completed + remaining > _MAX_ITERATIONS
        or len(ordered) + continuation._prior_outcome_count() != consumed
        or len(set(ordered)) != len(ordered)
        or not ordered
        or ordered[0] != continuation.pending.call_id
    ):
        _fail("continuation_position_invalid")
    return {
        "completed_iterations": completed,
        "remaining_iterations": remaining,
        "current_iteration": current,
        "tool_call_limit": limit,
        "tool_calls_consumed": consumed,
        "active_budget_ms_remaining": budget,
        "ordered_call_ids": ordered,
    }


def _request_params(
    context: ContinuationContext,
    continuation: BeforeToolDispatchContinuation,
) -> dict[str, Any]:
    if not isinstance(continuation, BeforeToolDispatchContinuation):
        _fail("continuation_checkpoint_value_invalid")
    calls, batch_body = _normalize_tool_batch(continuation)
    frozen_input, frozen_body = _normalize_frozen_input(continuation)
    if calls[0]["tool_id"] != continuation.pending.tool_id:
        _fail("continuation_pending_tool_mismatch")
    dependency = (
        continuation if isinstance(continuation, BeforeDependencyWaitContinuation) else None
    )
    refs = [ref.to_wire() for ref in dependency.completed_spawn_refs] if dependency else []
    effects_json = getattr(continuation, "completed_effects_json", None)
    mixed = effects_json is not None
    prior_checkpoint_json = getattr(continuation, "prior_checkpoint_json", None)
    repeated = dependency is not None and prior_checkpoint_json is not None
    waits = [ref.to_wire() for ref in dependency.completed_wait_refs] if dependency else []
    prior_count = getattr(continuation, "prior_effect_count", 0) if dependency or mixed else 0
    effects = json.loads(effects_json) if effects_json is not None else []
    return {
        **({"quota_state": decode_quota_state(continuation.quota_state_json)}
           if continuation.quota_state_json is not None else {}),
        **({"completed_effect_refs": effects} if mixed else {}),
        **({**({"completed_wait_refs": waits} if dependency else {}),
            "prior_effect_count": prior_count,
            "prior_checkpoint_ref": (json.loads(prior_checkpoint_json)
                                     if prior_checkpoint_json is not None else None)}
           if repeated or mixed else {}),
        **({"completed_spawn_refs": refs} if dependency else {}),
        "api_version": API_VERSION,
        "schema_version": 1,
        "kind": "continuation",
        "phase": "checkpoint",
        "request_id": context.source_attempt.stream_id,
        "session_id": context.enclosing_session_id,
        "authority_revision": context.source_attempt.authority_revision,
        "operation_id": continuation.pending.call_id,
        "continuation_context": context.to_wire(),
        "position": _position(continuation),
        "eligibility": {
            "pending_call_index": 0,
            "prior_outcome_count": (
                len(effects) if mixed else len(refs) + len(waits)
            ) - prior_count,
            "emitted_tool_execution_count": (getattr(continuation, "current_execution_count", 0)
                                             if mixed else len(refs) + len(waits) - prior_count),
            "preview_count": 0,
            "approval_pending": False,
            "mutation_started": False,
        },
        "tool_calls": calls,
        "tool_batch_bytes": base64.b64encode(batch_body).decode("ascii"),
        "tool_batch_sha256": continuation.tool_batch_sha256,
        "frozen_input": frozen_input,
        "frozen_input_bytes": base64.b64encode(frozen_body).decode("ascii"),
        "frozen_input_sha256": continuation.pending.frozen_input_sha256,
    }


@contextmanager
def _closing(reader: Callable[[float], dict[str, Any]]) -> Iterator[None]:
    try:
        yield
    finally:
        close = getattr(reader, "close", None)
        if callable(close):
            close()


def _checkpoint_ref(result: Mapping[str, Any], context: ContinuationContext) -> dict[str, Any]:
    if set(result) != {"schema_version", "operation_id", "status", "checkpoint_ref"}:
        _fail("continuation_checkpoint_response_malformed")
    value = result["checkpoint_ref"]
    expected_attempt = context.source_attempt.to_wire()
    if (
        not isinstance(value, Mapping)
        or set(value) != _CHECKPOINT_REF_KEYS
        or isinstance(value.get("schema_version"), bool)
        or value.get("schema_version") != 1
        or not isinstance(value.get("checkpoint_id"), str)
        or _CHECKPOINT_ID.fullmatch(value["checkpoint_id"]) is None
        or not isinstance(value.get("sha256"), str)
        or _SHA256.fullmatch(value["sha256"]) is None
        or isinstance(value.get("bytes"), bool)
        or not isinstance(value.get("bytes"), int)
        or not MIN_CHECKPOINT_SNAPSHOT_BYTES <= value["bytes"] <= MAX_CHECKPOINT_SNAPSHOT_BYTES
        or not isinstance(value.get("source_attempt"), Mapping)
        or set(value["source_attempt"]) != _SOURCE_ATTEMPT_KEYS
        or dict(value["source_attempt"]) != expected_attempt
    ):
        _fail("continuation_checkpoint_response_malformed")
    return {
        "schema_version": 1,
        "checkpoint_id": value["checkpoint_id"],
        "sha256": value["sha256"],
        "bytes": value["bytes"],
        "source_attempt": dict(expected_attempt),
    }


def _exchange(  # noqa: C901, PLR0912, PLR0913
    *,
    context: ContinuationContext,
    params: dict[str, Any],
    write_message: Callable[[dict[str, Any]], None] | None,
    response_reader_factory: Callable[..., Callable[[float], dict[str, Any]]] | None,
    cancel_handle: Any,
    timeout_seconds: float,
) -> dict[str, Any] | None:
    if cancel_handle is not None and bool(getattr(cancel_handle, "cancelled", False)):
        _fail("continuation_checkpoint_cancelled", retryable=True)
    if not callable(write_message) or not callable(response_reader_factory):
        _fail("continuation_checkpoint_bridge_unavailable")
    rpc_id = next(_RPC_IDS)
    message = {
        "jsonrpc": JSONRPC_VERSION,
        "api_version": API_VERSION,
        "id": rpc_id,
        "method": RUNTIME_OPERATION_METHOD,
        "params": params,
    }
    try:
        encoded_size = len(json.dumps(
            message, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8"))
    except (TypeError, ValueError, UnicodeEncodeError, OverflowError) as error:
        raise _failure("continuation_checkpoint_request_invalid") from error
    if encoded_size > MAX_CHECKPOINT_REQUEST_BYTES:
        _fail("continuation_checkpoint_request_too_large")
    try:
        reader = response_reader_factory(rpc_id, cancel_handle=cancel_handle)
    except Exception as error:
        raise _failure("continuation_checkpoint_bridge_unavailable") from error
    with _closing(reader):
        try:
            write_message(message)
        except Exception as error:
            raise _failure("continuation_checkpoint_write_failed") from error
        deadline = time.monotonic() + timeout_seconds
        while True:
            if cancel_handle is not None and bool(getattr(cancel_handle, "cancelled", False)):
                _fail("continuation_checkpoint_cancelled", retryable=True)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _fail("continuation_checkpoint_timeout", retryable=True)
            try:
                response = reader(remaining)
            except (TimeoutError, ApprovalResponseCancelledError) as error:
                raise _failure("continuation_checkpoint_incomplete", retryable=True) from error
            except Exception as error:
                raise _failure("continuation_checkpoint_read_failed") from error
            if not isinstance(response, Mapping) or response.get("id") != rpc_id:
                continue
            result = response.get("result")
            if not isinstance(result, Mapping):
                _fail("continuation_checkpoint_response_malformed")
            if (
                isinstance(result.get("schema_version"), bool)
                or result.get("schema_version") != 1
                or result.get("operation_id") != params["operation_id"]
            ):
                _fail("continuation_checkpoint_response_malformed")
            if (params["phase"] == "pause_probe" and result.get("status") == "continue"
                and set(result) == {"schema_version", "operation_id", "status"}):
                return None
            if result.get("status") == "checkpointed":
                return _checkpoint_ref(result, context)
            if result.get("status") == "rejected" and set(result) == {
                "schema_version", "operation_id", "status", "reason",
            }:
                reason = result.get("reason")
                if isinstance(reason, str) and 0 < len(reason) <= _MAX_REASON_CHARS:
                    _fail(reason)
            _fail("continuation_checkpoint_response_malformed")


def build_continuation_checkpoint_callback(
    *,
    context: ContinuationContext | None,
    write_message: Callable[[dict[str, Any]], None] | None,
    response_reader_factory: Callable[..., Callable[[float], dict[str, Any]]] | None,
    cancel_handle: Any,
    timeout_seconds: float = 30.0,
) -> Callable[[BeforeToolDispatchContinuation], dict[str, Any]] | None:
    """Build an exact checkpoint callback for one app-owned continuation context."""

    if context is None:
        return None
    if not isinstance(context, ContinuationContext):
        raise TypeError("context must be a ContinuationContext")
    timeout = _timeout(timeout_seconds)

    def send(continuation: BeforeToolDispatchContinuation, phase: str) -> dict[str, Any] | None:
        params = _request_params(context, continuation)
        params["phase"] = phase
        return _exchange(
            context=context,
            params=params,
            write_message=write_message,
            response_reader_factory=response_reader_factory,
            cancel_handle=cancel_handle,
            timeout_seconds=timeout,
        )
    class CheckpointCallback:
        def __call__(self, continuation: BeforeToolDispatchContinuation) -> dict[str, Any]:
            phase = ("resource_checkpoint" if hasattr(continuation, "completed_effects_json")
                     else "checkpoint")
            result = send(continuation, phase)
            if result is None:
                _fail("continuation_checkpoint_response_malformed")
            return result

        def probe_pause(
            self, continuation: BeforeToolDispatchContinuation,
        ) -> dict[str, Any] | None:
            return send(continuation, "pause_probe")

        def probe_dependency(
            self, continuation: BeforeDependencyWaitContinuation,
        ) -> dict[str, Any]:
            if not isinstance(continuation, BeforeDependencyWaitContinuation):
                _fail("continuation_dependency_value_invalid")
            result = send(continuation, "dependency_checkpoint")
            if result is None:
                _fail("continuation_checkpoint_response_malformed")
            return result

    return CheckpointCallback()


__all__ = [
    "MAX_CHECKPOINT_REQUEST_BYTES",
    "MAX_CHECKPOINT_SNAPSHOT_BYTES",
    "build_continuation_checkpoint_callback",
]
