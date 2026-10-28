"""Schema ``type`` lists are validated member by member; unknown types fail closed."""

from __future__ import annotations

from typing import Any

import pytest

from sidecar.ai.tools.contracts import ToolExecutionFailure, validate_tool_arguments


def _validate(value: Any, schema: dict[str, Any]) -> None:
    validate_tool_arguments(
        tool_name="probe",
        arguments={"value": value},
        input_schema={"type": "object", "properties": {"value": schema}},
    )


@pytest.mark.parametrize("value", ["text", None])
def test_nullable_string_accepts_its_members(value: Any) -> None:
    _validate(value, {"type": ["string", "null"]})


@pytest.mark.parametrize("value", [5, True, {"a": 1}, ["x"]])
def test_nullable_string_rejects_other_types(value: Any) -> None:
    with pytest.raises(ToolExecutionFailure, match="must be one of types: string, null"):
        _validate(value, {"type": ["string", "null"]})


def test_union_members_keep_their_constraints() -> None:
    schema = {"type": ["integer", "null"], "minimum": 1}
    _validate(None, schema)
    _validate(3, schema)
    with pytest.raises(ToolExecutionFailure):
        _validate(0, schema)


def test_union_still_applies_enum_once() -> None:
    with pytest.raises(ToolExecutionFailure, match="must be one of"):
        _validate("c", {"type": ["string", "null"], "enum": ["a", "b", None]})
    _validate(None, {"type": ["string", "null"], "enum": ["a", None]})


def test_empty_type_list_fails_closed() -> None:
    with pytest.raises(ToolExecutionFailure):
        _validate("x", {"type": []})


@pytest.mark.parametrize("schema_type", ["any", "file", 7, {"type": "string"}])
def test_unknown_or_malformed_type_fails_closed(schema_type: Any) -> None:
    with pytest.raises(ToolExecutionFailure, match="unsupported schema type"):
        _validate("x", {"type": schema_type})


def test_null_type_accepts_only_none() -> None:
    _validate(None, {"type": "null"})
    with pytest.raises(ToolExecutionFailure, match="must be null"):
        _validate("x", {"type": "null"})


def test_untyped_schema_still_accepts_anything() -> None:
    _validate({"anything": [1, 2]}, {"description": "free-form"})
