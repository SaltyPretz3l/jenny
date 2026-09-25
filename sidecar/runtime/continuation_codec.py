"""Canonical codecs for application-owned runtime continuation checkpoints.

Shape validation does not establish persistence, consent or physical cleanup.
Those proofs remain with the application owners.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Mapping

from sidecar.ai.routing.tool_quota_state import normalize_quota_state
from sidecar.runtime.continuation_codec_fields import (
    _ELIGIBILITY_KEYS,
    _TOOL_ID,
    _TOP_KEYS,
    MAX_CONTINUATION_BODY_BYTES,
    MAX_CONTINUATION_TOOL_CALLS,
    MIN_CONTINUATION_BODY_BYTES,
    SESSION_RUNTIME_CONTINUATION_KIND,
    SESSION_RUNTIME_CONTINUATION_SCHEMA_VERSION,
    SESSION_RUNTIME_DECISION_KIND,
    SESSION_RUNTIME_DEPENDENCY_KIND,
    ContinuationCodecError,
    _digest,
    _fail,
    _id,
    _integer,
    _normalize_canonical_refs,
    _normalize_completed_spawns,
    _normalize_eligibility,
    _normalize_identity,
    _normalize_pending_call,
    _normalize_position,
    _normalize_predecessor,
    _normalize_wait,
    _record,
    _reference,
    _validate_dependency_position,
    normalize_continuation_context_fields,
)

_APPROVAL_BUNDLE_VERSION = 4
_MIXED_DEPENDENCY_VERSION = 5
_MUTATION_DECISION_VERSION = 6
_QUOTA_VERSION = 7
_RESOURCE_PROGRESS_VERSION = 8

_REPEATED_DEPENDENCY_VERSION = 2
_DECISION_VERSION = 3


@dataclass(frozen=True)
class EncodedContinuation:
    body: bytes
    sha256: str


def _normalize_decision(value: Any) -> dict[str, Any]:
    decision = _record(
        value, frozenset({"call_id", "decision_id", "execution_started", "kind"}), "decision"
    )
    if (
        decision["kind"] not in ("approval", "user_questions")
        or not isinstance(decision["execution_started"], bool)
        or decision["execution_started"] != (decision["kind"] == "user_questions")
    ):
        _fail("invalid_decision")
    return {
        "kind": decision["kind"],
        "decision_id": _id(decision["decision_id"], "decision_id"),
        "call_id": _id(decision["call_id"], "decision_call_id"),
        "execution_started": decision["execution_started"],
    }


def _normalize_completed_effects(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) >= MAX_CONTINUATION_TOOL_CALLS:
        _fail("invalid_completed_effect_refs")
    refs = []
    for item in value:
        ref = _record(
            item,
            frozenset({"call_id", "tool_id", "result_sha256", "success"}),
            "completed_effect_ref",
        )
        if (
            not isinstance(ref["success"], bool)
            or not isinstance(ref["tool_id"], str)
            or _TOOL_ID.fullmatch(ref["tool_id"]) is None
        ):
            _fail("invalid_completed_effect_ref")
        refs.append(
            {
                "call_id": _id(ref["call_id"], "effect_call_id"),
                "tool_id": ref["tool_id"],
                "result_sha256": _digest(ref["result_sha256"], "effect_result_sha256"),
                "success": ref["success"],
            }
        )
    if len({ref["call_id"] for ref in refs}) != len(refs):
        _fail("invalid_completed_effect_refs")
    return refs


def _validate_decision_position(
    decision: dict,
    effects: list,
    position: dict,
    pending: dict,
    wait: dict,
) -> None:
    if (
        decision["call_id"] not in position["ordered_call_ids"]
        or any(ref["call_id"] in position["ordered_call_ids"] for ref in effects)
        or (decision["execution_started"] and decision["call_id"] != pending["call_id"])
        or (decision["kind"] == "user_questions" and pending["tool_id"] != "ask_user")
        or wait["kind"] != "explicit_pause"
    ):
        _fail("invalid_decision_position")


def _validate_mixed_effects(body: dict, spawns: list, waits: list, effects: list) -> None:
    if body["prior_checkpoint_ref"] is None and body["prior_effect_count"] != 0:
        _fail("invalid_mixed_dependency_effects")
    if any(ref["call_id"] in body["position"]["ordered_call_ids"] for ref in effects):
        _fail("invalid_mixed_dependency_effects")
    refs = [*spawns, *waits]
    if (
        len({ref["call_id"] for ref in refs}) != len(refs)
        or any(
            ref["child_work_id"] not in {spawn["child_work_id"] for spawn in (spawns or [])}
            for ref in waits
        )
        or any(
            not any(
                effect["call_id"] == ref["call_id"]
                and effect["success"]
                and effect["tool_id"] == tool
                for effect in effects
            )
            for tool, group in (("session_spawn", spawns), ("session_wait", waits))
            for ref in group
        )
    ):
        _fail("invalid_mixed_dependency_effects")


def normalize_mutation_ref(value: Any) -> dict[str, Any]:
    ref = _record(
        value,
        frozenset(
            {
                "schema_version",
                "workspace_id",
                "change_set_id",
                "operation_count",
                "operations_sha256",
            }
        ),
        "mutation_ref",
    )
    if (
        type(ref["schema_version"]) is not int
        or ref["schema_version"] != 1
        or not isinstance(ref["workspace_id"], str)
        or re.fullmatch(r"ws_[a-f0-9]{32}", ref["workspace_id"]) is None
        or not isinstance(ref["change_set_id"], str)
        or re.fullmatch(
            r"[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}",
            ref["change_set_id"],
        )
        is None
    ):
        _fail("invalid_mutation_ref")
    return {
        "schema_version": 1,
        "workspace_id": ref["workspace_id"],
        "change_set_id": ref["change_set_id"],
        "operation_count": _integer(
            ref["operation_count"], "mutation_operation_count", minimum=1, maximum=10_000
        ),
        "operations_sha256": _digest(ref["operations_sha256"], "mutation_operations_sha256"),
    }


def _variant(value: Any) -> tuple[dict, bool, bool, bool, bool, bool]:
    dependency = isinstance(value, Mapping) and value.get("kind") == SESSION_RUNTIME_DEPENDENCY_KIND
    decision_kind = (
        isinstance(value, Mapping) and value.get("kind") == SESSION_RUNTIME_DECISION_KIND
    )
    decision_version = decision_kind and value.get("schema_version") in (
        _DECISION_VERSION,
        4,
        _MUTATION_DECISION_VERSION,
    )
    repeated = dependency and value.get("schema_version") == _REPEATED_DEPENDENCY_VERSION
    mixed = dependency and value.get("schema_version") == _MIXED_DEPENDENCY_VERSION
    resource = (
        value.get("kind") == SESSION_RUNTIME_CONTINUATION_KIND
        and value.get("schema_version") == _RESOURCE_PROGRESS_VERSION
    )
    keys = _TOP_KEYS | {"completed_spawn_refs"} if dependency else _TOP_KEYS
    if repeated or mixed:
        keys |= {"completed_wait_refs", "prior_checkpoint_ref", "prior_effect_count"}
    if mixed:
        keys |= {"completed_effect_refs"}
    if resource:
        keys |= {"completed_effect_refs", "prior_checkpoint_ref", "prior_effect_count"}
    if decision_kind:
        keys |= {"decision", "completed_effect_refs", "prior_checkpoint_ref", "prior_effect_count"}
    if decision_kind and value.get("schema_version") in (4, _MUTATION_DECISION_VERSION):
        keys |= {"approval_inputs_ref"}
    if decision_kind and value.get("schema_version") == _MUTATION_DECISION_VERSION:
        keys |= {"mutation_ref"}
    body = _record(value, keys, "continuation")
    if isinstance(body["schema_version"], bool) or (
        body["schema_version"] != SESSION_RUNTIME_CONTINUATION_SCHEMA_VERSION
        and not repeated
        and not decision_version
        and not mixed
        and not resource
    ):
        _fail("unsupported_continuation_schema_version")
    if (
        body["kind"] != SESSION_RUNTIME_CONTINUATION_KIND
        and not dependency
        and not decision_version
    ):
        _fail("unsupported_continuation_kind")

    return body, dependency, repeated, decision_kind, mixed, resource


def _normalize_quota_wrapper(value: Mapping) -> dict[str, Any]:
    base = value.get("base_schema_version")
    if type(base) is not int or base not in (1, 2, 3, 4, 5, 6, _RESOURCE_PROGRESS_VERSION):
        _fail("invalid_quota_base_version")
    body = {
        key: item
        for key, item in value.items()
        if key not in {"base_schema_version", "quota_state"}
    }
    normalized = _normalize({**body, "schema_version": base})
    try:
        quota = normalize_quota_state(value.get("quota_state"))
    except ValueError:
        _fail("quota_state_invalid")
    return {
        **normalized,
        "schema_version": _QUOTA_VERSION,
        "base_schema_version": base,
        "quota_state": quota,
    }


def _normalize(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping) and value.get("schema_version") == _QUOTA_VERSION:
        return _normalize_quota_wrapper(value)
    return _normalize_base(value)


def _validate_resource_position(resource, effects, position, predecessor, prior_count, *, wait):  # noqa: PLR0913
    if resource and (
        not effects
        or any(ref["call_id"] in position["ordered_call_ids"] for ref in effects)
        or (predecessor is None and prior_count != 0)
        or wait["kind"] != "resource"
    ):
        _fail("invalid_resource_progress")


def _normalize_base(value: Any) -> dict[str, Any]:
    body, dependency, repeated, decision_kind, mixed, resource = _variant(value)

    spawns = _normalize_completed_spawns(body["completed_spawn_refs"]) if dependency else None
    waits = (
        _normalize_completed_spawns(body["completed_wait_refs"], waits=True)
        if repeated or (mixed and body["completed_wait_refs"])
        else []
    )
    if mixed and not isinstance(body["completed_wait_refs"], list):
        _fail("invalid_completed_spawn_refs")
    decision = _normalize_decision(body["decision"]) if decision_kind else None
    mutation = body["schema_version"] == _MUTATION_DECISION_VERSION
    if (
        body["schema_version"] == _APPROVAL_BUNDLE_VERSION
        or (mutation and body["approval_inputs_ref"] is not None)
    ) and (not decision or decision["kind"] != "approval"):
        _fail("invalid_approval_inputs_kind")
    approval_inputs_ref = (
        _reference(body["approval_inputs_ref"], "approval_inputs_ref")
        if body["schema_version"] == _APPROVAL_BUNDLE_VERSION
        or (mutation and body["approval_inputs_ref"] is not None)
        else None
    )
    effects = (
        _normalize_completed_effects(body["completed_effect_refs"])
        if decision_kind or mixed or resource
        else []
    )
    child_refs = [*(spawns or []), *waits]
    all_refs = effects if mixed else [*child_refs, *effects]
    spawn_count = len(all_refs)
    prior_count = (
        _integer(
            body["prior_effect_count"], "prior_effect_count", minimum=1, maximum=spawn_count - 1
        )
        if repeated
        else 0
    )
    if decision_kind or mixed or resource:
        prior_count = _integer(
            body["prior_effect_count"], "prior_effect_count", maximum=len(effects)
        )
    predecessor = (
        _normalize_predecessor(body["prior_checkpoint_ref"])
        if repeated
        or ((decision_kind or mixed or resource) and body["prior_checkpoint_ref"] is not None)
        else None
    )
    if repeated and (
        len({ref["call_id"] for ref in all_refs}) != spawn_count
        or any(
            ref["child_work_id"] not in {spawn["child_work_id"] for spawn in (spawns or [])}
            for ref in waits
        )
    ):
        _fail("invalid_dependency_predecessor")
    if mixed:
        _validate_mixed_effects(body, spawns or [], waits, effects)
    normalized_identity = _normalize_identity(body["identity"])
    shared = normalize_continuation_context_fields(
        work_id=normalized_identity["work_id"],
        turn_id=normalized_identity["turn_id"],
        source_attempt=body["source_attempt"],
        authority=body["authority"],
        route=body["route"],
    )
    normalized_attempt = shared["source_attempt"]
    if normalized_identity["request_id"] != normalized_attempt["stream_id"]:
        _fail("request_stream_identity_mismatch")
    if predecessor and (
        predecessor["checkpoint_id"] == normalized_identity["checkpoint_id"]
        or predecessor["source_attempt"]["stream_id"] == normalized_attempt["stream_id"]
        or predecessor["source_attempt"]["attempt_id"] == normalized_attempt["attempt_id"]
    ):
        _fail("invalid_dependency_predecessor")
    normalized_canonical = _normalize_canonical_refs(body["canonical_refs"])
    if normalized_canonical["turn_ref"]["stream_id"] != normalized_attempt["stream_id"]:
        _fail("turn_ref_stream_mismatch")
    normalized_position = _normalize_position(
        body["position"], spawn_count, decision=decision_kind or mixed or resource
    )
    normalized_pending = _normalize_pending_call(
        body["pending_call"], normalized_position["ordered_call_ids"][0]
    )

    normalized_wait = _normalize_wait(body["wait"], normalized_pending["call_id"], spawns)
    eligibility_input = _record(body["eligibility"], _ELIGIBILITY_KEYS, "eligibility")
    if decision:
        if predecessor is None and prior_count != 0:
            _fail("invalid_decision_position")
        _validate_decision_position(
            decision,
            effects,
            normalized_position,
            normalized_pending,
            normalized_wait,
        )
    normalized_eligibility = _normalize_eligibility(
        eligibility_input,
        spawn_count - prior_count,
        decision_started=decision["execution_started"]
        if decision
        else (False if mixed or resource else None),
    )
    _validate_resource_position(
        resource, effects, normalized_position, predecessor, prior_count, wait=normalized_wait
    )
    if spawns is not None:
        _validate_dependency_position(
            child_refs,
            normalized_identity,
            normalized_position,
            normalized_pending,
        )
    return {
        "schema_version": body["schema_version"],
        **({"completed_effect_refs": effects} if mixed else {}),
        **(
            {
                "completed_effect_refs": effects,
                "prior_checkpoint_ref": predecessor,
                "prior_effect_count": prior_count,
            }
            if resource
            else {}
        ),
        **({"approval_inputs_ref": approval_inputs_ref} if approval_inputs_ref or mutation else {}),
        **({"mutation_ref": normalize_mutation_ref(body["mutation_ref"])} if mutation else {}),
        "kind": body["kind"],
        **(
            {
                "decision": decision,
                "completed_effect_refs": effects,
                "prior_checkpoint_ref": predecessor,
                "prior_effect_count": prior_count,
            }
            if decision
            else {}
        ),
        **(
            {
                "completed_wait_refs": waits,
                "prior_checkpoint_ref": predecessor,
                "prior_effect_count": prior_count,
            }
            if repeated or mixed
            else {}
        ),
        **({"completed_spawn_refs": spawns} if spawns is not None else {}),
        "identity": normalized_identity,
        "source_attempt": normalized_attempt,
        "authority": shared["authority"],
        "route": shared["route"],
        "canonical_refs": normalized_canonical,
        "position": normalized_position,
        "pending_call": normalized_pending,
        "wait": normalized_wait,
        "eligibility": normalized_eligibility,
    }


def encode_continuation_checkpoint(value: Mapping[str, Any]) -> EncodedContinuation:
    """Validate and encode one canonical continuation body."""

    normalized = _normalize(value)
    try:
        body = json.dumps(
            normalized,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError) as error:
        raise ContinuationCodecError("invalid_continuation_encoding") from error
    if len(body) < MIN_CONTINUATION_BODY_BYTES or len(body) > MAX_CONTINUATION_BODY_BYTES:
        _fail("continuation_body_capacity")
    return EncodedContinuation(body=body, sha256=hashlib.sha256(body).hexdigest())


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("duplicate_continuation_key")
        result[key] = value
    return result


def decode_continuation_checkpoint(body: bytes) -> dict[str, Any]:
    """Decode canonical UTF-8 bytes and return a normalized plain mapping."""

    if (
        not isinstance(body, bytes)
        or not MIN_CONTINUATION_BODY_BYTES <= len(body) <= MAX_CONTINUATION_BODY_BYTES
    ):
        _fail("continuation_body_capacity")
    try:
        text = body.decode("utf-8", errors="strict")
        value = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=lambda _value: _fail("invalid_continuation_number"),
        )
    except ContinuationCodecError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ContinuationCodecError("invalid_continuation_json") from error
    normalized = _normalize(value)
    canonical = encode_continuation_checkpoint(normalized).body
    if canonical != body:
        _fail("noncanonical_continuation_body")
    return normalized


__all__ = [
    "EncodedContinuation",
    "ContinuationCodecError",
    "MAX_CONTINUATION_BODY_BYTES",
    "MAX_CONTINUATION_TOOL_CALLS",
    "SESSION_RUNTIME_CONTINUATION_KIND",
    "SESSION_RUNTIME_DEPENDENCY_KIND",
    "SESSION_RUNTIME_DECISION_KIND",
    "SESSION_RUNTIME_CONTINUATION_SCHEMA_VERSION",
    "decode_continuation_checkpoint",
    "encode_continuation_checkpoint",
    "normalize_continuation_context_fields",
]
