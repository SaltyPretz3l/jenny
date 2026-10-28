"""Tests for the roundtrip-only provider tool-call parsers."""

from __future__ import annotations

from typing import Any

from sidecar.ai.tools.normalization import (
    normalize_generation_response,
    parse_ollama_response,
    parse_openai_response,
)


def _openai_payload(arguments: Any, name: str = "read_file") -> dict[str, Any]:
    return {
        "choices": [
            {
                "message": {
                    "content": "",
                    "tool_calls": [
                        {"id": "call_1", "function": {"name": name, "arguments": arguments}}
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ]
    }


def _ollama_payload(arguments: Any, name: str = "run_command") -> dict[str, Any]:
    return {
        "message": {
            "content": "",
            "tool_calls": [{"function": {"name": name, "arguments": arguments}}],
        }
    }


def test_openai_valid_args_not_coerced() -> None:
    result = parse_openai_response(_openai_payload('{"path": "a.txt"}'))
    assert len(result.tool_calls) == 1
    call = result.tool_calls[0]
    assert (call.tool_id, call.arguments, call.call_id, call.coerced) == (
        "read_file", {"path": "a.txt"}, "call_1", False,
    )
    assert result.finish_reason == "tool_calls"


def test_openai_malformed_args_coerced() -> None:
    result = parse_openai_response(_openai_payload("not json at all", name="write_file"))
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].coerced is True
    assert result.tool_calls[0].arguments == {}


def test_openai_json_array_args_coerced() -> None:
    result = parse_openai_response(_openai_payload("[1, 2]"))
    assert result.tool_calls[0].coerced is True
    assert result.tool_calls[0].arguments == {}


def test_empty_arguments_follow_coerce_tool_arguments_semantics() -> None:
    """Empty / None arguments are an empty object, as on the live parse paths."""
    for raw in ("", None):
        assert parse_openai_response(_openai_payload(raw)).tool_calls[0].coerced is False
        assert parse_ollama_response(_ollama_payload(raw)).tool_calls[0].coerced is False


def test_ollama_dict_args_and_generated_call_id() -> None:
    result = parse_ollama_response(_ollama_payload({"command": "ls"}))
    call = result.tool_calls[0]
    assert call.arguments == {"command": "ls"}
    assert call.coerced is False
    assert call.call_id.startswith("ollama_")
    assert result.finish_reason == "tool_calls"


def test_nameless_and_non_object_entries_are_skipped() -> None:
    payload = _openai_payload("{}", name="  ")
    payload["choices"][0]["message"]["tool_calls"].append("garbage")
    assert parse_openai_response(payload).tool_calls == ()


def test_normalize_routes_ollama_and_defaults_to_openai_envelope() -> None:
    assert normalize_generation_response(_ollama_payload({}), "ollama").tool_calls
    for provider in ("openai", "vllm"):
        assert normalize_generation_response(_openai_payload("{}"), provider).tool_calls
