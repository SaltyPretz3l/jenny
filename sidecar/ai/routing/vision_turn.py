"""Pure helpers for attaching current-turn images to routed engine messages."""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from typing import TYPE_CHECKING, Any, cast

from sidecar.ai.context.compaction_window import (
    MID_TURN_ANSWERED_TASK_PREFIX,
    MID_TURN_TASK_STUB,
)
from sidecar.ai.engines.base import ModelModality
from sidecar.ai.engines.vision_input import VisionImage

if TYPE_CHECKING:
    from sidecar.ai.engines.base import EngineMessage

VISION_REFUSAL_MESSAGE = "The active model does not support image attachments."
VISION_ANCHOR_MESSAGE = "Image attachments could not be attached to this turn."


class VisionAnchorError(ValueError):
    """Raised when current-turn images have no eligible user-message anchor."""


def engine_supports_vision(engine: Any) -> bool:
    supported_modalities = cast(
        set[ModelModality],
        getattr(engine, "supported_modalities", set()),
    )
    if ModelModality.VISION in supported_modalities:
        return True
    capabilities = getattr(engine, "capabilities", {})
    return isinstance(capabilities, dict) and capabilities.get("vision") is True


def current_turn_anchor_index(
    messages: Sequence[Mapping[str, Any]],
    *,
    anchor_text: str | None = None,
) -> int | None:
    """Newest user row carrying the turn's prompt (or the pin stub mid-turn
    compaction leaves in its place); without a known prompt, the last
    non-empty user row."""

    normalized_anchor = str(anchor_text or "").strip()
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        content = message.get("content")
        if str(message.get("role") or "").strip().lower() != "user":
            continue
        if not isinstance(content, str):
            continue
        # A pin answered in-turn carries the prefix; compare the bare text so a
        # prefixed prompt or stub still anchors on every later pass.
        text = content.strip().removeprefix(MID_TURN_ANSWERED_TASK_PREFIX).strip()
        if normalized_anchor:
            if text in {normalized_anchor, MID_TURN_TASK_STUB}:
                return index
        elif text:
            return index
    return None


def engine_messages_with_vision_degradation(  # noqa: PLR0913
    build_messages: Any,
    messages: list[dict[str, object]],
    *,
    primary_system_text: str,
    vision_images: Sequence[VisionImage],
    vision_anchor_text: str,
    runtime: Any,
    on_anchor_lost: Callable[[int, int], None],
) -> list[EngineMessage]:
    """Fail closed on generation one, then drop images if compaction lost the anchor."""

    try:
        return build_messages(
            messages,
            primary_system_text=primary_system_text,
            **(
                {"vision_images": vision_images, "vision_anchor_text": vision_anchor_text}
                if vision_images else {}
            ),
        )
    except VisionAnchorError:
        iteration = int(getattr(runtime, "current_iteration", 0) or 0)
        if iteration <= 0:
            iteration = int(getattr(runtime, "iteration_base", 0) or 0) + 1
        if iteration <= 1:
            raise
    on_anchor_lost(iteration, len(vision_images))
    return build_messages(messages, primary_system_text=primary_system_text)


def vision_token_surcharge(vision_images: Sequence[VisionImage]) -> int:
    total = 0
    for image in vision_images:
        tiles = math.ceil(image.width / 512) * math.ceil(image.height / 512)
        total += min(85 + (170 * tiles), 4096)
    return total
