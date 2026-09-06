"""Structural validation for chat.send message history."""

from __future__ import annotations

import json
from typing import Any

_ALLOWED_MESSAGE_ROLES = frozenset({"system", "user", "assistant", "tool"})
MAX_CHAT_MESSAGES_PER_REQUEST = 1024
MAX_MESSAGE_CONTENT_BYTES = 256 * 1024


def _message_path(index: int, field: str | None = None) -> str:
    base = f"chat.send params.messages[{index}]"
    return f"{base}.{field}" if field else base


def _non_empty_string(value: Any) -> str | None:
    if isinstance(value, str):
        normalized = value.strip()
        return normalized or None
    return None


def _tool_call_name(candidate: dict[str, Any]) -> str | None:
    direct = _non_empty_string(candidate.get("name")) or _non_empty_string(candidate.get("tool_id"))
    if direct is not None:
        return direct
    function = candidate.get("function")
    if isinstance(function, dict):
        return _non_empty_string(function.get("name"))
    return None


def _tool_call_identifier(candidate: dict[str, Any]) -> str | None:
    return _non_empty_string(candidate.get("id")) or _non_empty_string(candidate.get("call_id"))


def _validate_string_when_present(
    candidate: dict[str, Any],
    *,
    key: str,
    path: str,
) -> None:
    value = candidate.get(key)
    if key in candidate and value is not None and not isinstance(value, str):
        raise ValueError(f"{path} must be a string when provided.")


def _content_size_bytes(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, str):
        return len(value.encode("utf-8"))
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        encoded = str(value)
    return len(encoded.encode("utf-8"))


def _validate_assistant_tool_calls(tool_calls: Any, index: int) -> None:
    if not isinstance(tool_calls, list):
        raise ValueError(f"{_message_path(index, 'tool_calls')} must be a list when provided.")
    for call_index, raw_call in enumerate(tool_calls):
        if not isinstance(raw_call, dict):
            raise ValueError(
                f"{_message_path(index, f'tool_calls[{call_index}]')} must be an object."
            )
        if _tool_call_name(raw_call) is None:
            raise ValueError(
                f"{_message_path(index, f'tool_calls[{call_index}]')} must include a tool name."
            )
        if _tool_call_identifier(raw_call) is None:
            raise ValueError(
                f"{_message_path(index, f'tool_calls[{call_index}]')} must include a non-empty call id."
            )
        for key in ("id", "call_id", "tool_id", "name"):
            _validate_string_when_present(
                raw_call,
                key=key,
                path=_message_path(index, f"tool_calls[{call_index}].{key}"),
            )
        function = raw_call.get("function")
        if function is not None and not isinstance(function, dict):
            raise ValueError(
                f"{_message_path(index, f'tool_calls[{call_index}].function')} must be an object when provided."
            )
        if isinstance(function, dict):
            _validate_string_when_present(
                function,
                key="name",
                path=_message_path(index, f"tool_calls[{call_index}].function.name"),
            )
        raw_arguments = raw_call.get("arguments")
        if raw_arguments is None and isinstance(function, dict):
            raw_arguments = function.get("arguments")
        if raw_arguments is not None and not isinstance(raw_arguments, (dict, str)):
            raise ValueError(
                f"{_message_path(index, f'tool_calls[{call_index}].arguments')} must be an object or string when provided."
            )


def _validate_tool_message(message: dict[str, Any], index: int) -> None:
    tool_call_id = _non_empty_string(message.get("tool_call_id"))
    if tool_call_id is None:
        raise ValueError(f"{_message_path(index, 'tool_call_id')} is required for tool messages.")
    _validate_string_when_present(message, key="name", path=_message_path(index, "name"))


def validate_chat_messages(messages: Any) -> None:
    if not isinstance(messages, list):
        raise ValueError("chat.send params.messages must be a list.")
    if len(messages) > MAX_CHAT_MESSAGES_PER_REQUEST:
        raise ValueError(
            "chat.send params.messages must include at most "
            f"{MAX_CHAT_MESSAGES_PER_REQUEST} entries."
        )
    for index, raw_message in enumerate(messages):
        if not isinstance(raw_message, dict):
            raise ValueError(f"{_message_path(index)} must be an object.")
        content_size = _content_size_bytes(raw_message.get("content"))
        if content_size > MAX_MESSAGE_CONTENT_BYTES:
            raise ValueError(
                f"{_message_path(index, 'content')} must be at most "
                f"{MAX_MESSAGE_CONTENT_BYTES} bytes."
            )
        role = _non_empty_string(raw_message.get("role"))
        if role is None:
            raise ValueError(f"{_message_path(index, 'role')} is required.")
        normalized_role = role.lower()
        if normalized_role not in _ALLOWED_MESSAGE_ROLES:
            allowed = ", ".join(sorted(_ALLOWED_MESSAGE_ROLES))
            raise ValueError(f"{_message_path(index, 'role')} must be one of: {allowed}.")
        if normalized_role == "assistant" and "tool_calls" in raw_message:
            _validate_assistant_tool_calls(raw_message.get("tool_calls"), index)
        if normalized_role == "tool":
            _validate_tool_message(raw_message, index)
