from __future__ import annotations

from sidecar.ai.engines.ollama import OllamaEngine
from sidecar.ai.engines.vision_input import VisionImage


def test_build_messages_translates_only_attached_row_images_to_base64() -> None:
    image = VisionImage(
        mime_type="image/png",
        width=64,
        height=48,
        frame_count=1,
        data=b"vision-payload",
    )
    result = OllamaEngine._build_messages(
        "",
        "",
        [
            {"role": "user", "content": "older"},
            {"role": "user", "content": "describe this", "images": [image]},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": "call-1", "name": "read_file", "arguments": {"path": "a.txt"}}
                ],
            },
        ],
    )

    assert "images" not in result[0]
    assert result[1]["images"] == [image.as_base64()]
    assert "images" not in result[2]
    assert result[2]["tool_calls"] == [
        {"function": {"name": "read_file", "arguments": {"path": "a.txt"}}}
    ]


def test_build_messages_skips_invalid_image_entries() -> None:
    image = VisionImage(
        mime_type="image/png",
        width=64,
        height=48,
        frame_count=1,
        data=b"vision-payload",
    )

    mixed = OllamaEngine._build_messages(
        "",
        "",
        [{"role": "user", "content": "describe this", "images": ["invalid", image]}],
    )
    all_invalid = OllamaEngine._build_messages(
        "",
        "",
        [{"role": "user", "content": "describe this", "images": ["invalid", object()]}],
    )

    assert mixed[0]["images"] == [image.as_base64()]
    assert "images" not in all_invalid[0]
