from __future__ import annotations

import copy
from dataclasses import FrozenInstanceError

import pytest

from sidecar.runtime.continuation_context import (
    MAX_CONTINUATION_CONTEXT_BYTES,
    ContinuationContextError,
    continuation_context_from_params,
)
from sidecar.runtime.execution_context import execution_context_from_params


def _execution_context():
    context = execution_context_from_params(
        {
            "execution_context": {
                "schema_version": 1,
                "authority_revision": "authority_1",
                "project_id": "project_1",
                "root_path": None,
                "root_id": None,
                "root_revision": 0,
                "device_id": None,
                "inode": None,
                "tool_policy_snapshot": {"version": 3, "legacy_policies": {}},
                "knowledge_roots": [],
            }
        }
    )
    assert context is not None
    return context


def _context() -> dict[str, object]:
    return {
        "schema_version": 1,
        "work_id": "work_1",
        "turn_id": "turn_1",
        "source_attempt": {
            "attempt_id": "attempt_1",
            "stream_id": "stream_1",
            "incarnation": "incarnation_1",
            "authority_revision": "authority_1",
        },
        "authority": {
            "project_id": "project_1",
            "root_id": None,
            "root_revision": 0,
            "sha256": "a" * 64,
        },
        "route": {
            "route_id": "route_1",
            "route_revision": "configuration:4",
            "sha256": "b" * 64,
        },
    }


def _parse(value: object):
    return continuation_context_from_params(
        {"continuation_context": value},
        request_id="stream_1",
        session_id="session_1",
        execution_context=_execution_context(),
    )


def _assert_error(value: object, code: str) -> None:
    with pytest.raises(ContinuationContextError) as exc_info:
        _parse(value)
    assert exc_info.value.code == code


def test_absent_context_preserves_legacy_and_explicit_null_fails_closed() -> None:
    assert continuation_context_from_params(
        {}, request_id="stream_1", session_id=None, execution_context=None
    ) is None
    _assert_error(None, "invalid_continuation_context")


def test_context_is_frozen_bound_and_returns_fresh_exact_wire_objects() -> None:
    source = _context()
    parsed = _parse(source)
    assert parsed is not None
    source["work_id"] = "retargeted"
    first = parsed.to_wire()
    second = parsed.to_wire()

    assert first == _context()
    assert first is not second
    assert first["source_attempt"] is not second["source_attempt"]
    assert parsed.enclosing_session_id == "session_1"
    with pytest.raises(FrozenInstanceError):
        parsed.work_id = "retargeted"  # type: ignore[misc]


@pytest.mark.parametrize(
    ("request_id", "session_id", "execution_context", "code"),
    [
        ("other_stream", "session_1", "current", "continuation_request_stream_mismatch"),
        ("stream_1", None, "current", "continuation_session_id_required"),
        ("stream_1", "../session", "current", "continuation_session_id_required"),
        ("stream_1", "session_1", None, "continuation_execution_context_required"),
    ],
)
def test_enclosing_request_and_session_are_mandatory_trusted_bindings(
    request_id: str,
    session_id: str | None,
    execution_context: str | None,
    code: str,
) -> None:
    trusted = _execution_context() if execution_context == "current" else None
    with pytest.raises(ContinuationContextError) as exc_info:
        continuation_context_from_params(
            {"continuation_context": _context()},
            request_id=request_id,
            session_id=session_id,
            execution_context=trusted,
        )
    assert exc_info.value.code == code


@pytest.mark.parametrize(
    ("mutate", "code"),
    [
        (
            lambda value: value["source_attempt"].update(authority_revision="authority_2"),
            "continuation_authority_revision_mismatch",
        ),
        (
            lambda value: value["authority"].update(project_id="project_2"),
            "continuation_authority_mismatch",
        ),
        (
            lambda value: value["authority"].update(root_id="root_2"),
            "continuation_authority_mismatch",
        ),
        (
            lambda value: value["authority"].update(root_revision=1),
            "continuation_authority_mismatch",
        ),
    ],
)
def test_captured_authority_must_match_the_enclosing_execution_context(mutate, code: str) -> None:
    value = _context()
    mutate(value)
    _assert_error(value, code)


@pytest.mark.parametrize(
    ("mutate", "code"),
    [
        (lambda value: value.update(schema_version=True),
         "unsupported_continuation_context_schema_version"),
        (lambda value: value.update(schema_version=2),
         "unsupported_continuation_context_schema_version"),
        (lambda value: value.update(model="untrusted"), "invalid_continuation_context_keys"),
        (
            lambda value: value["route"].update(endpoint_hostname="spoofed.example"),
            "invalid_route_keys",
        ),
        (lambda value: value["route"].update(sha256="A" * 64), "invalid_route_sha256"),
        (lambda value: value.update(work_id="bad:id"), "invalid_identity_work_id"),
    ],
)
def test_shape_identifiers_and_opaque_route_references_are_closed(mutate, code: str) -> None:
    value = _context()
    mutate(value)
    _assert_error(value, code)


def test_size_and_json_safety_are_checked_on_the_actual_context() -> None:
    oversized = _context()
    oversized["route"]["sha256"] = "a" * MAX_CONTINUATION_CONTEXT_BYTES  # type: ignore[index]
    _assert_error(oversized, "continuation_context_capacity")

    unserializable = _context()
    unserializable["route"]["sha256"] = object()  # type: ignore[index]
    before = copy.copy(unserializable)
    _assert_error(unserializable, "invalid_continuation_context_encoding")
    assert unserializable == before
