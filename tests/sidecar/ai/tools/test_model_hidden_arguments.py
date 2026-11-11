"""The model-facing schema leaves out arguments the runtime fills (plan_artifact_policy.py)."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from sidecar.ai.tools.contracts import validate_tool_arguments
from sidecar.ai.tools.plan_artifact_policy import (
    MODEL_HIDDEN_ARGUMENTS,
    hide_runtime_arguments,
    prompt_schema_for_context,
)

_MANIFEST = Path(__file__).resolve().parents[4] / "services" / "tools" / "tool-manifest.json"


def _manifest_schema(name: str) -> dict[str, Any]:
    tools = json.loads(_MANIFEST.read_text(encoding="utf-8"))["tools"]
    return next(tool["parameters"] for tool in tools if tool.get("name") == name)


def _prompt_parameters(name: str) -> dict[str, Any]:
    descriptor = SimpleNamespace(
        name=name, description="d", input_schema=_manifest_schema(name), side_effecting=True
    )
    return prompt_schema_for_context(descriptor, plan_mode=False, read_only=False)["parameters"]


def test_write_file_shows_one_spelling_and_plain_required_arguments() -> None:
    parameters = _prompt_parameters("write_file")
    assert set(parameters["properties"]) == {"path", "content", "purpose", "normalize_bom"}
    assert parameters["required"] == ["path", "content"]
    assert "anyOf" not in parameters


def test_edit_file_keeps_its_two_call_shapes_without_the_read_snapshot() -> None:
    parameters = _prompt_parameters("edit_file")
    assert "expected_read_snapshot" not in parameters["properties"]
    assert parameters["required"] == ["file_path"]
    assert parameters["anyOf"] == [
        {"required": ["old_string", "new_string"]},
        {"required": ["edits"]},
    ]


def test_the_descriptor_schema_is_untouched_and_still_accepts_the_hidden_arguments() -> None:
    schema = _manifest_schema("write_file")
    before = json.dumps(schema, sort_keys=True)
    _prompt_parameters("write_file")
    descriptor = SimpleNamespace(name="write_file", description="d", input_schema=schema)
    prompt_schema_for_context(descriptor, plan_mode=False, read_only=False)
    assert json.dumps(schema, sort_keys=True) == before
    validate_tool_arguments(
        tool_name="write_file",
        input_schema=schema,
        arguments={"file_path": "a.txt", "file_content": "x"},
    )


def test_every_hidden_argument_exists_in_the_manifest() -> None:
    for name, hidden in MODEL_HIDDEN_ARGUMENTS.items():
        assert hidden <= set(_manifest_schema(name)["properties"]), name


def test_a_tool_with_no_hidden_arguments_is_returned_as_is() -> None:
    schema = {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}
    assert hide_runtime_arguments("read_file", schema) is schema
    assert schema["required"] == ["path"]


def test_the_rejection_hint_names_only_the_arguments_the_model_is_shown() -> None:
    from sidecar.ai.tools.plan_artifact_policy import model_facing_parameters
    from sidecar.ai.tools.schema_examples import tool_schema_hint_text, tool_schema_repair_hints

    descriptor = SimpleNamespace(name="write_file", input_schema=_manifest_schema("write_file"))
    hint = tool_schema_hint_text(tool_schema_repair_hints(model_facing_parameters(descriptor)))
    assert "path" in hint and "content" in hint
    assert "file_content" not in hint and "expected_read_snapshot" not in hint
