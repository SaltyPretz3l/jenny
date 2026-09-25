"""Closed field validation shared by runtime checkpoint variants."""

from __future__ import annotations

import re
from typing import Any, Mapping, NoReturn

SESSION_RUNTIME_CONTINUATION_SCHEMA_VERSION = 1
SESSION_RUNTIME_CONTINUATION_KIND = "before_tool_dispatch"
SESSION_RUNTIME_DEPENDENCY_KIND = "before_dependency_wait"
SESSION_RUNTIME_DECISION_KIND = "before_decision_wait"
MAX_CONTINUATION_BODY_BYTES = 1024 * 1024
MAX_CONTINUATION_TOOL_CALLS = 256
MAX_CONTINUATION_ITERATIONS = 10_000
MAX_ACTIVE_BUDGET_MS = 7 * 24 * 60 * 60 * 1000
MAX_SAFE_INTEGER = (2**53) - 1
MIN_CONTINUATION_BODY_BYTES = 2
MIN_DEPENDENCY_ITERATION = 2

_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_REVISION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}\Z")
_TOOL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_RESOURCE_CLASSES = frozenset(
    {"tool_operations", "native_processes", "tests", "sandbox_commands", "filesystem"}
)

_TOP_KEYS = frozenset(
    {
        "schema_version",
        "kind",
        "identity",
        "source_attempt",
        "authority",
        "route",
        "canonical_refs",
        "position",
        "pending_call",
        "wait",
        "eligibility",
    }
)
_IDENTITY_KEYS = frozenset(
    {"checkpoint_id", "work_id", "turn_id", "request_id", "trace_id", "session_id"}
)
_ATTEMPT_KEYS = frozenset({"attempt_id", "stream_id", "incarnation", "authority_revision"})
_AUTHORITY_KEYS = frozenset({"project_id", "root_id", "root_revision", "sha256"})
_ROUTE_KEYS = frozenset({"route_id", "route_revision", "sha256"})
_CANONICAL_KEYS = frozenset(
    {"request_ref", "message_ref", "turn_ref", "tool_batch_ref", "history_ref"}
)
_REF_KEYS = frozenset({"ref_id", "revision", "sha256"})
_TURN_REF_KEYS = frozenset({"ref_id", "revision", "sha256", "stream_id", "through_seq"})
_POSITION_KEYS = frozenset(
    {
        "completed_iterations",
        "remaining_iterations",
        "current_iteration",
        "tool_call_limit",
        "tool_calls_consumed",
        "active_budget_ms_remaining",
        "ordered_call_ids",
    }
)
_PENDING_CALL_KEYS = frozenset({"call_id", "tool_id", "effective_args_sha256", "frozen_input_ref"})
_WAIT_KEYS = frozenset({"kind", "resource_class", "dependency_id", "operation_id"})
_ELIGIBILITY_KEYS = frozenset(
    {
        "pending_call_index",
        "prior_outcome_count",
        "emitted_tool_execution_count",
        "preview_count",
        "approval_pending",
        "mutation_started",
    }
)


class ContinuationCodecError(ValueError):
    """A continuation body is malformed, unsupported, or over capacity."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _fail(code: str) -> NoReturn:
    raise ContinuationCodecError(code)


def _record(value: Any, keys: frozenset[str], name: str) -> dict[str, Any]:
    if not isinstance(value, Mapping) or isinstance(value, (str, bytes, bytearray)):
        _fail(f"invalid_{name}")
    if any(not isinstance(key, str) for key in value) or set(value.keys()) != keys:
        _fail(f"invalid_{name}_keys")
    return dict(value)


def _id(value: Any, name: str, *, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or _ID.fullmatch(value) is None:
        _fail(f"invalid_{name}")
    return value


def _digest(value: Any, name: str) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        _fail(f"invalid_{name}")
    return value


def _integer(value: Any, name: str, *, minimum: int = 0, maximum: int = MAX_SAFE_INTEGER) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        _fail(f"invalid_{name}")
    return value


def _reference(value: Any, name: str, *, turn: bool = False) -> dict[str, Any]:
    ref = _record(value, _TURN_REF_KEYS if turn else _REF_KEYS, name)
    normalized = {
        "ref_id": _id(ref["ref_id"], f"{name}_ref_id"),
        "revision": _integer(ref["revision"], f"{name}_revision"),
        "sha256": _digest(ref["sha256"], f"{name}_sha256"),
    }
    if turn:
        normalized.update(
            stream_id=_id(ref["stream_id"], f"{name}_stream_id"),
            through_seq=_integer(ref["through_seq"], f"{name}_through_seq"),
        )
    return normalized


def _normalize_identity(value: Any) -> dict[str, Any]:
    identity = _record(value, _IDENTITY_KEYS, "identity")
    return {
        key: _id(identity[key], f"identity_{key}", nullable=key == "trace_id")
        for key in _IDENTITY_KEYS
    }


def _normalize_attempt(value: Any) -> dict[str, Any]:
    attempt = _record(value, _ATTEMPT_KEYS, "source_attempt")
    return {key: _id(attempt[key], f"source_attempt_{key}") for key in _ATTEMPT_KEYS}


def _normalize_authority(value: Any) -> dict[str, Any]:
    authority = _record(value, _AUTHORITY_KEYS, "authority")
    return {
        "project_id": _id(authority["project_id"], "authority_project_id"),
        "root_id": _id(authority["root_id"], "authority_root_id", nullable=True),
        "root_revision": _integer(authority["root_revision"], "authority_root_revision"),
        "sha256": _digest(authority["sha256"], "authority_sha256"),
    }


def _normalize_route(value: Any) -> dict[str, Any]:
    route = _record(value, _ROUTE_KEYS, "route")
    route_revision = route["route_revision"]
    if not isinstance(route_revision, str) or _REVISION.fullmatch(route_revision) is None:
        _fail("invalid_route_revision")
    return {
        "route_id": _id(route["route_id"], "route_id"),
        "route_revision": route_revision,
        "sha256": _digest(route["sha256"], "route_sha256"),
    }


def normalize_continuation_context_fields(
    *,
    work_id: Any,
    turn_id: Any,
    source_attempt: Any,
    authority: Any,
    route: Any,
) -> dict[str, Any]:
    """Normalize the identity references shared by continuation wire objects."""

    return {
        "work_id": _id(work_id, "identity_work_id"),
        "turn_id": _id(turn_id, "identity_turn_id"),
        "source_attempt": _normalize_attempt(source_attempt),
        "authority": _normalize_authority(authority),
        "route": _normalize_route(route),
    }


def _normalize_canonical_refs(value: Any) -> dict[str, Any]:
    canonical = _record(value, _CANONICAL_KEYS, "canonical_refs")
    return {
        "request_ref": _reference(canonical["request_ref"], "request_ref"),
        "message_ref": _reference(canonical["message_ref"], "message_ref"),
        "turn_ref": _reference(canonical["turn_ref"], "turn_ref", turn=True),
        "tool_batch_ref": _reference(canonical["tool_batch_ref"], "tool_batch_ref"),
        "history_ref": _reference(canonical["history_ref"], "history_ref"),
    }


def _normalize_position(
    value: Any, completed_spawns: int = 0, *, decision: bool = False,
) -> dict[str, Any]:
    position = _record(value, _POSITION_KEYS, "position")
    completed = _integer(
        position["completed_iterations"],
        "completed_iterations",
        minimum=1,
        maximum=MAX_CONTINUATION_ITERATIONS,
    )
    remaining = _integer(
        position["remaining_iterations"],
        "remaining_iterations",
        maximum=MAX_CONTINUATION_ITERATIONS,
    )
    current = _integer(
        position["current_iteration"],
        "current_iteration",
        minimum=1,
        maximum=MAX_CONTINUATION_ITERATIONS,
    )
    if current != completed or completed + remaining > MAX_CONTINUATION_ITERATIONS:
        _fail("invalid_iteration_position")
    call_limit = _integer(
        position["tool_call_limit"],
        "tool_call_limit",
        minimum=1,
        maximum=MAX_CONTINUATION_TOOL_CALLS,
    )
    consumed = _integer(
        position["tool_calls_consumed"],
        "tool_calls_consumed",
        minimum=1,
        maximum=call_limit,
    )
    budget = position["active_budget_ms_remaining"]
    if budget is not None:
        budget = _integer(budget, "active_budget_ms_remaining", maximum=MAX_ACTIVE_BUDGET_MS)
    call_ids = position["ordered_call_ids"]
    if not isinstance(call_ids, list) or not 1 <= len(call_ids) <= MAX_CONTINUATION_TOOL_CALLS:
        _fail("invalid_ordered_call_ids")
    normalized_call_ids = [_id(item, "ordered_call_id") for item in call_ids]
    # Admission reserves the pending batch; dependency checkpoints additionally
    # retain the call count of their explicitly referenced completed spawns.
    if (
        len(set(normalized_call_ids)) != len(normalized_call_ids)
        or (not len(call_ids) <= consumed <= len(call_ids) + completed_spawns
            if decision else len(call_ids) + completed_spawns != consumed)
    ):
        _fail("invalid_ordered_call_ids")
    return {
        "completed_iterations": completed,
        "remaining_iterations": remaining,
        "current_iteration": current,
        "tool_call_limit": call_limit,
        "tool_calls_consumed": consumed,
        "active_budget_ms_remaining": budget,
        "ordered_call_ids": normalized_call_ids,
    }


def _normalize_pending_call(value: Any, first_call_id: str | None) -> dict[str, Any]:
    pending = _record(value, _PENDING_CALL_KEYS, "pending_call")
    tool_id = pending["tool_id"]
    if not isinstance(tool_id, str) or _TOOL_ID.fullmatch(tool_id) is None:
        _fail("invalid_pending_tool_id")
    normalized = {
        "call_id": _id(pending["call_id"], "pending_call_id"),
        "tool_id": tool_id,
        "effective_args_sha256": _digest(pending["effective_args_sha256"], "effective_args_sha256"),
        "frozen_input_ref": _reference(pending["frozen_input_ref"], "frozen_input_ref"),
    }
    if normalized["call_id"] != first_call_id:
        _fail("unsupported_later_call_continuation")
    return normalized


def _normalize_wait(value: Any, call_id: str | None, spawns: list | None = None) -> dict[str, Any]:
    wait = _record(value, _WAIT_KEYS, "wait")
    if spawns is not None:
        if (
            wait["kind"] != "dependency"
            or wait["resource_class"] is not None
            or not any(ref["child_work_id"] == wait["dependency_id"] for ref in spawns)
            or wait["operation_id"] != call_id
        ):
            _fail("unsupported_dependency_wait")
        return wait
    explicit_pause = (
        wait["kind"] == "explicit_pause"
        and wait["resource_class"] is None
        and wait["dependency_id"] is None
    )
    if not explicit_pause and (
        wait["kind"] != "resource"
        or not isinstance(wait["resource_class"], str)
        or wait["resource_class"] not in _RESOURCE_CLASSES
    ):
        _fail("unsupported_continuation_wait")
    normalized = {
        "kind": wait["kind"],
        "resource_class": wait["resource_class"],
        "dependency_id": _id(wait["dependency_id"], "wait_dependency_id", nullable=True),
        "operation_id": _id(wait["operation_id"], "wait_operation_id"),
    }
    if normalized["operation_id"] != call_id:
        _fail("operation_call_identity_mismatch")
    return normalized


def _normalize_eligibility(
    value: Any, completed_spawns: int = 0, *, decision_started: bool | None = None,
) -> dict[str, Any]:
    eligibility = _record(value, _ELIGIBILITY_KEYS, "eligibility")
    zero_fields = ("pending_call_index", "preview_count")
    emitted = completed_spawns
    if decision_started is not None:
        started = int(decision_started)
        emitted = _integer(
            eligibility["emitted_tool_execution_count"], "emitted_tool_execution_count",
            minimum=started, maximum=completed_spawns + started,
        )
    expected = {"prior_outcome_count": completed_spawns, "emitted_tool_execution_count": emitted}
    if (
        any(isinstance(eligibility[key], bool) or eligibility[key] != 0 for key in zero_fields)
        or any(
            isinstance(eligibility[key], bool) or eligibility[key] != count
            for key, count in expected.items()
        )
        or eligibility["approval_pending"] is not False
        or eligibility["mutation_started"] is not False
    ):
        _fail("unsupported_continuation_state")
    return {
        "pending_call_index": 0,
        "prior_outcome_count": completed_spawns,
        "emitted_tool_execution_count": emitted,
        "preview_count": 0,
        "approval_pending": False,
        "mutation_started": False,
    }


def _normalize_completed_spawns(value: Any, *, waits: bool = False) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not 1 <= len(value) < MAX_CONTINUATION_TOOL_CALLS:
        _fail("invalid_completed_spawn_refs")
    refs = []
    for item in value:
        ref = _record(
            item, frozenset({"call_id", "child_work_id", "result_sha256"}), "completed_spawn_ref"
        )
        refs.append(
            {
                "call_id": _id(ref["call_id"], "spawn_call_id"),
                "child_work_id": _id(ref["child_work_id"], "spawn_child_work_id"),
                "result_sha256": _digest(ref["result_sha256"], "spawn_result_sha256"),
            }
        )
    if len({ref["call_id"] for ref in refs}) != len(refs) or (
        not waits and len({ref["child_work_id"] for ref in refs}) != len(refs)
    ):
        _fail("invalid_completed_spawn_refs")
    return refs


def _validate_dependency_position(
    refs: list,
    identity: dict,
    position: dict,
    pending: dict,
) -> None:
    if (
        pending["tool_id"] != "session_wait"
        or len(position["ordered_call_ids"]) != 1
        or position["current_iteration"] < MIN_DEPENDENCY_ITERATION
        or any(
            ref["call_id"] == pending["call_id"] or ref["child_work_id"] == identity["work_id"]
            for ref in refs
        )
    ):
        _fail("unsupported_dependency_position")


def _normalize_predecessor(value: Any) -> dict[str, Any]:
    ref = _record(
        value,
        frozenset({"schema_version", "checkpoint_id", "sha256", "bytes", "source_attempt"}),
        "prior_checkpoint_ref",
    )
    if isinstance(ref["schema_version"], bool) or ref["schema_version"] != 1:
        _fail("invalid_dependency_predecessor")
    return {
        "schema_version": 1,
        "checkpoint_id": _id(ref["checkpoint_id"], "prior_checkpoint_id"),
        "sha256": _digest(ref["sha256"], "prior_checkpoint_sha256"),
        "bytes": _integer(
            ref["bytes"], "prior_checkpoint_bytes", minimum=2, maximum=MAX_CONTINUATION_BODY_BYTES
        ),
        "source_attempt": _normalize_attempt(ref["source_attempt"]),
    }
