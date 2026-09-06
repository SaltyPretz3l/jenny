"""build_input_items contract tests for the ChatGPT-subscription engine.

Sibling of test_chatgpt_subscription.py (which sits at the 1015-line file-size
cap): pure request-serialization coverage for the "(no content)" placeholder
suppression — the imitation-poisoning guard.
"""

from __future__ import annotations

from sidecar.ai.context.messages import EMPTY_ASSISTANT_CONTENT_PLACEHOLDER
from sidecar.ai.engines.chatgpt_subscription_request import build_input_items
from sidecar.ai.engines.vision_input import VisionImage


def _image(data: bytes) -> VisionImage:
    return VisionImage(
        mime_type="image/png",
        width=64,
        height=48,
        frame_count=1,
        data=data,
    )


def test_build_input_items_appends_user_images_after_text() -> None:
    images = [_image(b"first"), _image(b"second")]

    _instructions, items = build_input_items(
        prompt="",
        system="",
        messages=[
            {
                "role": "user",
                "content": "Compare these",
                "images": [images[0], object(), images[1]],
            }
        ],
    )

    assert items[0]["content"] == [
        {"type": "input_text", "text": "Compare these"},
        {
            "type": "input_image",
            "image_url": images[0].as_data_uri(),
            "detail": "auto",
        },
        {
            "type": "input_image",
            "image_url": images[1].as_data_uri(),
            "detail": "auto",
        },
    ]
    assert all(
        part["image_url"].startswith("data:image/png;base64,")
        for part in items[0]["content"][1:]
    )


def test_build_input_items_emits_image_only_user_row() -> None:
    image = _image(b"only-image")

    _instructions, items = build_input_items(
        prompt="",
        system="",
        messages=[{"role": "user", "content": "", "images": [image]}],
    )

    assert items == [
        {
            "type": "message",
            "role": "user",
            "content": [
                {
                    "type": "input_image",
                    "image_url": image.as_data_uri(),
                    "detail": "auto",
                }
            ],
        }
    ]


def test_build_input_items_omits_empty_user_row_with_invalid_image() -> None:
    _instructions, items = build_input_items(
        prompt="",
        system="",
        messages=[{"role": "user", "content": "", "images": ["not-an-image"]}],
    )

    assert items == []


def test_build_input_items_ignores_assistant_images_and_preserves_older_user() -> None:
    image = _image(b"stray")

    _instructions, items = build_input_items(
        prompt="",
        system="",
        messages=[
            {"role": "user", "content": "older"},
            {"role": "assistant", "content": "reply", "images": [image]},
        ],
    )

    assert items == [
        {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "older"}],
        },
        {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "reply"}],
        },
    ]


def test_build_input_items_plain_user_shape_is_unchanged() -> None:
    _instructions, items = build_input_items(
        prompt="",
        system="",
        messages=[{"role": "user", "content": "plain"}],
    )

    assert items == [
        {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "plain"}],
        }
    ]


def test_build_input_items_omits_placeholder_message_for_tool_call_rows() -> None:
    """The "(no content)" backfill must not become a standalone output_text item.

    Serialized as free-standing assistant messages, the placeholder reads as a
    few-shot pattern ("assistant says '(no content)', then calls a tool") and
    gpt-5.x starts imitating it as visible text. Tool-call rows already
    serialize correctly as bare function_call items.
    """
    instructions, items = build_input_items(
        prompt="",
        system="sys",
        messages=[
            {"role": "user", "content": "Read it"},
            {
                "role": "assistant",
                "content": EMPTY_ASSISTANT_CONTENT_PLACEHOLDER,
                "tool_calls": [
                    {"name": "read_file", "arguments": {"path": "a.md"}, "call_id": "call_1"}
                ],
            },
            {"role": "tool", "tool_call_id": "call_1", "content": "contents a"},
            {
                "role": "assistant",
                "content": EMPTY_ASSISTANT_CONTENT_PLACEHOLDER,
                "tool_calls": [
                    {"name": "read_file", "arguments": {"path": "b.md"}, "call_id": "call_2"}
                ],
            },
            {"role": "tool", "tool_call_id": "call_2", "content": "contents b"},
        ],
    )

    assert instructions == "sys"
    placeholder_messages = [
        item
        for item in items
        if item.get("type") == "message"
        and any(
            part.get("text") == EMPTY_ASSISTANT_CONTENT_PLACEHOLDER
            for part in item.get("content", [])
        )
    ]
    assert placeholder_messages == []
    kinds = [(item.get("type"), item.get("call_id")) for item in items]
    assert ("function_call", "call_1") in kinds
    assert ("function_call_output", "call_1") in kinds
    assert ("function_call", "call_2") in kinds
    assert ("function_call_output", "call_2") in kinds


def test_build_input_items_preserves_genuine_commentary_before_function_call() -> None:
    _instructions, items = build_input_items(
        prompt="",
        system="sys",
        messages=[
            {"role": "user", "content": "Inspect it"},
            {
                "role": "assistant",
                "content": "I’ll inspect the relevant file first.",
                "tool_calls": [
                    {"name": "read_file", "arguments": {"path": "a.md"}, "call_id": "call_1"}
                ],
            },
            {"role": "tool", "tool_call_id": "call_1", "content": "contents"},
        ],
    )

    call_index = next(
        index for index, item in enumerate(items) if item.get("type") == "function_call"
    )
    commentary = items[call_index - 1]
    assert commentary["type"] == "message"
    assert commentary["role"] == "assistant"
    assert commentary["content"] == [
        {"type": "output_text", "text": "I’ll inspect the relevant file first."}
    ]


def test_build_input_items_keeps_placeholder_text_without_tool_calls() -> None:
    """A genuine assistant reply that happens to read "(no content)" survives."""
    _instructions, items = build_input_items(
        prompt="",
        system="",
        messages=[
            {"role": "user", "content": "say it"},
            {"role": "assistant", "content": EMPTY_ASSISTANT_CONTENT_PLACEHOLDER},
        ],
    )

    assert {
        "type": "message",
        "role": "assistant",
        "content": [
            {"type": "output_text", "text": EMPTY_ASSISTANT_CONTENT_PLACEHOLDER}
        ],
    } in items


def test_build_input_items_reasoning_precedes_call_after_placeholder_omission() -> None:
    """Captured reasoning items still ride directly before their function_call."""
    reasoning_item = {"type": "reasoning", "id": "rs_1"}
    image = _image(b"latest-user-image")
    _instructions, items = build_input_items(
        prompt="",
        system="",
        messages=[
            {"role": "user", "content": "Read it", "images": [image]},
            {
                "role": "assistant",
                "content": EMPTY_ASSISTANT_CONTENT_PLACEHOLDER,
                "tool_calls": [
                    {"name": "read_file", "arguments": {"path": "a.md"}, "call_id": "call_1"}
                ],
            },
            {"role": "tool", "tool_call_id": "call_1", "content": "contents"},
        ],
        reasoning_by_call_id={"call_1": reasoning_item},
    )

    call_index = next(
        index for index, item in enumerate(items) if item.get("type") == "function_call"
    )
    assert items[0]["content"] == [
        {"type": "input_text", "text": "Read it"},
        {
            "type": "input_image",
            "image_url": image.as_data_uri(),
            "detail": "auto",
        },
    ]
    assert items[call_index - 1] is reasoning_item
