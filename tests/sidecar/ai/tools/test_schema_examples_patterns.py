"""A broken external schema ``pattern`` never raises out of the example builders (C1 #3).

External MCP schemas are untrusted; ``re.error`` from one of them used to take
the system-prompt digest and the repair hints down with it.
"""

from __future__ import annotations

from sidecar.ai.tools.schema_examples import schema_placeholder_value, tool_schema_repair_hints

_BROKEN = {
    "type": "object",
    "properties": {"id": {"type": "string", "pattern": "(", "minLength": 3}},
    "required": ["id"],
}


def test_invalid_pattern_falls_back_to_a_plain_placeholder() -> None:
    assert schema_placeholder_value(_BROKEN["properties"]["id"]) == "xxx"


def test_invalid_pattern_keeps_repair_hints_working() -> None:
    hints = tool_schema_repair_hints(_BROKEN)
    assert isinstance(hints, dict)


def test_type_union_placeholder_uses_the_first_concrete_member() -> None:
    assert schema_placeholder_value({"type": ["integer", "null"], "minimum": 2}) == 2
    assert schema_placeholder_value({"type": ["null", "string"]}) == "<string>"
    assert schema_placeholder_value({"type": ["null"]}) == "<value>"
