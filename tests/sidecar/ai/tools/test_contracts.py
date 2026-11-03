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


_EVENT_SCHEMA = {
    "type": "object",
    "properties": {
        "events": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "action": {"type": "string", "enum": ["click", "type", "press"]},
                    "selector": {"type": "string"},
                    "key": {"type": "string"},
                },
                "required": ["action"],
                "anyOf": [{"required": ["selector"]}, {"required": ["key"]}],
            },
        }
    },
}


def _any_of_message(arguments: dict[str, object], schema: dict[str, object]) -> str:
    with pytest.raises(ToolExecutionFailure) as error:
        validate_tool_arguments(tool_name="test", arguments=arguments, input_schema=schema)
    return error.value.message


def test_any_of_failure_names_the_required_keys_of_each_shape() -> None:
    message = _any_of_message({"events": [{"action": "click"}]}, _EVENT_SCHEMA)

    assert "argument 'events[0]' must satisfy one of the allowed argument shapes: " in message
    assert "{required: selector} | {required: key}" in message


def test_any_of_failure_surfaces_the_cause_every_shape_shares() -> None:
    message = _any_of_message(
        {"events": [{"action": "click", "selector": "#a"}, {"action": "observe", "selector": ""}]},
        _EVENT_SCHEMA,
    )

    assert "argument 'events[1]' must satisfy one of the allowed argument shapes" in message
    assert "every shape failed: argument 'events[1].action' must be one of:" in message
    assert "'click'" in message


def test_any_of_failure_lists_discriminating_enum_and_const_values() -> None:
    schema = {
        "type": "object",
        "properties": {
            "step": {
                "anyOf": [
                    {
                        "type": "object",
                        "properties": {
                            "action": {"enum": ["click", "type"]},
                            "selector": {"type": "string"},
                        },
                        "required": ["action", "selector"],
                    },
                    {
                        "type": "object",
                        "properties": {"action": {"const": "wait"}, "ms": {"type": "integer"}},
                        "required": ["action", "ms"],
                    },
                    {"type": "string"},
                    {"type": ["integer", "null"]},
                ]
            }
        },
    }

    message = _any_of_message({"step": {"action": "wait"}}, schema)

    assert (
        "{action: 'click'|'type', required: action, selector} | "
        "{action: 'wait', required: action, ms} | string | integer|null"
    ) in message
    assert "every shape failed" not in message


def test_any_of_shape_summary_is_bounded() -> None:
    options = [
        {
            "type": "object",
            "properties": {"kind": {"const": f"variant-number-{index:03d}"}},
            "required": ["kind", f"field_{index:03d}"],
        }
        for index in range(40)
    ]
    schema = {"type": "object", "properties": {"value": {"anyOf": options}}}

    message = _any_of_message({"value": {"kind": "nope"}}, schema)
    summary = message.split("allowed argument shapes: ", 1)[1]

    assert summary.endswith("…")
    assert len(summary) <= 301
