"""Tests for sidecar.runtime.vllm_engine_support helper functions.

Each test is focused on a single observable behaviour; oracles assert both
the concrete return value AND (where relevant) that injected collaborators
were called with the expected arguments.
"""
from __future__ import annotations

import json
import logging
from typing import Any
from unittest.mock import MagicMock, call, patch

import pytest

import sidecar.runtime.vllm_engine_support as vllm_support
from sidecar.runtime.vllm_engine_support import (
    _as_non_empty_string,
    _build_messages,
    _build_openai_compatible_tool_calls,
    _build_tools_payload,
    _normalize_content,
    _parse_tool_calls,
    _tool_call_arguments,
    _tool_call_id,
    _tool_call_name,
    extract_reasoning_delta,
)


# ---------------------------------------------------------------------------
# _as_non_empty_string
# ---------------------------------------------------------------------------


def test_as_non_empty_string_returns_none_for_non_string() -> None:
    """Line 40: non-string value returns None."""
    assert _as_non_empty_string(42) is None
    assert _as_non_empty_string(None) is None
    assert _as_non_empty_string(["hello"]) is None


def test_as_non_empty_string_returns_none_for_blank_string() -> None:
    """Empty / whitespace-only string returns None."""
    assert _as_non_empty_string("") is None
    assert _as_non_empty_string("   ") is None


def test_as_non_empty_string_strips_and_returns() -> None:
    """Non-blank string is stripped and returned."""
    assert _as_non_empty_string("  hello  ") == "hello"
    assert _as_non_empty_string("x") == "x"


# ---------------------------------------------------------------------------
# _normalize_content
# ---------------------------------------------------------------------------


def test_normalize_content_string_passthrough() -> None:
    assert _normalize_content("hello") == "hello"


def test_normalize_content_list_of_text_blocks() -> None:
    """Lines 49-53: list path concatenates 'text' values."""
    blocks: list[Any] = [
        {"type": "text", "text": "Hello "},
        {"type": "text", "text": "world"},
    ]
    result = _normalize_content(blocks)
    assert result == "Hello world"


def test_normalize_content_list_skips_non_text_blocks() -> None:
    """List blocks without a string 'text' key are skipped."""
    blocks: list[Any] = [
        {"type": "image_url", "image_url": "http://example.com/img.png"},
        {"type": "text", "text": "kept"},
    ]
    result = _normalize_content(blocks)
    assert result == "kept"


def test_normalize_content_list_skips_non_dict_items() -> None:
    """Non-dict items inside a list don't crash and are skipped."""
    result = _normalize_content(["just a string", {"text": "ok"}])
    assert result == "ok"


def test_normalize_content_empty_list_returns_empty_string() -> None:
    assert _normalize_content([]) == ""


def test_normalize_content_unknown_type_returns_empty_string() -> None:
    assert _normalize_content(12345) == ""


# ---------------------------------------------------------------------------
# _tool_call_name
# ---------------------------------------------------------------------------


def test_tool_call_name_non_dict_returns_none() -> None:
    """Line 59: non-dict candidate returns None."""
    assert _tool_call_name("not a dict") is None
    assert _tool_call_name(None) is None
    assert _tool_call_name(42) is None


def test_tool_call_name_reads_name_key() -> None:
    assert _tool_call_name({"name": "my_tool"}) == "my_tool"


def test_tool_call_name_falls_back_to_tool_id() -> None:
    assert _tool_call_name({"tool_id": "fallback"}) == "fallback"


def test_tool_call_name_returns_none_when_both_absent() -> None:
    assert _tool_call_name({}) is None


# ---------------------------------------------------------------------------
# _tool_call_id
# ---------------------------------------------------------------------------


def test_tool_call_id_non_dict_returns_none() -> None:
    """Line 65: non-dict candidate returns None."""
    assert _tool_call_id("string") is None
    assert _tool_call_id(None) is None


def test_tool_call_id_reads_id_key() -> None:
    assert _tool_call_id({"id": "abc123"}) == "abc123"


def test_tool_call_id_falls_back_to_call_id() -> None:
    assert _tool_call_id({"call_id": "xyz"}) == "xyz"


def test_tool_call_id_returns_none_when_both_absent() -> None:
    assert _tool_call_id({}) is None


# ---------------------------------------------------------------------------
# _tool_call_arguments
# ---------------------------------------------------------------------------


def test_tool_call_arguments_non_dict_returns_empty() -> None:
    """Line 71: non-dict candidate returns {}."""
    assert _tool_call_arguments("string") == {}
    assert _tool_call_arguments(None) == {}
    assert _tool_call_arguments(42) == {}


def test_tool_call_arguments_dict_arguments_returned_as_is() -> None:
    """Line 73-74: dict arguments returned directly."""
    args = {"key": "value", "num": 1}
    result = _tool_call_arguments({"arguments": args})
    assert result == {"key": "value", "num": 1}


def test_tool_call_arguments_string_json_parsed() -> None:
    """Lines 75-81: string arguments parsed from JSON."""
    raw = json.dumps({"a": 1, "b": "two"})
    result = _tool_call_arguments({"arguments": raw})
    assert result == {"a": 1, "b": "two"}


def test_tool_call_arguments_invalid_json_string_returns_empty() -> None:
    """Lines 76-79: invalid JSON string returns {}."""
    result = _tool_call_arguments({"arguments": "not valid json {"})
    assert result == {}


def test_tool_call_arguments_json_non_dict_returns_empty() -> None:
    """Line 80-82: JSON that parses to non-dict returns {}."""
    result = _tool_call_arguments({"arguments": "[1, 2, 3]"})
    assert result == {}


def test_tool_call_arguments_blank_string_returns_empty() -> None:
    """Blank string arguments returns {}."""
    result = _tool_call_arguments({"arguments": "   "})
    assert result == {}


def test_tool_call_arguments_absent_key_returns_empty() -> None:
    """Missing arguments key returns {}."""
    result = _tool_call_arguments({})
    assert result == {}


# ---------------------------------------------------------------------------
# _build_openai_compatible_tool_calls
# ---------------------------------------------------------------------------


def test_build_openai_compatible_tool_calls_non_list_returns_empty() -> None:
    """Line 87: non-list input returns []."""
    assert _build_openai_compatible_tool_calls(None) == []
    assert _build_openai_compatible_tool_calls("bad") == []
    assert _build_openai_compatible_tool_calls(42) == []


def test_build_openai_compatible_tool_calls_skips_nameless_entries() -> None:
    """Line 92: entries where _tool_call_name returns None are skipped."""
    raw: list[Any] = [
        {"name": None},  # name normalizes to None
        {"other": "field"},  # no name or tool_id
    ]
    result = _build_openai_compatible_tool_calls(raw)
    assert result == []


def test_build_openai_compatible_tool_calls_includes_id_when_present() -> None:
    raw: list[Any] = [{"name": "do_thing", "id": "call_001", "arguments": {"x": 1}}]
    result = _build_openai_compatible_tool_calls(raw)
    assert len(result) == 1
    assert result[0]["id"] == "call_001"
    assert result[0]["type"] == "function"
    assert result[0]["function"]["name"] == "do_thing"
    assert json.loads(result[0]["function"]["arguments"]) == {"x": 1}


def test_build_openai_compatible_tool_calls_omits_id_when_absent() -> None:
    raw: list[Any] = [{"name": "no_id_tool"}]
    result = _build_openai_compatible_tool_calls(raw)
    assert len(result) == 1
    assert "id" not in result[0]
    assert result[0]["function"]["name"] == "no_id_tool"


# ---------------------------------------------------------------------------
# _build_messages — role-filtering paths
# ---------------------------------------------------------------------------


def test_build_messages_skips_message_with_none_role() -> None:
    """Line 119: message with a non-string / None role is dropped."""
    messages = [
        {"role": None, "content": "ignored"},
        {"role": "user", "content": "kept"},
    ]
    result = _build_messages(prompt="fallback", system="", messages=messages)
    # Only the user message should survive
    assert any(m["role"] == "user" and m["content"] == "kept" for m in result)
    assert all(m.get("role") is not None for m in result)


def test_build_messages_skips_message_with_unknown_role() -> None:
    """Line 122: message with an unsupported role is dropped."""
    messages = [
        {"role": "admin", "content": "privileged"},
        {"role": "user", "content": "normal"},
    ]
    result = _build_messages(prompt="fallback", system="", messages=messages)
    assert all(m["role"] != "admin" for m in result)
    user_msgs = [m for m in result if m["role"] == "user"]
    assert len(user_msgs) == 1
    assert user_msgs[0]["content"] == "normal"


def test_build_messages_skips_assistant_with_no_content_and_no_tool_calls() -> None:
    """Line 130: empty assistant message (no content, no tool_calls) is dropped."""
    messages = [
        {"role": "assistant", "content": "   "},  # blank → dropped
        {"role": "user", "content": "hi"},
    ]
    result = _build_messages(prompt="fallback", system="", messages=messages)
    assert all(m["role"] != "assistant" for m in result)
    assert any(m["role"] == "user" for m in result)


def test_build_messages_keeps_assistant_with_tool_calls_and_no_content() -> None:
    """Assistant message with tool_calls but no content is kept."""
    tool_calls_raw: list[Any] = [{"name": "my_func", "arguments": {}}]
    messages = [
        {"role": "assistant", "content": "", "tool_calls": tool_calls_raw},
        {"role": "user", "content": "ok"},
    ]
    result = _build_messages(prompt="fallback", system="", messages=messages)
    asst_msgs = [m for m in result if m["role"] == "assistant"]
    assert len(asst_msgs) == 1
    assert "tool_calls" in asst_msgs[0]
    assert asst_msgs[0]["tool_calls"][0]["function"]["name"] == "my_func"


def test_build_messages_skips_user_message_with_empty_content() -> None:
    """Line 174: user/system message with empty content is skipped."""
    messages = [
        {"role": "user", "content": ""},  # empty → skipped
        {"role": "user", "content": "real message"},
    ]
    result = _build_messages(prompt="fallback", system="", messages=messages)
    user_msgs = [m for m in result if m["role"] == "user"]
    assert len(user_msgs) == 1
    assert user_msgs[0]["content"] == "real message"


def test_build_messages_demotes_non_leading_system() -> None:
    """A system message stranded after the conversation history is demoted to
    ``user`` so system-first GGUF templates (served via vLLM / the
    OpenAI-compatible subclass) do not reject the request. Mirrors the Ollama
    builder's behavior."""
    messages = [
        {"role": "system", "content": "identity"},
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "ok"},
        {"role": "system", "content": "tool failure nudge"},
    ]
    result = _build_messages(prompt="fallback", system="", messages=messages)
    assert result[0]["role"] == "system"
    assert all(m["role"] != "system" for m in result[1:])
    assert result[-1]["role"] == "user"
    assert result[-1]["content"] == "tool failure nudge"


def test_build_messages_demotes_nudge_after_real_tool_failure_shape() -> None:
    """Realistic failing shape: assistant `tool_calls` + `tool` result + a
    trailing system nudge. The tool row survives, the nudge is demoted to
    `user`, and the leading system stays at index 0 (mirrors the Ollama
    builder test)."""
    messages = [
        {"role": "system", "content": "identity"},
        {"role": "user", "content": "where did you save it?"},
        {
            "role": "assistant",
            "content": "Calling tool 'list_dir'.",
            "tool_calls": [{"name": "list_dir", "arguments": {"path": "/x"}}],
        },
        {
            "role": "tool",
            "tool_call_id": "call_1",
            "content": "Tool 'list_dir' failed: path does not exist",
        },
        {"role": "system", "content": "Tool failure context: retry."},
    ]
    result = _build_messages(prompt="fallback", system="", messages=messages)
    assert [m["role"] for m in result] == [
        "system",
        "user",
        "assistant",
        "tool",
        "user",
    ]
    assert result[3]["tool_call_id"] == "call_1"
    assert result[2]["tool_calls"][0]["function"]["name"] == "list_dir"
    assert result[-1]["content"] == "Tool failure context: retry."
    assert result[0]["content"] == "identity"


# ---------------------------------------------------------------------------
# _build_messages — tool message dropped paths (lines 147-164)
# ---------------------------------------------------------------------------


def test_build_messages_drops_tool_message_missing_tool_call_id() -> None:
    """Lines 147-164: tool message without tool_call_id triggers log_event and is dropped.

    The recorder asserts the exact diagnostic event the operator relies on to
    trace a silently-dropped tool result: component, event name, WARNING level,
    degraded status, and the discriminating ``reason`` code.
    """
    messages = [
        {"role": "user", "content": "search for foo"},
        {"role": "tool", "content": "some result", "name": "web_search"},  # no tool_call_id
    ]
    with patch.object(vllm_support, "log_event") as mock_log:
        result = _build_messages(prompt="fallback", system="", messages=messages)

    # The tool message must NOT appear in the output
    assert all(m["role"] != "tool" for m in result)
    # log_event must have been called exactly once with the precise contract.
    mock_log.assert_called_once()
    log_args, log_kwargs = mock_log.call_args
    # First positional arg is the module logger; level is positional too.
    assert log_args[0] is vllm_support.logger
    assert log_args[1] == logging.WARNING
    assert log_kwargs["component"] == "ai.engine.vllm"
    assert log_kwargs["event"] == "ai.engine.vllm.tool_message_dropped"
    assert log_kwargs["status"] == "degraded"
    assert log_kwargs["data"]["reason"] == "missing_tool_call_id"
    assert log_kwargs["data"]["tool_name"] == "web_search"
    assert log_kwargs["data"]["content_length"] == len("some result")


def test_build_messages_drops_tool_message_with_empty_content() -> None:
    """Lines 147-164: tool message with a valid id but empty content is dropped.

    Distinguishes the ``empty_content`` reason from ``missing_tool_call_id`` —
    the two branches must emit different reason codes for operator tracing.
    """
    messages = [
        {"role": "user", "content": "search for foo"},
        {"role": "tool", "content": "   ", "tool_call_id": "call_abc", "name": "lookup"},
    ]
    with patch.object(vllm_support, "log_event") as mock_log:
        result = _build_messages(prompt="fallback", system="", messages=messages)

    assert all(m["role"] != "tool" for m in result)
    mock_log.assert_called_once()
    log_args, log_kwargs = mock_log.call_args
    assert log_args[1] == logging.WARNING
    assert log_kwargs["event"] == "ai.engine.vllm.tool_message_dropped"
    assert log_kwargs["data"]["reason"] == "empty_content"
    assert log_kwargs["data"]["tool_name"] == "lookup"
    # Whitespace content length is reported verbatim (3 spaces), not stripped.
    assert log_kwargs["data"]["content_length"] == 3


def test_build_messages_keeps_valid_tool_message() -> None:
    """Tool message with both id and content is preserved."""
    messages = [
        {"role": "user", "content": "question"},
        {"role": "tool", "content": "result text", "tool_call_id": "call_xyz"},
    ]
    result = _build_messages(prompt="fallback", system="", messages=messages)
    tool_msgs = [m for m in result if m["role"] == "tool"]
    assert len(tool_msgs) == 1
    assert tool_msgs[0]["tool_call_id"] == "call_xyz"
    assert tool_msgs[0]["content"] == "result text"


def test_build_messages_fallback_path_uses_prompt_and_system() -> None:
    """When messages is empty/None, uses prompt+system directly."""
    result = _build_messages(prompt="hello world", system="be helpful", messages=None)
    assert result[0] == {"role": "system", "content": "be helpful"}
    assert result[1] == {"role": "user", "content": "hello world"}


def test_build_messages_fallback_path_no_system_when_blank() -> None:
    """Blank system in fallback path omits the system message."""
    result = _build_messages(prompt="hi", system="", messages=None)
    assert len(result) == 1
    assert result[0] == {"role": "user", "content": "hi"}


def test_build_messages_inserts_system_when_not_present_in_messages() -> None:
    """System prompt is prepended when messages don't already have one."""
    messages = [{"role": "user", "content": "question"}]
    result = _build_messages(prompt="fallback", system="be precise", messages=messages)
    assert result[0]["role"] == "system"
    assert result[0]["content"] == "be precise"


def test_build_messages_prepends_primary_system_ahead_of_other_system_rows() -> None:
    """A non-primary system row must not suppress the primary-prompt prepend.

    Only an exact copy of the router-supplied prompt already riding in
    `messages` suppresses it (contains_primary_system_message); any other
    system row (overlay, compaction summary) is merged BEHIND the primary in
    the single leading system message.
    """
    messages = [
        {"role": "system", "content": "existing system"},
        {"role": "user", "content": "hello"},
    ]
    result = _build_messages(prompt="fallback", system="extra system", messages=messages)
    system_msgs = [m for m in result if m["role"] == "system"]
    assert len(system_msgs) == 1
    assert system_msgs[0]["content"].startswith("extra system")
    assert "existing system" in system_msgs[0]["content"]


# ---------------------------------------------------------------------------
# _build_tools_payload — defer_loading path (line 199)
# ---------------------------------------------------------------------------


def test_build_tools_payload_skips_defer_loading_tools() -> None:
    """Line 199: tools with defer_loading=True are excluded."""
    tools: list[dict[str, Any]] = [
        {"name": "eager_tool", "description": "runs now", "parameters": {}},
        {"name": "lazy_tool", "description": "deferred", "parameters": {}, "defer_loading": True},
    ]
    result = _build_tools_payload(tools)
    names = [t["function"]["name"] for t in result]
    assert "eager_tool" in names
    assert "lazy_tool" not in names
    assert len(result) == 1


def test_build_tools_payload_skips_tool_with_no_name() -> None:
    """Tool without a valid name key is skipped."""
    tools: list[dict[str, Any]] = [
        {"description": "anonymous"},
        {"name": "real_tool", "description": "has name"},
    ]
    result = _build_tools_payload(tools)
    assert len(result) == 1
    assert result[0]["function"]["name"] == "real_tool"


def test_build_tools_payload_uses_empty_string_for_missing_description() -> None:
    """Missing description becomes empty string."""
    tools: list[dict[str, Any]] = [{"name": "bare_tool"}]
    result = _build_tools_payload(tools)
    assert result[0]["function"]["description"] == ""


def test_build_tools_payload_uses_empty_dict_for_non_dict_parameters() -> None:
    """Non-dict parameters field is replaced with {}."""
    tools: list[dict[str, Any]] = [{"name": "tool_a", "parameters": "string_value"}]
    result = _build_tools_payload(tools)
    assert result[0]["function"]["parameters"] == {}


# ---------------------------------------------------------------------------
# _parse_tool_calls — edge branches (lines 225, 228, 231, 235, 239-240)
# ---------------------------------------------------------------------------


def test_parse_tool_calls_non_list_returns_empty() -> None:
    """Non-list input returns []."""
    assert _parse_tool_calls(None) == []
    assert _parse_tool_calls("string") == []
    assert _parse_tool_calls(42) == []


def test_parse_tool_calls_skips_non_dict_items() -> None:
    """Line 225: non-dict items in list are skipped."""
    raw: list[Any] = [
        "not a dict",
        42,
        {"function": {"name": "real_tool", "arguments": "{}"}},
    ]
    result = _parse_tool_calls(raw)
    assert len(result) == 1
    assert result[0].tool_id == "real_tool"


def test_parse_tool_calls_skips_item_with_non_dict_function() -> None:
    """Line 228: item whose 'function' is not a dict is skipped."""
    raw: list[Any] = [
        {"function": "not_a_dict"},
        {"function": {"name": "ok_tool", "arguments": "{}"}},
    ]
    result = _parse_tool_calls(raw)
    assert len(result) == 1
    assert result[0].tool_id == "ok_tool"


def test_parse_tool_calls_skips_item_with_no_name() -> None:
    """Line 231: item with no valid function name is skipped."""
    raw: list[Any] = [
        {"function": {"name": "", "arguments": "{}"}},
        {"function": {"name": "valid_name", "arguments": "{}"}},
    ]
    result = _parse_tool_calls(raw)
    assert len(result) == 1
    assert result[0].tool_id == "valid_name"


def test_parse_tool_calls_parses_dict_arguments_directly() -> None:
    """Line 235: dict arguments are used directly (no JSON parsing)."""
    raw: list[Any] = [
        {"function": {"name": "tool_a", "arguments": {"x": 1, "y": "hello"}}},
    ]
    result = _parse_tool_calls(raw)
    assert len(result) == 1
    assert result[0].arguments == {"x": 1, "y": "hello"}
    assert result[0].tool_id == "tool_a"


def test_parse_tool_calls_parses_string_json_arguments() -> None:
    """Lines 236-241: string JSON arguments are parsed."""
    raw: list[Any] = [
        {"function": {"name": "tool_b", "arguments": '{"key": "value"}'}},
    ]
    result = _parse_tool_calls(raw)
    assert len(result) == 1
    assert result[0].arguments == {"key": "value"}


def test_parse_tool_calls_invalid_json_string_gives_empty_args() -> None:
    """Lines 239-240: invalid JSON string in arguments → empty dict."""
    raw: list[Any] = [
        {"function": {"name": "tool_c", "arguments": "not { valid json"}},
    ]
    result = _parse_tool_calls(raw)
    assert len(result) == 1
    assert result[0].arguments == {}
    assert result[0].tool_id == "tool_c"


def test_parse_tool_calls_uses_provided_item_id() -> None:
    """Item 'id' field is passed through to the call_id."""
    raw: list[Any] = [
        {"id": "call_specific", "function": {"name": "my_func", "arguments": "{}"}},
    ]
    result = _parse_tool_calls(raw)
    assert len(result) == 1
    assert result[0].call_id == "call_specific"


def test_parse_tool_calls_generates_id_when_absent() -> None:
    """When no 'id' is present, ensure_tool_call_id is invoked with the right
    metadata and its return value is threaded into the call_id.

    Patching the generator lets us assert the exact arguments _parse_tool_calls
    forwards (provider, tool_name, request_id, position) — without the recorder
    a broken call (wrong provider, swapped name, missing position) would still
    produce a non-empty id and pass a truthiness-only oracle.
    """
    raw: list[Any] = [
        {"function": {"name": "anon_func", "arguments": "{}"}},
    ]
    with patch.object(
        vllm_support, "ensure_tool_call_id", return_value="generated_id_42"
    ) as mock_ensure:
        result = _parse_tool_calls(raw, request_id="req-99")

    assert len(result) == 1
    # The generated id is the collaborator's return value, threaded verbatim.
    assert result[0].call_id == "generated_id_42"
    mock_ensure.assert_called_once_with(
        None,  # no item "id" → first positional arg is None
        provider="openai",
        tool_name="anon_func",
        request_id="req-99",
        position=0,
    )


def test_parse_tool_calls_returns_multiple_calls_in_order() -> None:
    """Multiple valid calls are returned in input order."""
    raw: list[Any] = [
        {"function": {"name": "alpha", "arguments": '{"n": 1}'}},
        {"function": {"name": "beta", "arguments": '{"n": 2}'}},
        {"function": {"name": "gamma", "arguments": '{"n": 3}'}},
    ]
    result = _parse_tool_calls(raw)
    assert len(result) == 3
    assert result[0].tool_id == "alpha"
    assert result[1].tool_id == "beta"
    assert result[2].tool_id == "gamma"
    assert result[0].arguments == {"n": 1}
    assert result[2].arguments == {"n": 3}


# ---------------------------------------------------------------------------
# _parse_tool_calls malformed-argument flagging (F13c)
#
# This parser used to swallow json.JSONDecodeError into ``{}`` and emit an
# otherwise-normal ToolCallRequest, so a truncated payload became a silent
# no-arg invocation -- while the STREAMING path rejected the identical wire
# shape (see tests/fixtures/replays/07-malformed-tool-arguments-vllm.json).
# ---------------------------------------------------------------------------


def test_parse_tool_calls_flags_truncated_json_arguments() -> None:
    """The exact wire shape the streaming replay fixture pins, non-streamed."""
    raw: list[Any] = [
        {"id": "call_bad", "function": {"name": "read_file", "arguments": '{"path":'}}
    ]
    result = _parse_tool_calls(raw)

    assert len(result) == 1, "the call is carried, not dropped"
    assert result[0].malformed_arguments is True
    assert result[0].arguments == {}


def test_parse_tool_calls_flags_non_object_json_arguments() -> None:
    """Valid JSON that is not an object is malformed for tool-call purposes."""
    raw: list[Any] = [{"function": {"name": "read_file", "arguments": "[1, 2, 3]"}}]
    result = _parse_tool_calls(raw)

    assert result[0].malformed_arguments is True
    assert result[0].arguments == {}


@pytest.mark.parametrize(
    "arguments",
    ['{"path": "a.txt"}', {"path": "a.txt"}],
)
def test_parse_tool_calls_does_not_flag_well_formed_arguments(arguments: Any) -> None:
    """Well-formed arguments -- string or dict -- stay unflagged."""
    raw: list[Any] = [{"function": {"name": "read_file", "arguments": arguments}}]
    result = _parse_tool_calls(raw)

    assert result[0].malformed_arguments is False
    assert result[0].arguments == {"path": "a.txt"}


@pytest.mark.parametrize("arguments", ["", None])
def test_parse_tool_calls_treats_absent_arguments_as_a_valid_no_arg_call(
    arguments: Any,
) -> None:
    """Absent/empty arguments are a legitimate no-arg call, not a parse failure."""
    raw: list[Any] = [{"function": {"name": "list_tools", "arguments": arguments}}]
    result = _parse_tool_calls(raw)

    assert result[0].malformed_arguments is False
    assert result[0].arguments == {}


def test_parse_tool_calls_flags_whitespace_only_arguments() -> None:
    """Whitespace-only arguments are malformed, matching the streaming path.

    Deliberate behaviour change: this parser used to ``.strip()`` first and
    treat ``"   "`` as a benign no-arg call, while the streaming normalizer
    already classified it as ``malformed_tool_arguments``. Unifying the two
    verdicts is the point of F13c -- the divergence WAS the defect.
    """
    raw: list[Any] = [{"function": {"name": "list_tools", "arguments": "   "}}]
    result = _parse_tool_calls(raw)

    assert result[0].malformed_arguments is True
    assert result[0].arguments == {}


# ---------------------------------------------------------------------------
# extract_reasoning_delta (F13a)
#
# The vLLM path historically read ONLY ``reasoning_content``. A build that
# spells the field ``reasoning`` dropped thinking text end-to-end AND silently
# disarmed the reasoning-only fail-closed guard, because that guard keys off
# the normalizer's reasoning-delta counter -- an unread spelling is
# indistinguishable from "the model never produced reasoning".
# ---------------------------------------------------------------------------


def test_extract_reasoning_delta_reads_reasoning_content() -> None:
    """The established vLLM spelling keeps working unchanged."""
    assert extract_reasoning_delta({"reasoning_content": "thinking"}) == "thinking"


def test_extract_reasoning_delta_falls_back_to_bare_reasoning() -> None:
    """A build emitting ``reasoning`` must not drop the thinking text."""
    assert extract_reasoning_delta({"reasoning": "thinking"}) == "thinking"


def test_extract_reasoning_delta_prefers_reasoning_content_over_reasoning() -> None:
    """Precedence is load-bearing: current behaviour must stay byte-identical."""
    delta = {"reasoning_content": "canonical", "reasoning": "fallback"}
    assert extract_reasoning_delta(delta) == "canonical"


def test_extract_reasoning_delta_skips_empty_reasoning_content() -> None:
    """An empty canonical field falls through rather than masking the fallback."""
    delta = {"reasoning_content": "", "reasoning": "fallback"}
    assert extract_reasoning_delta(delta) == "fallback"


@pytest.mark.parametrize(
    "delta",
    [
        {},
        {"content": "visible only"},
        {"reasoning_content": None, "reasoning": None},
        {"reasoning_content": 42, "reasoning": ["not", "a", "string"]},
        None,
        "not a mapping",
    ],
)
def test_extract_reasoning_delta_returns_empty_for_absent_or_malformed(delta: Any) -> None:
    """Absent, wrongly-typed, or non-mapping input degrades to the empty string."""
    assert extract_reasoning_delta(delta) == ""
