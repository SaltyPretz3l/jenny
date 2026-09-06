"""Small JSON-schema examples used in tool prompts and repair hints."""

from __future__ import annotations

import json
import math
import re
from typing import Any


def _array_placeholder_value(schema: dict[str, Any]) -> list[object]:
    item_schema = schema.get("items")
    minimum = schema.get("minItems")
    count = minimum if isinstance(minimum, int) and not isinstance(minimum, bool) else 0
    maximum = schema.get("maxItems")
    if isinstance(maximum, int) and not isinstance(maximum, bool):
        count = min(count, maximum)
    if not isinstance(item_schema, dict) or count <= 0:
        return []
    values: list[object] = []
    for index in range(count):
        item = schema_placeholder_value(item_schema)
        if schema.get("uniqueItems") is True and item in values:
            if isinstance(item, bool):
                item = not item
            elif isinstance(item, int):
                item += index
            elif isinstance(item, float):
                item += float(index)
            elif isinstance(item, str):
                item = f"{item}{index}"
        values.append(item)
    return values


def _object_placeholder_value(schema: dict[str, Any]) -> dict[str, object]:
    properties = schema.get("properties")
    required = schema.get("required")
    if not isinstance(properties, dict) or not isinstance(required, list):
        return {}

    sample: dict[str, object] = {}
    for key in required[:8]:
        if not isinstance(key, str):
            continue
        child = properties.get(key)
        sample[key] = schema_placeholder_value(child if isinstance(child, dict) else None)
    return sample


def schema_placeholder_value(schema: dict[str, Any] | None) -> object:
    candidate = _select_schema_variant(schema if isinstance(schema, dict) else {})
    if "default" in candidate:
        value: object = candidate["default"]
    else:
        enum_values = candidate.get("enum")
        schema_type = str(candidate.get("type") or "").strip().lower()
        if isinstance(enum_values, list) and enum_values:
            value = enum_values[0]
        elif schema_type == "string":
            value = _string_placeholder_value(candidate)
        elif schema_type in {"integer", "number"}:
            value = _numeric_placeholder_value(
                candidate,
                integer=schema_type == "integer",
            )
        elif schema_type == "boolean":
            value = False
        elif schema_type == "array":
            value = _array_placeholder_value(candidate)
        elif schema_type == "object":
            value = _object_placeholder_value(candidate)
        else:
            value = "<value>"
    return value


def _select_schema_variant(schema: dict[str, Any]) -> dict[str, Any]:
    any_of = schema.get("anyOf")
    if not isinstance(any_of, list):
        return schema
    base = {key: value for key, value in schema.items() if key != "anyOf"}
    for option in any_of:
        if isinstance(option, dict):
            return {**base, **option}
    return base


def _numeric_placeholder_value(schema: dict[str, Any], *, integer: bool) -> int | float:
    minimum = schema.get("minimum")
    maximum = schema.get("maximum")
    value = float(minimum) if isinstance(minimum, (int, float)) else 0.0
    if isinstance(maximum, (int, float)):
        value = min(value, float(maximum))
    if integer:
        return math.ceil(value)
    return value


def _string_placeholder_value(schema: dict[str, Any]) -> str:
    minimum = schema.get("minLength")
    min_length = minimum if isinstance(minimum, int) and not isinstance(minimum, bool) else 0
    maximum = schema.get("maxLength")
    max_length = maximum if isinstance(maximum, int) and not isinstance(maximum, bool) else None
    target_length = max(1, min_length)
    if max_length is not None:
        target_length = min(target_length, max_length)
    pattern = schema.get("pattern")
    candidates = [
        "<string>",
        "0" * target_length,
        "a" * target_length,
        "A" * target_length,
        "x" * target_length,
        "000000000000",
        "value",
    ]
    for value in candidates:
        if len(value) < min_length or (max_length is not None and len(value) > max_length):
            continue
        if not isinstance(pattern, str) or re.search(pattern, value) is not None:
            return value
    return "x" * target_length


def tool_schema_repair_hints(
    input_schema: dict[str, Any] | None,
) -> dict[str, object]:
    schema = _select_schema_variant(input_schema if isinstance(input_schema, dict) else {})
    required_raw = schema.get("required")
    required_keys = (
        [str(key).strip() for key in required_raw if isinstance(key, str) and str(key).strip()]
        if isinstance(required_raw, list)
        else []
    )
    properties = schema.get("properties")
    minimal_valid_arguments: dict[str, object] = {}
    if isinstance(properties, dict):
        for key in required_keys[:8]:
            child = properties.get(key)
            minimal_valid_arguments[key] = schema_placeholder_value(
                child if isinstance(child, dict) else None
            )
    return {
        "required_keys": required_keys,
        "minimal_valid_arguments": minimal_valid_arguments,
    }


def minimal_valid_arguments(input_schema: dict[str, Any] | None) -> dict[str, object]:
    repair_hints = tool_schema_repair_hints(input_schema)
    minimal_arguments = repair_hints.get("minimal_valid_arguments")
    return dict(minimal_arguments) if isinstance(minimal_arguments, dict) else {}


def tool_schema_hint_text(repair_hints: dict[str, object]) -> str:
    required_keys = repair_hints.get("required_keys")
    minimal_arguments = repair_hints.get("minimal_valid_arguments")
    if not isinstance(required_keys, list) or not required_keys:
        return ""
    required_text = ", ".join(str(key) for key in required_keys if str(key).strip())
    if not required_text:
        return ""
    if isinstance(minimal_arguments, dict) and minimal_arguments:
        minimal_json = json.dumps(minimal_arguments, ensure_ascii=False)
        return f" Required keys: {required_text}. Minimal valid arguments: {minimal_json}."
    return f" Required keys: {required_text}."


def format_tool_arguments_example(input_schema: dict[str, Any] | None) -> str:
    return json.dumps(minimal_valid_arguments(input_schema), ensure_ascii=False)


def format_tool_call_example(tool_name: str, input_schema: dict[str, Any] | None) -> str:
    payload = {
        "name": str(tool_name or "").strip() or "TOOL_NAME",
        "arguments": minimal_valid_arguments(input_schema),
    }
    return json.dumps(payload, ensure_ascii=False)
