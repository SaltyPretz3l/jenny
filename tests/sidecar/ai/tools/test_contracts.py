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


def test_empty_optional_array_with_min_items_is_pruned_for_read_file() -> None:
    from sidecar.ai.tools.catalog import manifest_descriptors

    schema = next(item.input_schema for item in manifest_descriptors() if item.name == "read_file")

    result = validate_tool_arguments(
        tool_name="read_file",
        arguments={"path": "x", "headings": []},
        input_schema=schema,
        prune_empty_optional_arrays=True,
    )

    assert result == {"path": "x"}


def test_empty_optional_array_is_rejected_when_the_executor_does_not_prune() -> None:
    # Electron-run tools receive the arguments as sent, so the router must keep
    # rejecting `[]` there and hand the model its repair hint.
    schema = {
        "type": "object",
        "properties": {"codes": {"type": "array", "minItems": 1, "items": {"type": "integer"}}},
    }
    with pytest.raises(ToolExecutionFailure):
        validate_tool_arguments(tool_name="test", arguments={"codes": []}, input_schema=schema)


def test_only_the_builtin_server_counts_as_a_pruning_executor() -> None:
    from types import SimpleNamespace

    from sidecar.ai.tools.contracts import executor_prunes_empty_optional_arrays

    assert executor_prunes_empty_optional_arrays(SimpleNamespace(server_name="jenny_local_tools"))
    assert not executor_prunes_empty_optional_arrays(
        SimpleNamespace(server_name="electron_tool_bridge")
    )
    assert not executor_prunes_empty_optional_arrays(None)


def test_empty_required_array_with_min_items_is_still_rejected() -> None:
    schema = {
        "type": "object",
        "properties": {"items": {"type": "array", "minItems": 1, "items": {"type": "string"}}},
        "required": ["items"],
    }
    with pytest.raises(ToolExecutionFailure):
        validate_tool_arguments(tool_name="test", arguments={"items": []}, input_schema=schema)


def test_empty_optional_array_without_min_items_is_kept() -> None:
    schema = {"type": "object", "properties": {"tags": {"type": "array"}}}
    result = validate_tool_arguments(tool_name="test", arguments={"tags": []}, input_schema=schema)
    assert result == {"tags": []}
