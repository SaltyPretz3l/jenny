"""Tool execution contracts."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any, Mapping

from sidecar.ai.error_codes import CMP_TOOL_COERCED_ARGS_REJECTED
from sidecar.exceptions import CompanionError

_TOOL_ARGUMENT_ALIASES: dict[str, tuple[tuple[str, str], ...]] = {
    "write_file": (("path", "file_path"), ("content", "file_content")),
    "delete_file": (("path", "file_path"),),
}
TOOL_FAILURE_ERROR_DETAIL_KEYS = (
    "category",
    "classification",
    "error_type",
    "provider_code",
    "terminal_subcode",
    "error_message",
    "operation_id",
    "generation_id",
    "completion_status",
    "expected_size",
    "current_size",
    "expected_mtime_ns",
    "current_mtime_ns",
    "expected_sha256",
    "current_sha256",
    "content_changed",
    "payload_length",
    "offending_hunk",
    "failure_class",
    "effects",
    "precondition_id",
    "remediation",
    "failed_phase",
    "phase_timings_json",
    "trace_id",
    "idempotency_key",
)


@dataclass(frozen=True)
class ToolHandlerResult:
    output: str
    success: bool = True
    generated_artifacts: tuple[dict[str, object], ...] = ()
    error_code: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)
    # WIDE-019 typed side channel: bounded first-party media payloads (see
    # sidecar/ai/tools/trusted_attachments.py). Never rendered into `output`;
    # admission provenance rules apply downstream in tool_execution.
    trusted_attachments: tuple[dict[str, object], ...] = ()

    @property
    def content(self) -> str:
        return self.output


def validate_tool_arguments(
    *,
    tool_name: str,
    arguments: object,
    input_schema: dict[str, Any] | None,
) -> dict[str, object]:
    if not isinstance(arguments, dict):
        raise _validation_error(tool_name, "arguments must be an object")
    arguments, _aliases = canonicalize_tool_arguments(
        tool_name=tool_name,
        arguments=arguments,
    )
    schema = input_schema if isinstance(input_schema, dict) else {}
    _validate_value(tool_name, arguments, schema or {"type": "object"}, path="")
    return arguments


def canonicalize_tool_arguments(
    *,
    tool_name: str,
    arguments: dict[str, object],
) -> tuple[dict[str, object], tuple[dict[str, str], ...]]:
    """Collapse accepted aliases into the execution keys or fail on ambiguity.

    Alias conflicts are rejected instead of resolved by precedence. This keeps
    policy, approval, snapshots, and the eventual handler bound to the same
    values regardless of model key order.
    """

    normalized = dict(arguments)
    aliases: list[dict[str, str]] = []
    for canonical_key, alias_key in _TOOL_ARGUMENT_ALIASES.get(tool_name, ()):
        if alias_key not in normalized:
            continue
        if canonical_key in normalized and normalized[canonical_key] != normalized[alias_key]:
            raise ToolExecutionFailure(
                code=CMP_TOOL_COERCED_ARGS_REJECTED,
                message=(
                    f"tool '{tool_name}' rejected conflicting arguments "
                    f"'{canonical_key}' and '{alias_key}'"
                ),
                retryable=False,
            )
        if canonical_key not in normalized:
            normalized[canonical_key] = normalized[alias_key]
        normalized.pop(alias_key, None)
        aliases.append({"from": alias_key, "to": canonical_key})
    return normalized, tuple(aliases)


def _validate_value(
    tool_name: str,
    value: object,
    schema: dict[str, Any],
    *,
    path: str,
) -> None:
    any_of = schema.get("anyOf")
    if isinstance(any_of, list) and any_of:
        base_schema = {key: item for key, item in schema.items() if key != "anyOf"}
        for option in any_of:
            if not isinstance(option, dict):
                continue
            candidate_schema = {**base_schema, **option}
            try:
                _validate_value(tool_name, value, candidate_schema, path=path)
                break
            except ToolExecutionFailure:
                continue
        else:
            raise _validation_error(
                tool_name,
                f"{_describe_path(path)} must satisfy one of the allowed argument shapes",
            )

    enum_values = schema.get("enum")
    if isinstance(enum_values, list) and value not in enum_values:
        allowed = ", ".join(repr(item) for item in enum_values)
        raise _validation_error(tool_name, f"{_describe_path(path)} must be one of: {allowed}")

    schema_type = schema.get("type")
    if not isinstance(schema_type, str):
        if "properties" in schema or "required" in schema:
            schema_type = "object"
        else:
            return

    if schema_type == "object":
        _validate_object(tool_name, value, schema, path=path)
        return
    if schema_type == "array":
        _validate_array(tool_name, value, schema, path=path)
        return
    if schema_type == "string":
        if not isinstance(value, str):
            raise _validation_error(tool_name, f"{_describe_path(path)} must be a string")
        _validate_string_constraints(tool_name, value, schema, path=path)
        return
    if schema_type == "boolean":
        if not isinstance(value, bool):
            raise _validation_error(tool_name, f"{_describe_path(path)} must be a boolean")
        return
    if schema_type == "integer":
        if isinstance(value, bool) or not isinstance(value, int):
            raise _validation_error(tool_name, f"{_describe_path(path)} must be an integer")
        _validate_numeric_bounds(tool_name, value, schema, path=path)
        return
    if schema_type == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise _validation_error(tool_name, f"{_describe_path(path)} must be a number")
        if not math.isfinite(float(value)):
            raise _validation_error(tool_name, f"{_describe_path(path)} must be finite")
        _validate_numeric_bounds(tool_name, float(value), schema, path=path)


def _validate_object(
    tool_name: str,
    value: object,
    schema: dict[str, Any],
    *,
    path: str,
) -> None:
    if not isinstance(value, dict):
        raise _validation_error(tool_name, f"{_describe_path(path)} must be an object")
    required = schema.get("required")
    if isinstance(required, list):
        for key in required:
            if isinstance(key, str) and key not in value:
                missing_path = f"{path}.{key}" if path else key
                raise _validation_error(
                    tool_name,
                    f"missing required {_describe_path(missing_path)}",
                )
    properties = schema.get("properties")
    known_properties = properties if isinstance(properties, dict) else {}
    for key, child_value in value.items():
        child_schema = known_properties.get(key)
        child_path = f"{path}.{key}" if path else str(key)
        if isinstance(child_schema, dict):
            _validate_value(tool_name, child_value, child_schema, path=child_path)
            continue
        additional = schema.get("additionalProperties", True)
        if additional is False:
            raise _validation_error(
                tool_name,
                f"unexpected {_describe_path(child_path)}",
            )
        if isinstance(additional, dict):
            _validate_value(tool_name, child_value, additional, path=child_path)


def _validate_array(
    tool_name: str,
    value: object,
    schema: dict[str, Any],
    *,
    path: str,
) -> None:
    if not isinstance(value, list):
        raise _validation_error(tool_name, f"{_describe_path(path)} must be an array")
    minimum = schema.get("minItems")
    if isinstance(minimum, int) and not isinstance(minimum, bool) and len(value) < minimum:
        raise _validation_error(
            tool_name,
            f"{_describe_path(path)} must contain >= {minimum} items",
        )
    maximum = schema.get("maxItems")
    if isinstance(maximum, int) and not isinstance(maximum, bool) and len(value) > maximum:
        raise _validation_error(
            tool_name,
            f"{_describe_path(path)} must contain <= {maximum} items",
        )
    if schema.get("uniqueItems") is True:
        normalized = [
            json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            for item in value
        ]
        if len(set(normalized)) != len(normalized):
            raise _validation_error(tool_name, f"{_describe_path(path)} must contain unique items")
    item_schema = schema.get("items")
    if not isinstance(item_schema, dict):
        return
    for index, item in enumerate(value):
        item_path = f"{path}[{index}]" if path else f"[{index}]"
        _validate_value(tool_name, item, item_schema, path=item_path)


def _validate_string_constraints(
    tool_name: str,
    value: str,
    schema: dict[str, Any],
    *,
    path: str,
) -> None:
    minimum = schema.get("minLength")
    if isinstance(minimum, int) and not isinstance(minimum, bool) and len(value) < minimum:
        raise _validation_error(
            tool_name,
            f"{_describe_path(path)} must be at least {minimum} characters",
        )
    maximum = schema.get("maxLength")
    if isinstance(maximum, int) and not isinstance(maximum, bool) and len(value) > maximum:
        raise _validation_error(
            tool_name,
            f"{_describe_path(path)} must be at most {maximum} characters",
        )
    pattern = schema.get("pattern")
    if isinstance(pattern, str):
        try:
            matches = re.search(pattern, value) is not None
        except re.error as error:
            raise _validation_error(tool_name, f"schema pattern is invalid: {error}") from error
        if not matches:
            raise _validation_error(tool_name, f"{_describe_path(path)} has an invalid format")


def _validate_numeric_bounds(
    tool_name: str,
    value: int | float,
    schema: dict[str, Any],
    *,
    path: str,
) -> None:
    minimum = schema.get("minimum")
    if isinstance(minimum, (int, float)) and value < minimum:
        raise _validation_error(tool_name, f"{_describe_path(path)} must be >= {minimum}")
    maximum = schema.get("maximum")
    if isinstance(maximum, (int, float)) and value > maximum:
        raise _validation_error(tool_name, f"{_describe_path(path)} must be <= {maximum}")


def _describe_path(path: str) -> str:
    return "arguments" if not path else f"argument '{path}'"


def _validation_error(tool_name: str, message: str) -> "ToolExecutionFailure":
    return ToolExecutionFailure(
        code=CMP_TOOL_COERCED_ARGS_REJECTED,
        message=f"tool '{tool_name}' rejected malformed arguments: {message}",
        retryable=False,
    )


class ToolExecutionFailure(CompanionError):
    """Raised when a tool fails during execution."""

    def __init__(
        self,
        *,
        code: str,
        message: str,
        retryable: bool = False,
        error_details: Mapping[str, object] | None = None,
    ) -> None:
        super().__init__(code, message, retryable=retryable)
        details = error_details or {}
        for key in TOOL_FAILURE_ERROR_DETAIL_KEYS:
            setattr(self, key, str(details.get(key) or "").strip())

    def to_error_data(self) -> dict[str, str]:
        return {
            key: value
            for key in TOOL_FAILURE_ERROR_DETAIL_KEYS
            if (value := str(getattr(self, key, "") or "").strip())
        }
