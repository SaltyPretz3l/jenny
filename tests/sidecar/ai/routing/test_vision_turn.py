from __future__ import annotations

import base64
from types import SimpleNamespace

import pytest

from sidecar.ai.context.compaction_window import (
    MID_TURN_ANSWERED_TASK_PREFIX,
    MID_TURN_TASK_STUB,
)
from sidecar.ai.context.messages import compact_semantic_messages, sanitize_semantic_message
from sidecar.ai.engines.base import ModelModality
from sidecar.ai.engines.vision_input import VisionImage
from sidecar.ai.routing.vision_turn import (
    current_turn_anchor_index,
    engine_supports_vision,
    vision_token_surcharge,
)


def _image(width: int = 64, height: int = 48) -> VisionImage:
    return VisionImage(
        mime_type="image/png",
        width=width,
        height=height,
        frame_count=1,
        data=b"image-bytes",
    )


def test_current_turn_anchor_index_picks_last_non_empty_user_row() -> None:
    messages = [
        {"role": "user", "content": "older"},
        {"role": "user", "content": "   "},
        {"role": "user", "content": "current"},
        {"role": "assistant", "content": "trailing assistant"},
        {"role": "tool", "content": "trailing tool"},
    ]

    assert current_turn_anchor_index(messages) == 2


def test_current_turn_anchor_index_returns_none_without_eligible_user_row() -> None:
    assert current_turn_anchor_index(
        [
            {"role": "assistant", "content": "answer"},
            {"role": "user", "content": ""},
            {"role": "user", "content": None},
        ]
    ) is None


@pytest.mark.parametrize(
    ("messages", "anchor_text", "expected"),
    [
        ([{"role": "user", "content": "target"}], "target", 0),
        (
            [
                {"role": "user", "content": "target"},
                {"role": "assistant", "content": "between"},
                {"role": "user", "content": "target"},
            ],
            "target",
            2,
        ),
        ([{"role": "user", "content": "target"}], "missing", None),
        ([{"role": "user", "content": "hi"}], " hi ", 0),
        ([{"role": "user", "content": "hi"}], "Hi", None),
    ],
)
def test_current_turn_anchor_index_matches_exact_anchor_text(
    messages: list[dict[str, object]],
    anchor_text: str,
    expected: int | None,
) -> None:
    assert current_turn_anchor_index(messages, anchor_text=anchor_text) == expected


def test_current_turn_anchor_index_accepts_mid_turn_task_stub() -> None:
    # Mid-turn compaction replaces an oversized prompt row with the pin stub;
    # later loop nudges are user rows too, so the stub must still win.
    messages = [
        {"role": "system", "content": "summary"},
        {"role": "user", "content": MID_TURN_TASK_STUB},
        {"role": "assistant", "content": "calling a tool"},
        {"role": "user", "content": "Continue with the tools available."},
    ]

    assert current_turn_anchor_index(messages, anchor_text="original prompt") == 1
    assert current_turn_anchor_index(messages) == 3


def test_current_turn_anchor_index_matches_the_answered_task_prefix() -> None:
    messages = [
        {"role": "system", "content": "summary"},
        {"role": "user", "content": MID_TURN_ANSWERED_TASK_PREFIX + "original prompt"},
        {"role": "assistant", "content": "calling a tool"},
        {"role": "user", "content": "Continue with the tools available."},
    ]

    assert current_turn_anchor_index(messages, anchor_text="original prompt") == 1
    assert current_turn_anchor_index(messages, anchor_text="another prompt") is None


def test_semantic_compaction_drops_vision_images_and_image_bytes() -> None:
    image = _image()
    encoded = base64.b64encode(image.data).decode("ascii")
    row = {"role": "user", "content": "describe", "images": [image]}

    sanitized = sanitize_semantic_message(row)
    compacted = compact_semantic_messages([row])

    assert sanitized is not None and "images" not in sanitized
    assert compacted and "images" not in compacted[0]
    assert encoded not in repr((sanitized, compacted))


@pytest.mark.parametrize(
    ("width", "height", "expected"),
    [(64, 48, 255), (1024, 1024, 765), (10_000, 10_000, 4096)],
)
def test_vision_token_surcharge(width: int, height: int, expected: int) -> None:
    assert vision_token_surcharge((_image(width, height),)) == expected


def test_vision_token_surcharge_is_zero_without_images() -> None:
    assert vision_token_surcharge(()) == 0


def test_engine_supports_vision_via_modalities_or_capabilities() -> None:
    assert engine_supports_vision(
        SimpleNamespace(supported_modalities={ModelModality.VISION}, capabilities={})
    )
    assert engine_supports_vision(
        SimpleNamespace(supported_modalities=set(), capabilities={"vision": True})
    )
    assert not engine_supports_vision(
        SimpleNamespace(supported_modalities={ModelModality.TEXT}, capabilities={"vision": False})
    )


# Astra B5 review: the anchor must survive a prefixed stub and a prefixed prompt.
def test_current_turn_anchor_index_matches_a_prefixed_stub() -> None:
    from sidecar.ai.context.compaction_window import (
        MID_TURN_ANSWERED_TASK_PREFIX,
        MID_TURN_TASK_STUB,
    )

    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": MID_TURN_ANSWERED_TASK_PREFIX + MID_TURN_TASK_STUB},
        {"role": "assistant", "content": "ok"},
        {"role": "user", "content": "corrective"},
    ]
    assert current_turn_anchor_index(messages, anchor_text="Build M4") == 1
