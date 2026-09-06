from __future__ import annotations

import pytest

from sidecar.runtime import chat_message_validation


def test_validate_chat_messages_rejects_message_count_over_cap() -> None:
    messages = [{"role": "user", "content": "hello"}] * (
        chat_message_validation.MAX_CHAT_MESSAGES_PER_REQUEST + 1
    )

    with pytest.raises(ValueError, match="at most"):
        chat_message_validation.validate_chat_messages(messages)


def test_validate_chat_messages_rejects_message_content_over_cap() -> None:
    messages = [
        {
            "role": "user",
            "content": "x" * (chat_message_validation.MAX_MESSAGE_CONTENT_BYTES + 1),
        }
    ]

    with pytest.raises(ValueError, match="content"):
        chat_message_validation.validate_chat_messages(messages)


def test_validate_chat_messages_accepts_nested_content_under_cap() -> None:
    chat_message_validation.validate_chat_messages(
        [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "hello"},
                    {"type": "input_image", "image_url": "local-reference"},
                ],
            }
        ]
    )


# ---------------------------------------------------------------------------
# validate_chat_messages – top-level structure guards
# ---------------------------------------------------------------------------


def test_validate_chat_messages_rejects_non_list() -> None:
    with pytest.raises(ValueError, match="must be a list"):
        chat_message_validation.validate_chat_messages({"role": "user", "content": "hi"})


def test_validate_chat_messages_rejects_non_dict_message() -> None:
    with pytest.raises(ValueError, match=r"messages\[0\] must be an object"):
        chat_message_validation.validate_chat_messages(["not a dict"])


def test_validate_chat_messages_rejects_missing_role() -> None:
    with pytest.raises(ValueError, match=r"messages\[0\]\.role is required"):
        chat_message_validation.validate_chat_messages([{"content": "hello"}])


def test_validate_chat_messages_rejects_blank_role() -> None:
    # _non_empty_string returns None for whitespace-only strings → role is None
    with pytest.raises(ValueError, match=r"messages\[0\]\.role is required"):
        chat_message_validation.validate_chat_messages([{"role": "   ", "content": "hello"}])


def test_validate_chat_messages_rejects_unknown_role() -> None:
    with pytest.raises(ValueError, match=r"messages\[0\]\.role must be one of"):
        chat_message_validation.validate_chat_messages([{"role": "bot", "content": "hello"}])


def test_validate_chat_messages_role_comparison_is_case_insensitive() -> None:
    # "User" (capital U) must be accepted – normalized_role = role.lower()
    chat_message_validation.validate_chat_messages([{"role": "User", "content": "hello"}])


# ---------------------------------------------------------------------------
# Happy-path: valid messages normalise and return None
# ---------------------------------------------------------------------------


def test_validate_chat_messages_happy_path_returns_none() -> None:
    result = chat_message_validation.validate_chat_messages(
        [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "What time is it?"},
            {"role": "assistant", "content": "It is noon."},
        ]
    )
    # validate_chat_messages returns None implicitly; assert it is not something else
    assert result is None


def test_validate_chat_messages_accepts_all_valid_roles() -> None:
    # All four allowed roles must pass without raising
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "usr"},
        {"role": "assistant", "content": "asst"},
        {
            "role": "tool",
            "content": "tool result",
            "tool_call_id": "call_abc",
        },
    ]
    chat_message_validation.validate_chat_messages(messages)


# ---------------------------------------------------------------------------
# _content_size_bytes – JSON serialisation path + fallback
# ---------------------------------------------------------------------------


def test_content_size_bytes_uses_json_for_list_content() -> None:
    # A list value must be serialised as JSON, not str()
    list_content = [{"type": "text", "text": "hi"}]
    import json as _json

    expected = len(_json.dumps(list_content, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    actual = chat_message_validation._content_size_bytes(list_content)
    assert actual == expected


def test_content_size_bytes_returns_zero_for_none() -> None:
    assert chat_message_validation._content_size_bytes(None) == 0


def test_content_size_bytes_uses_str_fallback_for_unserializable() -> None:
    # Objects that raise TypeError from json.dumps fall back to str()
    class _Unserializable:
        def __str__(self) -> str:
            return "REPR"

    obj = _Unserializable()
    result = chat_message_validation._content_size_bytes(obj)
    assert result == len("REPR".encode("utf-8"))


# ---------------------------------------------------------------------------
# _validate_string_when_present
# ---------------------------------------------------------------------------


def test_validate_string_when_present_raises_for_non_string_value() -> None:
    # key is present, value is not None, value is not str → must raise
    with pytest.raises(ValueError, match="must be a string when provided"):
        chat_message_validation._validate_string_when_present(
            {"mykey": 123},
            key="mykey",
            path="test.path.mykey",
        )


def test_validate_string_when_present_allows_absent_key() -> None:
    # key not in candidate → no raise
    chat_message_validation._validate_string_when_present({}, key="mykey", path="test.path.mykey")


def test_validate_string_when_present_allows_none_value() -> None:
    # key present but value is None → no raise
    chat_message_validation._validate_string_when_present(
        {"mykey": None}, key="mykey", path="test.path.mykey"
    )


def test_validate_string_when_present_allows_string_value() -> None:
    chat_message_validation._validate_string_when_present(
        {"mykey": "ok"}, key="mykey", path="test.path.mykey"
    )


# ---------------------------------------------------------------------------
# _tool_call_name – tool_id fallback + function.name path
# ---------------------------------------------------------------------------


def test_tool_call_name_uses_tool_id_when_name_absent() -> None:
    result = chat_message_validation._tool_call_name({"tool_id": "my_tool"})
    assert result == "my_tool"


def test_tool_call_name_uses_function_name_when_direct_absent() -> None:
    result = chat_message_validation._tool_call_name({"function": {"name": "do_thing"}})
    assert result == "do_thing"


def test_tool_call_name_returns_none_when_nothing_present() -> None:
    result = chat_message_validation._tool_call_name({})
    assert result is None


def test_tool_call_name_prefers_name_over_tool_id() -> None:
    result = chat_message_validation._tool_call_name({"name": "primary", "tool_id": "secondary"})
    assert result == "primary"


def test_tool_call_name_returns_none_when_function_has_blank_name() -> None:
    result = chat_message_validation._tool_call_name({"function": {"name": "   "}})
    assert result is None


# ---------------------------------------------------------------------------
# _validate_assistant_tool_calls – all branches
# ---------------------------------------------------------------------------


def test_validate_assistant_tool_calls_raises_when_not_list() -> None:
    with pytest.raises(ValueError, match=r"tool_calls.*must be a list"):
        chat_message_validation._validate_assistant_tool_calls("not a list", index=0)


def test_validate_assistant_tool_calls_raises_when_item_not_dict() -> None:
    with pytest.raises(ValueError, match=r"tool_calls\[0\].*must be an object"):
        chat_message_validation._validate_assistant_tool_calls(["not a dict"], index=0)


def test_validate_assistant_tool_calls_raises_when_name_missing() -> None:
    # id present, call_id absent, but neither name/tool_id/function.name present
    with pytest.raises(ValueError, match=r"tool_calls\[0\].*must include a tool name"):
        chat_message_validation._validate_assistant_tool_calls(
            [{"id": "call_1"}],
            index=0,
        )


def test_validate_assistant_tool_calls_raises_when_call_id_missing() -> None:
    # name present but neither id nor call_id present
    with pytest.raises(ValueError, match=r"tool_calls\[0\].*must include a non-empty call id"):
        chat_message_validation._validate_assistant_tool_calls(
            [{"name": "my_tool"}],
            index=0,
        )


def test_validate_assistant_tool_calls_raises_for_non_string_id_field() -> None:
    with pytest.raises(ValueError, match="must be a string when provided"):
        chat_message_validation._validate_assistant_tool_calls(
            [{"name": "my_tool", "id": 42, "call_id": "abc"}],
            index=0,
        )


def test_validate_assistant_tool_calls_raises_for_non_dict_function() -> None:
    with pytest.raises(ValueError, match=r"function.*must be an object when provided"):
        chat_message_validation._validate_assistant_tool_calls(
            [{"name": "my_tool", "id": "call_1", "function": "not a dict"}],
            index=0,
        )


def test_validate_assistant_tool_calls_raises_for_non_string_function_name() -> None:
    with pytest.raises(ValueError, match="must be a string when provided"):
        chat_message_validation._validate_assistant_tool_calls(
            [{"name": "my_tool", "id": "call_1", "function": {"name": 99}}],
            index=0,
        )


def test_validate_assistant_tool_calls_raises_for_invalid_arguments_type() -> None:
    # arguments must be dict or str; an int must raise
    with pytest.raises(ValueError, match=r"arguments.*must be an object or string"):
        chat_message_validation._validate_assistant_tool_calls(
            [{"name": "my_tool", "id": "call_1", "arguments": 42}],
            index=0,
        )


def test_validate_assistant_tool_calls_raises_for_invalid_function_arguments() -> None:
    # arguments nested inside function dict, invalid type
    with pytest.raises(ValueError, match=r"arguments.*must be an object or string"):
        chat_message_validation._validate_assistant_tool_calls(
            [
                {
                    "name": "my_tool",
                    "id": "call_1",
                    "function": {"name": "my_tool", "arguments": 3.14},
                }
            ],
            index=0,
        )


def test_validate_assistant_tool_calls_accepts_valid_call_with_dict_arguments() -> None:
    # Must not raise
    chat_message_validation._validate_assistant_tool_calls(
        [{"name": "my_tool", "id": "call_1", "arguments": {"key": "val"}}],
        index=0,
    )


def test_validate_assistant_tool_calls_accepts_valid_call_with_string_arguments() -> None:
    chat_message_validation._validate_assistant_tool_calls(
        [{"name": "my_tool", "id": "call_1", "arguments": '{"key":"val"}'}],
        index=0,
    )


def test_validate_assistant_tool_calls_uses_function_arguments_when_top_level_absent() -> None:
    # raw_arguments is None at top level → falls back to function.arguments
    # function.arguments is valid str → no raise
    chat_message_validation._validate_assistant_tool_calls(
        [{"name": "my_tool", "id": "call_1", "function": {"name": "my_tool", "arguments": '{"a":1}'}}],
        index=0,
    )


def test_validate_chat_messages_delegates_tool_calls_validation() -> None:
    # Integration: tool_calls on an assistant message with invalid item triggers the
    # delegate path through validate_chat_messages → _validate_assistant_tool_calls
    with pytest.raises(ValueError, match=r"tool_calls\[0\].*must be an object"):
        chat_message_validation.validate_chat_messages(
            [{"role": "assistant", "content": None, "tool_calls": ["not a dict"]}]
        )


# ---------------------------------------------------------------------------
# _validate_tool_message
# ---------------------------------------------------------------------------


def test_validate_tool_message_raises_when_tool_call_id_missing() -> None:
    with pytest.raises(ValueError, match=r"tool_call_id.*is required for tool messages"):
        chat_message_validation._validate_tool_message({"content": "result"}, index=2)


def test_validate_tool_message_raises_when_tool_call_id_blank() -> None:
    with pytest.raises(ValueError, match=r"tool_call_id.*is required for tool messages"):
        chat_message_validation._validate_tool_message(
            {"tool_call_id": "   ", "content": "result"}, index=0
        )


def test_validate_tool_message_raises_when_name_non_string() -> None:
    with pytest.raises(ValueError, match="must be a string when provided"):
        chat_message_validation._validate_tool_message(
            {"tool_call_id": "call_1", "name": 999}, index=0
        )


def test_validate_tool_message_accepts_valid_tool_message() -> None:
    # Must not raise
    chat_message_validation._validate_tool_message(
        {"tool_call_id": "call_1", "content": "ok", "name": "my_tool"}, index=0
    )


def test_validate_chat_messages_validates_tool_role_integration() -> None:
    # Integration: tool message missing tool_call_id raises through validate_chat_messages
    with pytest.raises(ValueError, match=r"tool_call_id.*is required for tool messages"):
        chat_message_validation.validate_chat_messages(
            [{"role": "tool", "content": "result"}]
        )


# ---------------------------------------------------------------------------
# _message_path helper
# ---------------------------------------------------------------------------


def test_message_path_without_field() -> None:
    result = chat_message_validation._message_path(3)
    assert result == "chat.send params.messages[3]"


def test_message_path_with_field() -> None:
    result = chat_message_validation._message_path(1, "role")
    assert result == "chat.send params.messages[1].role"


# ---------------------------------------------------------------------------
# _tool_call_identifier helper
# ---------------------------------------------------------------------------


def test_tool_call_identifier_uses_id() -> None:
    result = chat_message_validation._tool_call_identifier({"id": "call_abc"})
    assert result == "call_abc"


def test_tool_call_identifier_falls_back_to_call_id() -> None:
    result = chat_message_validation._tool_call_identifier({"call_id": "call_xyz"})
    assert result == "call_xyz"


def test_tool_call_identifier_returns_none_when_both_absent() -> None:
    result = chat_message_validation._tool_call_identifier({})
    assert result is None
