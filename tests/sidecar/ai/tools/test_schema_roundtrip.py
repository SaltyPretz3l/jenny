"""Unit tests for the Phase 5 schema-roundtrip helper."""

from __future__ import annotations

from pathlib import Path

from sidecar.ai.tools.models import ToolSchema
from sidecar.ai.tools.schema_roundtrip import (
    RoundtripResult,
    schema_roundtrip_check,
)

_SIMPLE_SCHEMA = ToolSchema(
    tool_id="lookup",
    name="lookup",
    description="Look up a thing",
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "limit": {"type": "integer"},
        },
        "required": ["query"],
    },
    source="test",
    version=1,
)

_NO_REQUIRED_SCHEMA = ToolSchema(
    tool_id="ping",
    name="ping",
    description="Ping",
    parameters={
        "type": "object",
        "properties": {"target": {"type": "string"}},
    },
    source="test",
    version=1,
)


def test_roundtrip_passes_for_simple_tool_ollama() -> None:
    result = schema_roundtrip_check([_SIMPLE_SCHEMA], provider="ollama")
    assert isinstance(result, RoundtripResult)
    assert result.passed is True
    assert result.provider == "ollama"
    assert result.mismatched_tools == ()
    assert result.reason is None


def test_roundtrip_generates_arguments_that_satisfy_schema_constraints() -> None:
    constrained = ToolSchema(
        tool_id="job",
        name="job",
        description="Check a job",
        parameters={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "job_id": {
                    "type": "string",
                    "minLength": 12,
                    "maxLength": 12,
                    "pattern": "^[0-9a-f]{12}$",
                },
                "mode": {"type": "string", "enum": ["status", "stop"]},
            },
            "required": ["job_id", "mode"],
        },
        source="test",
        version=1,
    )

    result = schema_roundtrip_check([constrained], provider="ollama")

    assert result.passed is True


def test_roundtrip_passes_for_simple_tool_vllm_openai_compatible() -> None:
    result = schema_roundtrip_check([_SIMPLE_SCHEMA], provider="vllm")
    assert result.passed is True
    assert result.mismatched_tools == ()


def test_roundtrip_passes_when_required_field_is_dropped_for_provider_with_subset() -> None:
    # Verify the helper still accepts the no-required form via property fallback.
    result = schema_roundtrip_check([_NO_REQUIRED_SCHEMA], provider="ollama")
    assert result.passed is True


def test_roundtrip_fails_when_schema_name_is_blank() -> None:
    schema = ToolSchema(
        tool_id="blank",
        name="",
        description="",
        parameters={},
        source="test",
        version=1,
    )
    result = schema_roundtrip_check([schema], provider="ollama")
    assert result.passed is False
    assert result.mismatched_tools == ("blank",)


def test_roundtrip_records_mismatched_tools_by_name() -> None:
    blank_one = ToolSchema(
        tool_id="bad1",
        name="",
        description="",
        parameters={},
        source="test",
        version=1,
    )
    blank_two = ToolSchema(
        tool_id="bad2",
        name="",
        description="",
        parameters={},
        source="test",
        version=1,
    )
    result = schema_roundtrip_check(
        [_SIMPLE_SCHEMA, blank_one, blank_two], provider="ollama"
    )
    assert result.passed is False
    # Both blank-name schemas land in mismatched_tools; the simple schema does not.
    assert set(result.mismatched_tools) == {"bad1", "bad2"}
    assert "lookup" not in result.mismatched_tools


def test_roundtrip_handles_empty_schemas_list() -> None:
    result = schema_roundtrip_check([], provider="ollama")
    assert result.passed is True
    assert result.provider == "ollama"
    assert result.mismatched_tools == ()


def test_roundtrip_handles_unknown_provider_gracefully() -> None:
    result = schema_roundtrip_check([_SIMPLE_SCHEMA], provider="not-a-provider")
    assert result.passed is False
    assert result.reason is not None
    assert "unsupported_provider" in result.reason


def test_roundtrip_handles_missing_provider() -> None:
    result = schema_roundtrip_check([_SIMPLE_SCHEMA], provider="")
    assert result.passed is False
    assert result.reason == "provider_missing"


def test_roundtrip_is_pure_no_http_calls() -> None:
    """Grep-style assertion: the new module imports no HTTP libraries."""
    module_path = (
        Path(__file__).resolve().parents[4]
        / "sidecar"
        / "ai"
        / "tools"
        / "schema_roundtrip.py"
    )
    source = module_path.read_text(encoding="utf-8")
    forbidden_imports = ("import httpx", "import requests", "import urllib", "import socket")
    for needle in forbidden_imports:
        assert needle not in source, f"schema_roundtrip.py must not contain '{needle}'"
