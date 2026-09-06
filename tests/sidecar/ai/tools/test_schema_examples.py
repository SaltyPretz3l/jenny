from __future__ import annotations

import re

from sidecar.ai.tools.contracts import validate_tool_arguments
from sidecar.ai.tools.models import ToolSchema
from sidecar.ai.tools.schema_examples import minimal_valid_arguments, schema_placeholder_value
from sidecar.ai.tools.schema_roundtrip import schema_roundtrip_check


def test_examples_prefer_default_then_enum() -> None:
    assert schema_placeholder_value({"type": "string", "default": "ready"}) == "ready"
    assert schema_placeholder_value({"type": "string", "enum": ["first", "second"]}) == "first"


def test_uppercase_pattern_placeholder_survives_provider_roundtrip() -> None:
    string_schema = {
        "type": "string",
        "minLength": 2,
        "maxLength": 2,
        "pattern": "^[A-Z]{2}$",
    }
    placeholder = schema_placeholder_value(string_schema)
    tool = ToolSchema(
        tool_id="code",
        name="code",
        description="",
        parameters={
            "type": "object",
            "properties": {"code": string_schema},
            "required": ["code"],
        },
        source="test",
        version=1,
    )

    assert isinstance(placeholder, str)
    assert re.fullmatch(string_schema["pattern"], placeholder)
    assert schema_roundtrip_check([tool], provider="ollama").passed is True


def test_minimal_arguments_satisfy_live_schema_keywords() -> None:
    schema = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "job_id": {
                "type": "string",
                "minLength": 12,
                "maxLength": 12,
                "pattern": "^[0-9a-f]{12}$",
            },
            "headings": {
                "type": "array",
                "minItems": 1,
                "maxItems": 3,
                "items": {"type": "string", "minLength": 1},
            },
            "mode": {"type": "string", "enum": ["fast", "full"]},
        },
        "required": ["job_id", "headings", "mode"],
    }

    arguments = minimal_valid_arguments(schema)

    assert arguments == {
        "job_id": "000000000000",
        "headings": ["<string>"],
        "mode": "fast",
    }
    validate_tool_arguments(tool_name="example", arguments=arguments, input_schema=schema)


def test_minimal_arguments_select_first_any_of_branch() -> None:
    schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "minLength": 1},
            "offset": {"type": "integer", "minimum": 1},
        },
        "anyOf": [{"required": ["path"]}, {"required": ["offset"]}],
    }

    arguments = minimal_valid_arguments(schema)

    assert arguments == {"path": "<string>"}
    validate_tool_arguments(tool_name="example", arguments=arguments, input_schema=schema)
