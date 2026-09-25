"""Pure contracts for pausing before an admitted tool producer starts."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, TypeAlias

from sidecar.ai.error_codes import CMP_RESOURCE_EXCEEDED
from sidecar.ai.routing.auto_checkpoint import should_create_checkpoint
from sidecar.ai.routing.tool_quota_state import decode_quota_state
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import ToolCallRequest

_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_TOOL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_RESOURCE_CLASSES = frozenset(
    {"tool_operations", "native_processes", "tests", "sandbox_commands", "filesystem"}
)
_MAX_REASON_CHARS = 200
_MAX_PREPARED_INPUT_BYTES = 1024 * 1024
_MAX_TOOL_BATCH_CALLS = 256


def _identifier(value: object, field_name: str) -> str:
    if not isinstance(value, str) or _ID.fullmatch(value) is None:
        raise ValueError(f"invalid_{field_name}")
    return value


def _tool_identifier(value: object) -> str:
    if not isinstance(value, str) or _TOOL_ID.fullmatch(value) is None:
        raise ValueError("invalid_tool_id")
    return value


def _counter(value: object, field_name: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValueError(f"invalid_{field_name}")
    return value


@dataclass(frozen=True, slots=True)
class ToolResourceWait:
    """Trusted application classification of one non-blocking resource wait."""

    operation_id: str
    resource_class: str
    dependency_id: str | None = None
    reason: str | None = None

    def __post_init__(self) -> None:
        _identifier(self.operation_id, "operation_id")
        if self.resource_class not in _RESOURCE_CLASSES:
            raise ValueError("invalid_resource_class")
        if self.dependency_id is not None:
            _identifier(self.dependency_id, "dependency_id")
        if self.reason is not None and (
            not isinstance(self.reason, str)
            or not self.reason
            or len(self.reason) > _MAX_REASON_CHARS
        ):
            raise ValueError("invalid_wait_reason")


@dataclass(frozen=True, slots=True)
class PreparedToolDeferral:
    """Frozen, JSON-safe tool input captured after validation and before dispatch."""

    wait: ToolResourceWait | None
    call_id: str
    tool_id: str
    effective_args_sha256: str
    frozen_input_sha256: str
    _frozen_input_json: bytes = field(repr=False)

    @classmethod
    def freeze(
        cls,
        *,
        wait: ToolResourceWait | None,
        call_id: str,
        tool_id: str,
        frozen_inputs: Any,
    ) -> PreparedToolDeferral:
        normalized_call_id = _identifier(call_id, "call_id")
        normalized_tool_id = _tool_identifier(tool_id)
        if wait is not None and wait.operation_id != normalized_call_id:
            raise ValueError("operation_call_identity_mismatch")
        visible_arguments = getattr(frozen_inputs, "visible_tool_arguments", None)
        effective_arguments = getattr(frozen_inputs, "effective_tool_arguments", None)
        injected_keys = getattr(frozen_inputs, "injected_arg_keys", None)
        execution_context = getattr(frozen_inputs, "execution_context_payload", None)
        if (
            not isinstance(visible_arguments, Mapping)
            or not isinstance(effective_arguments, Mapping)
            or not isinstance(injected_keys, tuple)
            or not all(isinstance(key, str) for key in injected_keys)
            or not isinstance(execution_context, Mapping)
        ):
            raise ValueError("invalid_frozen_execution_inputs")
        frozen_value = {
            "call_id": getattr(frozen_inputs, "call_id", None),
            "tool_name": getattr(frozen_inputs, "tool_name", None),
            "visible_tool_arguments": dict(visible_arguments),
            "effective_tool_arguments": dict(effective_arguments),
            "injected_arg_keys": list(injected_keys),
            "effective_args_fingerprint": getattr(
                frozen_inputs, "effective_args_fingerprint", None
            ),
            "execution_context_payload": dict(execution_context),
        }
        if (
            frozen_value["call_id"] != normalized_call_id
            or frozen_value["tool_name"] != normalized_tool_id
            or not isinstance(frozen_value["effective_args_fingerprint"], str)
            or _SHA256.fullmatch(frozen_value["effective_args_fingerprint"]) is None
        ):
            raise ValueError("invalid_frozen_execution_inputs")
        try:
            body = json.dumps(
                frozen_value,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=True,
                allow_nan=False,
            ).encode("utf-8")
            decoded = json.loads(body)
        except (TypeError, ValueError, OverflowError) as error:
            raise ValueError("invalid_frozen_execution_inputs") from error
        if (
            not isinstance(decoded, dict)
            or decoded != frozen_value
            or len(body) > _MAX_PREPARED_INPUT_BYTES
        ):
            raise ValueError("invalid_frozen_execution_inputs")
        effective_arguments = decoded.get("effective_tool_arguments")
        effective_body = json.dumps(
            effective_arguments,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
        effective_fingerprint = str(decoded["effective_args_fingerprint"])
        if hashlib.sha256(effective_body).hexdigest() != effective_fingerprint:
            raise ValueError("effective_args_fingerprint_mismatch")
        return cls(
            wait=wait,
            call_id=normalized_call_id,
            tool_id=normalized_tool_id,
            effective_args_sha256=effective_fingerprint,
            frozen_input_sha256=hashlib.sha256(body).hexdigest(),
            _frozen_input_json=body,
        )

    @property
    def frozen_input_bytes(self) -> bytes:
        """Return the exact Python-canonical bytes retained for persistence."""

        return self._frozen_input_json

    def frozen_input(self) -> dict[str, Any]:
        """Return a fresh full frozen-input value for the runtime checkpoint."""

        value = json.loads(self._frozen_input_json)
        if not isinstance(value, dict):  # pragma: no cover - constructor invariant
            raise ValueError("invalid_frozen_execution_inputs")
        return value

    def effective_arguments(self) -> dict[str, Any]:
        """Return a fresh JSON value so callback mutation cannot alter the checkpoint."""

        value = self.frozen_input().get("effective_tool_arguments")
        if not isinstance(value, dict):  # pragma: no cover - constructor invariant
            raise ValueError("invalid_effective_arguments")
        return value


@dataclass(frozen=True, slots=True)
class BeforeToolDispatchContinuation:
    """Provider-neutral loop state for the closed first-call continuation."""

    pending: PreparedToolDeferral
    ordered_call_ids: tuple[str, ...]
    completed_iterations: int
    remaining_iterations: int
    current_iteration: int
    tool_call_limit: int
    tool_calls_consumed: int
    active_budget_ms_remaining: int | None
    tool_batch_sha256: str
    _tool_batch_json: bytes = field(repr=False)
    quota_state_json: bytes | None = field(default=None, repr=False, kw_only=True)

    def __post_init__(self) -> None:
        if self.quota_state_json is not None:
            decode_quota_state(self.quota_state_json)
        ordered = tuple(_identifier(value, "ordered_call_id") for value in self.ordered_call_ids)
        if (
            not ordered
            or len(set(ordered)) != len(ordered)
            or ordered[0] != self.pending.call_id
        ):
            raise ValueError("invalid_ordered_call_ids")
        object.__setattr__(self, "ordered_call_ids", ordered)
        completed = _counter(self.completed_iterations, "completed_iterations", minimum=1)
        current = _counter(self.current_iteration, "current_iteration", minimum=1)
        _counter(self.remaining_iterations, "remaining_iterations")
        limit = _counter(self.tool_call_limit, "tool_call_limit", minimum=1)
        consumed = _counter(self.tool_calls_consumed, "tool_calls_consumed", minimum=1)
        if (current != completed or consumed > limit
                or consumed != len(ordered) + self._prior_outcome_count()):
            raise ValueError("invalid_continuation_position")
        if self.active_budget_ms_remaining is not None:
            _counter(self.active_budget_ms_remaining, "active_budget_ms_remaining")
        if _SHA256.fullmatch(self.tool_batch_sha256) is None:
            raise ValueError("invalid_tool_batch_sha256")
        calls = self.tool_calls()
        if tuple(call.call_id for call in calls) != ordered:
            raise ValueError("tool_batch_identity_mismatch")

    def _prior_outcome_count(self) -> int:
        return 0

    @property
    def tool_batch_bytes(self) -> bytes:
        """Return the exact Python-canonical generated tool-batch bytes."""

        return self._tool_batch_json

    def tool_calls(self) -> tuple[ToolCallRequest, ...]:
        """Return fresh typed calls so callback mutation cannot alter the batch."""

        value = json.loads(self._tool_batch_json)
        calls = value.get("calls") if isinstance(value, dict) else None
        if not isinstance(calls, list):  # pragma: no cover - constructor invariant
            raise ValueError("invalid_tool_batch")
        return tuple(
            ToolCallRequest(
                call_id=item["call_id"],
                tool_id=item["tool_id"],
                arguments=item["arguments"],
                idempotency_key=item["idempotency_key"],
                coerced=item["coerced"],
                malformed_arguments=item["malformed_arguments"],
                argument_repairs=tuple(item["argument_repairs"]),
            )
            for item in calls
        )


ContinuationCheckpointCallback: TypeAlias = Callable[
    [BeforeToolDispatchContinuation], Mapping[str, Any]
]


class ToolResourceDeferred(Exception):
    """A resource owner refused to retain the worker while capacity is busy."""

    def __init__(
        self,
        wait: ToolResourceWait,
        prepared: PreparedToolDeferral | None = None,
    ) -> None:
        super().__init__(wait.reason or "tool_resource_capacity_waiting")
        self.wait = wait
        self.prepared = prepared

    def prepare(
        self,
        *,
        call_id: str,
        tool_id: str,
        frozen_inputs: Any,
    ) -> ToolResourceDeferred:
        return ToolResourceDeferred(
            self.wait,
            PreparedToolDeferral.freeze(
                wait=self.wait,
                call_id=call_id,
                tool_id=tool_id,
                frozen_inputs=frozen_inputs,
            ),
        )


class DecisionSuspensionError(RuntimeError):
    """An invalidated human waiter cannot be normalized into a tool outcome."""


class ToolLoopSuspended(Exception):
    """The application persisted the continuation and the loop may unwind."""

    def __init__(self, checkpoint_ref: Mapping[str, Any]) -> None:
        if not isinstance(checkpoint_ref, Mapping):
            raise ValueError("invalid_checkpoint_reference")
        super().__init__("tool_resource_continuation_persisted")
        self.checkpoint_ref = dict(checkpoint_ref)


def resource_wait_failure(wait: ToolResourceWait) -> ToolExecutionFailure:
    """Preserve the legacy retryable failure when continuation is unavailable."""

    return ToolExecutionFailure(
        code=CMP_RESOURCE_EXCEEDED,
        message=f"Tool resource capacity is busy: {wait.reason or 'resource_capacity'}",
        retryable=True,
    )


def first_batch_deferral_eligible(  # noqa: PLR0913
    *,
    callback: object,
    streaming: bool,
    iteration_base: int,
    current_iteration: int,
    outcomes_before_batch: int,
    outcomes_after_filter: int,
    emitted_tool_execution_count: int,
    preview_count: int,
    has_images: bool,
    mutation_started: bool,
    approval_resume: bool,
    auto_checkpoint_pending: bool,
    contains_delegate: bool,
    ordered_call_ids: Sequence[str],
    pending_call_id: str,
    pending_tool_id: str,
) -> bool:
    """Return whether this is exactly the closed v1 first-call suspension state."""

    return bool(
        callable(callback)
        and streaming
        and iteration_base == 0
        and current_iteration == 1
        and outcomes_before_batch == 0
        and outcomes_after_filter == 0
        and emitted_tool_execution_count == 0
        and preview_count == 0
        and not has_images
        and not mutation_started
        and not approval_resume
        and not auto_checkpoint_pending
        and pending_tool_id != "delegate"
        and not contains_delegate
        and ordered_call_ids
        and ordered_call_ids[0] == pending_call_id
    )


def build_before_tool_dispatch_continuation(  # noqa: PLR0913
    deferred: ToolResourceDeferred | PreparedToolDeferral,
    *,
    ordered_call_ids: Sequence[str],
    current_iteration: int,
    remaining_iterations: int,
    tool_call_limit: int,
    tool_calls_consumed: int,
    active_budget_ms_remaining: int | None,
    tool_calls: Sequence[Any],
    quota_state_json: bytes | None = None,
) -> BeforeToolDispatchContinuation:
    """Build the callback value after eligibility was established by the loop."""

    prepared = deferred if isinstance(deferred, PreparedToolDeferral) else deferred.prepared
    if prepared is None:
        raise ValueError("tool_resource_deferral_not_prepared")
    if not 1 <= len(tool_calls) <= _MAX_TOOL_BATCH_CALLS:
        raise ValueError("invalid_tool_batch")
    calls = []
    for call in tool_calls:
        call_id = _identifier(getattr(call, "call_id", None), "call_id")
        tool_id = _tool_identifier(getattr(call, "tool_id", None))
        arguments = getattr(call, "arguments", None)
        repairs = getattr(call, "argument_repairs", None)
        if (
            not isinstance(arguments, Mapping)
            or not isinstance(getattr(call, "idempotency_key", None), str)
            or not isinstance(getattr(call, "coerced", None), bool)
            or not isinstance(getattr(call, "malformed_arguments", None), bool)
            or not isinstance(repairs, tuple)
            or not all(isinstance(repair, str) for repair in repairs)
        ):
            raise ValueError("invalid_tool_batch")
        calls.append({
            "call_id": call_id,
            "tool_id": tool_id,
            "arguments": dict(arguments),
            "idempotency_key": call.idempotency_key,
            "coerced": call.coerced,
            "malformed_arguments": call.malformed_arguments,
            "argument_repairs": list(repairs),
        })
    try:
        batch_value = {"calls": calls}
        batch_json = json.dumps(
            batch_value, sort_keys=True, separators=(",", ":"),
            ensure_ascii=True, allow_nan=False,
        ).encode("utf-8")
        if json.loads(batch_json) != batch_value:
            raise ValueError("invalid_tool_batch")
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError("invalid_tool_batch") from error
    if len(batch_json) > _MAX_PREPARED_INPUT_BYTES:
        raise ValueError("invalid_tool_batch")
    return BeforeToolDispatchContinuation(
        pending=prepared,
        ordered_call_ids=tuple(ordered_call_ids),
        completed_iterations=current_iteration,
        remaining_iterations=remaining_iterations,
        current_iteration=current_iteration,
        tool_call_limit=tool_call_limit,
        tool_calls_consumed=tool_calls_consumed,
        active_budget_ms_remaining=active_budget_ms_remaining,
        tool_batch_sha256=hashlib.sha256(batch_json).hexdigest(),
        _tool_batch_json=batch_json,
        quota_state_json=quota_state_json,
    )


def first_batch_deferral_eligible_for_loop(
    loop_run: Any,
    *,
    current_iteration: int,
    outcomes_before_batch: int,
    remaining_calls: Sequence[tuple[Any, int]],
    ordered_calls: Sequence[Any],
) -> bool:
    """Project loop state into the closed pure eligibility predicate."""

    runtime = loop_run.runtime
    pending = remaining_calls[0][0] if remaining_calls else None
    ordered_ids = tuple(str(getattr(call, "call_id", "") or "").strip() for call in ordered_calls)
    config = getattr(loop_run.kernel, "_config", None)
    auto_checkpoint_pending = should_create_checkpoint(
        feature_flags=getattr(config, "feature_flags", None),
        already_created=bool(getattr(loop_run, "checkpoint_created", False)),
        tool_ids=(str(getattr(call, "tool_id", "") or "") for call, _ in remaining_calls),
    )
    return first_batch_deferral_eligible(
        callback=getattr(runtime, "continuation_checkpoint", None),
        streaming=bool(getattr(runtime, "streaming", False)),
        iteration_base=int(getattr(loop_run, "iteration_base", 0) or 0),
        current_iteration=current_iteration,
        outcomes_before_batch=outcomes_before_batch,
        outcomes_after_filter=len(loop_run.outcomes),
        emitted_tool_execution_count=len(getattr(runtime, "emitted_tool_calls", {})),
        preview_count=len(getattr(runtime, "preview_images", {})),
        has_images=bool(getattr(loop_run.request_context, "vision_images", ())),
        mutation_started=bool(
            getattr(loop_run, "_jenny_change_set_id", "")
            or getattr(runtime, "mutation_started", False)
        ),
        approval_resume=bool(getattr(loop_run, "iteration_base", 0)),
        auto_checkpoint_pending=auto_checkpoint_pending,
        contains_delegate=any(
            str(getattr(call, "tool_id", "") or "").strip() == "delegate"
            for call in ordered_calls
        ),
        ordered_call_ids=ordered_ids,
        pending_call_id=str(getattr(pending, "call_id", "") or "").strip(),
        pending_tool_id=str(getattr(pending, "tool_id", "") or "").strip(),
    )


def _freeze_loop_quota(loop: Any) -> bytes | None:
    from sidecar.ai.routing.quota_runtime import freeze_runtime_quota  # noqa: PLC0415
    return freeze_runtime_quota(loop.runtime, loop.kernel._config,
                               outcomes=loop.outcomes, tool_contract=loop.tool_contract)


def continuation_from_loop(
    loop_run: Any,
    deferred: ToolResourceDeferred | PreparedToolDeferral,
    *,
    ordered_calls: Sequence[Any],
    current_iteration: int,
) -> BeforeToolDispatchContinuation:
    """Capture bounded position counters without persisting application identity."""

    runtime = loop_run.runtime
    deadline = getattr(runtime, "wall_clock_deadline", None)
    remaining_ms = None
    if deadline is not None:
        remaining_ms = max(int((float(deadline) - float(runtime.clock())) * 1000), 0)
    return build_before_tool_dispatch_continuation(
        deferred,
        ordered_call_ids=tuple(
            str(getattr(call, "call_id", "") or "").strip() for call in ordered_calls
        ),
        current_iteration=current_iteration,
        remaining_iterations=max(int(loop_run.iteration_total) - current_iteration, 0),
        tool_call_limit=int(runtime.tool_call_limit or 0),
        tool_calls_consumed=int(runtime.tool_calls_consumed or 0),
        active_budget_ms_remaining=remaining_ms,
        tool_calls=ordered_calls,
        quota_state_json=_freeze_loop_quota(loop_run),
    )


def suspend_loop_for_resource(
    loop_run: Any,
    deferred: ToolResourceDeferred,
    *,
    ordered_calls: Sequence[Any],
    current_iteration: int,
) -> ToolLoopSuspended:
    """Persist through the injected callback and return the unwind exception."""

    callback = getattr(loop_run.runtime, "continuation_checkpoint", None)
    if not callable(callback):
        raise resource_wait_failure(deferred.wait)
    context = continuation_from_loop(
        loop_run,
        deferred,
        ordered_calls=ordered_calls,
        current_iteration=current_iteration,
    )
    return ToolLoopSuspended(callback(context))


__all__ = [
    "BeforeToolDispatchContinuation",
    "ContinuationCheckpointCallback",
    "PreparedToolDeferral",
    "ToolLoopSuspended",
    "ToolResourceDeferred",
    "ToolResourceWait",
    "build_before_tool_dispatch_continuation",
    "continuation_from_loop",
    "first_batch_deferral_eligible",
    "first_batch_deferral_eligible_for_loop",
    "resource_wait_failure",
    "suspend_loop_for_resource",
]
