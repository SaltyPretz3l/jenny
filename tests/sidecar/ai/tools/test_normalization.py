"""Tests for tool argument coercion and normalization."""

from __future__ import annotations

from sidecar.ai.tools.normalization import (
    _coerce_arguments,
    parse_anthropic_response,
    parse_ollama_response,
    parse_openai_response,
)


class TestCoerceArguments:
    def test_valid_dict_is_not_coerced(self) -> None:
        args, coerced = _coerce_arguments({"path": "README.md"})
        assert args == {"path": "README.md"}
        assert coerced is False

    def test_empty_dict_is_not_coerced(self) -> None:
        args, coerced = _coerce_arguments({})
        assert args == {}
        assert coerced is False

    def test_valid_json_string_is_not_coerced(self) -> None:
        args, coerced = _coerce_arguments('{"path": "README.md"}')
        assert args == {"path": "README.md"}
        assert coerced is False

    def test_empty_string_is_coerced(self) -> None:
        args, coerced = _coerce_arguments("")
        assert args == {}
        assert coerced is True

    def test_whitespace_string_is_coerced(self) -> None:
        args, coerced = _coerce_arguments("   ")
        assert args == {}
        assert coerced is True

    def test_invalid_json_string_is_coerced(self) -> None:
        args, coerced = _coerce_arguments("{not valid json")
        assert args == {}
        assert coerced is True

    def test_json_array_string_is_coerced(self) -> None:
        args, coerced = _coerce_arguments("[1, 2, 3]")
        assert args == {}
        assert coerced is True

    def test_none_is_coerced(self) -> None:
        args, coerced = _coerce_arguments(None)
        assert args == {}
        assert coerced is True

    def test_integer_is_coerced(self) -> None:
        args, coerced = _coerce_arguments(42)
        assert args == {}
        assert coerced is True

    def test_list_is_coerced(self) -> None:
        args, coerced = _coerce_arguments([1, 2])
        assert args == {}
        assert coerced is True


class TestCoercedFlagPropagation:
    """Verify that the coerced flag propagates through provider-specific parsers."""

    def test_openai_valid_args_not_coerced(self) -> None:
        payload = {
            "choices": [
                {
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "read_file",
                                    "arguments": '{"path": "a.txt"}',
                                },
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ]
        }
        result = parse_openai_response(payload)
        assert len(result.tool_calls) == 1
        assert result.tool_calls[0].coerced is False

    def test_openai_malformed_args_coerced(self) -> None:
        payload = {
            "choices": [
                {
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "write_file",
                                    "arguments": "not json at all",
                                },
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ]
        }
        result = parse_openai_response(payload)
        assert len(result.tool_calls) == 1
        assert result.tool_calls[0].coerced is True
        assert result.tool_calls[0].arguments == {}

    def test_ollama_malformed_args_coerced(self) -> None:
        payload = {
            "message": {
                "content": "",
                "tool_calls": [
                    {
                        "function": {
                            "name": "run_command",
                            "arguments": None,
                        },
                    }
                ],
            }
        }
        result = parse_ollama_response(payload)
        assert len(result.tool_calls) == 1
        assert result.tool_calls[0].coerced is True

    def test_anthropic_valid_args_not_coerced(self) -> None:
        payload = {
            "content": [
                {
                    "type": "tool_use",
                    "name": "read_file",
                    "id": "tu_1",
                    "input": {"path": "b.txt"},
                }
            ],
            "stop_reason": "tool_use",
        }
        result = parse_anthropic_response(payload)
        assert len(result.tool_calls) == 1
        assert result.tool_calls[0].coerced is False

    def test_anthropic_malformed_args_coerced(self) -> None:
        payload = {
            "content": [
                {
                    "type": "tool_use",
                    "name": "write_file",
                    "id": "tu_2",
                    "input": "garbage",
                }
            ],
            "stop_reason": "tool_use",
        }
        result = parse_anthropic_response(payload)
        assert len(result.tool_calls) == 1
        assert result.tool_calls[0].coerced is True
        assert result.tool_calls[0].arguments == {}
