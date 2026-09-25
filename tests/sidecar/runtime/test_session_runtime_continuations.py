from __future__ import annotations

import copy
import hashlib
import json

import pytest

from sidecar.runtime.chat_continuation_resume import (
    ContinuationResumeError,
    HydratedBeforeToolDispatchResume,
)
from sidecar.runtime.continuation_codec import (
    MAX_CONTINUATION_BODY_BYTES,
    ContinuationCodecError,
    decode_continuation_checkpoint,
    encode_continuation_checkpoint,
)


def _ref(name: str, *, revision: int = 3) -> dict[str, object]:
    return {"ref_id": name, "revision": revision, "sha256": "a" * 64}


def _checkpoint() -> dict[str, object]:
    return {
        "schema_version": 1,
        "kind": "before_tool_dispatch",
        "identity": {
            "checkpoint_id": "checkpoint_1",
            "work_id": "work_1",
            "turn_id": "turn_1",
            "request_id": "stream_1",
            "trace_id": None,
            "session_id": "session_1",
        },
        "source_attempt": {
            "attempt_id": "attempt_1",
            "stream_id": "stream_1",
            "incarnation": "incarnation_1",
            "authority_revision": "authority_1",
        },
        "authority": {
            "project_id": "project_1",
            "root_id": "root_1",
            "root_revision": 4,
            "sha256": "b" * 64,
        },
        "route": {
            "route_id": "route_1",
            "route_revision": "config:4",
            "sha256": "c" * 64,
        },
        "canonical_refs": {
            "request_ref": _ref("request_ref_1"),
            "message_ref": _ref("message_ref_1"),
            "turn_ref": {
                **_ref("turn_ref_1", revision=8),
                "stream_id": "stream_1",
                "through_seq": 12,
            },
            "tool_batch_ref": _ref("tool_batch_ref_1"),
            "history_ref": _ref("history_ref_1"),
        },
        "position": {
            "completed_iterations": 1,
            "remaining_iterations": 7,
            "current_iteration": 1,
            "tool_call_limit": 20,
            "tool_calls_consumed": 2,
            "active_budget_ms_remaining": 123_456,
            "ordered_call_ids": ["call_1", "call_2"],
        },
        "pending_call": {
            "call_id": "call_1",
            "tool_id": "builtin:run/tool",
            "effective_args_sha256": "d" * 64,
            "frozen_input_ref": _ref("frozen_input_ref_1"),
        },
        "wait": {
            "kind": "resource",
            "resource_class": "native_processes",
            "dependency_id": None,
            "operation_id": "call_1",
        },
        "eligibility": {
            "pending_call_index": 0,
            "prior_outcome_count": 0,
            "emitted_tool_execution_count": 0,
            "preview_count": 0,
            "approval_pending": False,
            "mutation_started": False,
        },
    }


def _assert_error(value: object, code: str) -> None:
    with pytest.raises(ContinuationCodecError) as exc_info:
        encode_continuation_checkpoint(value)  # type: ignore[arg-type]
    assert exc_info.value.code == code


def test_round_trip_is_canonical_deterministic_and_fresh() -> None:
    source = _checkpoint()
    reordered = {key: source[key] for key in reversed(source)}

    first = encode_continuation_checkpoint(source)
    second = encode_continuation_checkpoint(reordered)
    decoded = decode_continuation_checkpoint(first.body)

    assert first == second
    assert first.sha256 == hashlib.sha256(first.body).hexdigest()
    assert len(first.body) <= MAX_CONTINUATION_BODY_BYTES
    assert decoded == source
    assert decoded is not source
    assert decoded["identity"] is not source["identity"]
    assert decoded["route"]["route_revision"] == "config:4"  # type: ignore[index]
    assert decoded["wait"]["dependency_id"] is None  # type: ignore[index]


def test_application_owned_references_are_validated_but_not_claimed_as_proof() -> None:
    value = _checkpoint()
    canonical = value["canonical_refs"]
    assert isinstance(canonical, dict)
    canonical["request_ref"] = _ref("opaque_unresolved_ref", revision=999)
    canonical["history_ref"] = _ref("opaque_history_ref", revision=41)

    decoded = decode_continuation_checkpoint(encode_continuation_checkpoint(value).body)

    assert decoded["canonical_refs"]["request_ref"]["ref_id"] == "opaque_unresolved_ref"
    assert decoded["canonical_refs"]["history_ref"] == _ref(
        "opaque_history_ref", revision=41
    )


@pytest.mark.parametrize(
    ("mutate", "code"),
    [
        (lambda value: value.update(schema_version=2), "unsupported_continuation_schema_version"),
        (lambda value: value.update(schema_version=True), "unsupported_continuation_schema_version"),
        (lambda value: value.update(kind="after_tool_dispatch"), "unsupported_continuation_kind"),
        (
            lambda value: value["identity"].update(request_id="other_stream"),
            "request_stream_identity_mismatch",
        ),
        (
            lambda value: value["canonical_refs"]["turn_ref"].update(stream_id="other_stream"),
            "turn_ref_stream_mismatch",
        ),
        (
            lambda value: value["wait"].update(operation_id="call_2"),
            "operation_call_identity_mismatch",
        ),
        (
            lambda value: value["pending_call"].update(call_id="call_2"),
            "unsupported_later_call_continuation",
        ),
        (
            lambda value: value["position"].update(tool_calls_consumed=1),
            "invalid_ordered_call_ids",
        ),
        (
            lambda value: value["position"].update(current_iteration=2),
            "invalid_iteration_position",
        ),
        (
            lambda value: value["position"].update(active_budget_ms_remaining=1.5),
            "invalid_active_budget_ms_remaining",
        ),
        (
            lambda value: value["route"].update(route_revision="bad revision"),
            "invalid_route_revision",
        ),
        (
            lambda value: value["identity"].update(work_id="bad:id"),
            "invalid_identity_work_id",
        ),
        (
            lambda value: value["authority"].update(sha256="A" * 64),
            "invalid_authority_sha256",
        ),
    ],
)
def test_identity_position_and_digest_constraints_are_strict(mutate, code: str) -> None:
    value = _checkpoint()
    mutate(value)
    _assert_error(value, code)


@pytest.mark.parametrize(
    ("field", "unsupported_value"),
    [
        ("pending_call_index", 1),
        ("prior_outcome_count", 1),
        ("emitted_tool_execution_count", 1),
        ("preview_count", 1),
        ("approval_pending", True),
        ("mutation_started", True),
        ("prior_outcome_count", False),
        ("approval_pending", 0),
    ],
)
def test_general_resume_states_are_explicitly_refused(field: str, unsupported_value: object) -> None:
    value = _checkpoint()
    eligibility = value["eligibility"]
    assert isinstance(eligibility, dict)
    eligibility[field] = unsupported_value

    _assert_error(value, "unsupported_continuation_state")


@pytest.mark.parametrize(
    "forbidden_key",
    ["preview_bytes", "credentials", "cancel_handle", "provider_cache", "wall_clock_deadline"],
)
def test_forbidden_or_unversioned_payload_fields_are_refused(forbidden_key: str) -> None:
    value = _checkpoint()
    value[forbidden_key] = "secret-or-handle"

    _assert_error(value, "invalid_continuation_keys")


def test_nested_extra_and_missing_keys_are_refused() -> None:
    extra = _checkpoint()
    extra["pending_call"]["arguments"] = {"token": "secret"}  # type: ignore[index]
    _assert_error(extra, "invalid_pending_call_keys")

    missing = _checkpoint()
    del missing["canonical_refs"]["message_ref"]  # type: ignore[index]
    _assert_error(missing, "invalid_canonical_refs_keys")


def test_duplicate_noncanonical_and_invalid_utf8_bodies_are_refused() -> None:
    encoded = encode_continuation_checkpoint(_checkpoint()).body
    duplicate = encoded.replace(
        b'"kind":"before_tool_dispatch",',
        b'"kind":"before_tool_dispatch","kind":"before_tool_dispatch",',
        1,
    )
    with pytest.raises(ContinuationCodecError, match="duplicate_continuation_key"):
        decode_continuation_checkpoint(duplicate)

    parsed = json.loads(encoded)
    spaced = json.dumps(parsed, sort_keys=True).encode("utf-8")
    with pytest.raises(ContinuationCodecError, match="noncanonical_continuation_body"):
        decode_continuation_checkpoint(spaced)

    with pytest.raises(ContinuationCodecError, match="invalid_continuation_json"):
        decode_continuation_checkpoint(b'{"schema_version":1,"kind":"\xff"}')


@pytest.mark.parametrize(
    "body",
    [b"", b"{", bytearray(b"{}")],
)
def test_decode_requires_bounded_bytes(body: object) -> None:
    with pytest.raises(ContinuationCodecError, match="continuation_body_capacity"):
        decode_continuation_checkpoint(body)  # type: ignore[arg-type]


def test_decode_refuses_oversized_body_before_parsing() -> None:
    body = b"x" * (MAX_CONTINUATION_BODY_BYTES + 1)

    with pytest.raises(ContinuationCodecError, match="continuation_body_capacity"):
        decode_continuation_checkpoint(body)


def test_input_is_not_mutated() -> None:
    value = _checkpoint()
    before = copy.deepcopy(value)

    encode_continuation_checkpoint(value)

    assert value == before



def _dependency_checkpoint():
    value = _checkpoint()
    value["kind"] = "before_dependency_wait"
    value["completed_spawn_refs"] = [{"call_id": "spawn_1", "child_work_id": "child_work_1", "result_sha256": "e" * 64}]
    value["position"].update(current_iteration=2, completed_iterations=2, remaining_iterations=6,
                             ordered_call_ids=["call_1"], tool_calls_consumed=2)
    value["pending_call"]["tool_id"] = "session_wait"
    value["wait"].update(kind="dependency", resource_class=None, dependency_id="child_work_1")
    value["eligibility"].update(prior_outcome_count=1, emitted_tool_execution_count=1)
    return value


def test_dependency_codec_keeps_prior_spawn_count_and_first_tool_rules():
    value = _dependency_checkpoint()
    assert decode_continuation_checkpoint(encode_continuation_checkpoint(value).body) == value
    legacy = _checkpoint()
    legacy["eligibility"]["prior_outcome_count"] = 1
    _assert_error(legacy, "unsupported_continuation_state")
    legacy["eligibility"]["prior_outcome_count"] = 0
    legacy["completed_spawn_refs"] = value["completed_spawn_refs"]
    _assert_error(legacy, "invalid_continuation_keys")


@pytest.mark.parametrize("section,key,replacement", [
    ("wait", "dependency_id", "foreign"),
    ("wait", "kind", "resource"),
    ("wait", "resource_class", "tool_operations"),
    ("wait", "operation_id", "other"),
    ("pending_call", "tool_id", "run_command"),
    ("position", "tool_calls_consumed", 1),
    ("position", "ordered_call_ids", ["call_1", "call_2"]),
    ("eligibility", "prior_outcome_count", 0),
    ("eligibility", "prior_outcome_count", True),
    ("eligibility", "emitted_tool_execution_count", 0),
    ("eligibility", "preview_count", 1),
    ("eligibility", "approval_pending", True),
    ("eligibility", "mutation_started", True),
])
def test_dependency_codec_rejects_unsupported_state(section, key, replacement):
    value = _dependency_checkpoint()
    value[section][key] = replacement
    with pytest.raises(ContinuationCodecError):
        encode_continuation_checkpoint(value)


@pytest.mark.parametrize("replacement", [[], [{"call_id": "bad"}],
    [{"call_id": "call_1", "child_work_id": "child_work_1", "result_sha256": "e" * 64}],
    [{"call_id": "spawn_1", "child_work_id": "work_1", "result_sha256": "e" * 64}],
])
def test_dependency_codec_rejects_missing_or_unsafe_spawn_reference(replacement):
    value = _dependency_checkpoint()
    value["completed_spawn_refs"] = replacement
    with pytest.raises(ContinuationCodecError):
        encode_continuation_checkpoint(value)


def test_first_tool_executor_refuses_dependency_boundary_before_artifact_hydration():
    encoded = encode_continuation_checkpoint(_dependency_checkpoint())
    with pytest.raises(ContinuationResumeError, match="continuation_resume_boundary_unsupported"):
        HydratedBeforeToolDispatchResume.from_artifacts(
            checkpoint_body=encoded.body, checkpoint_sha256=encoded.sha256,
            checkpoint_ref={}, resolved_source_attempt={}, tool_batch_bytes=b"{}",
            tool_batch_sha256="a" * 64, frozen_input_bytes=b"{}", frozen_input_sha256="a" * 64,
        )
