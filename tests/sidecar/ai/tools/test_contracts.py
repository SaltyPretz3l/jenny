from __future__ import annotations

import pytest

from sidecar.ai.tools.contracts import ToolExecutionFailure, validate_tool_arguments

_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "job_id": {
            "type": "string",
            "minLength": 12,
            "maxLength": 12,
            "pattern": "^[0-9a-f]{12}$",
        },
        "codes": {
            "type": "array",
            "minItems": 1,
            "maxItems": 2,
            "uniqueItems": True,
            "items": {"type": "integer"},
        },
    },
    "required": ["job_id", "codes"],
}


def test_validator_enforces_supported_string_array_and_object_keywords() -> None:
    result = validate_tool_arguments(
        tool_name="test",
        arguments={"job_id": "abcdef012345", "codes": [0, 1]},
        input_schema=_SCHEMA,
    )

    assert result == {"job_id": "abcdef012345", "codes": [0, 1]}


@pytest.mark.parametrize(
    "arguments",
    [
        {"job_id": "short", "codes": [0]},
        {"job_id": "ABCDEF012345", "codes": [0]},
        {"job_id": "abcdef012345", "codes": []},
        {"job_id": "abcdef012345", "codes": [0, 0]},
        {"job_id": "abcdef012345", "codes": [0, 1, 2]},
        {"job_id": "abcdef012345", "codes": [0], "extra": True},
    ],
)
def test_validator_rejects_schema_keyword_violations(arguments: dict[str, object]) -> None:
    with pytest.raises(ToolExecutionFailure):
        validate_tool_arguments(
            tool_name="test",
            arguments=arguments,
            input_schema=_SCHEMA,
        )


def test_validator_applies_additional_property_schema() -> None:
    result = validate_tool_arguments(
        tool_name="test",
        arguments={"dynamic": 2},
        input_schema={"type": "object", "additionalProperties": {"type": "integer"}},
    )
    assert result == {"dynamic": 2}

    with pytest.raises(ToolExecutionFailure):
        validate_tool_arguments(
            tool_name="test",
            arguments={"dynamic": "2"},
            input_schema={"type": "object", "additionalProperties": {"type": "integer"}},
        )
