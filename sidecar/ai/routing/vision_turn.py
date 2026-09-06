"""Pure helpers for attaching current-turn images to routed engine messages."""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from typing import TYPE_CHECKING, Any, cast

from sidecar.ai.context.compaction_window import MID_TURN_TASK_STUB
from sidecar.ai.engines.base import BaseEngine, ModelModality
from sidecar.ai.engines.vision_input import VisionImage
from sidecar.ai.feature_flags import FEATURE_VISION_UNIFIED_TURN

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


def legacy_vision_generation_supported(engine: Any) -> bool:
    """The flag-off fork calls ``generate_with_vision``; engines that only
    speak the unified turn (ChatGPT) must refuse there instead of reaching the
    base class's ``NotImplementedError``."""

    method = getattr(type(engine), "generate_with_vision", None)
    return method is not None and method is not BaseEngine.generate_with_vision


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
        text = content.strip()
        if normalized_anchor:
            if text in {normalized_anchor, MID_TURN_TASK_STUB}:
                return index
        elif text:
            return index
    return None


def attach_vision_images(
    engine_messages: list[EngineMessage],
    *,
    vision_images: Sequence[VisionImage],
    anchor_text: str = "",
) -> list[EngineMessage]:
    """Attach images to the current-turn user row used by the live lane."""

    if not vision_images:
        return engine_messages
    anchor_index = current_turn_anchor_index(engine_messages, anchor_text=anchor_text)
    if anchor_index is None:
        raise VisionAnchorError(VISION_ANCHOR_MESSAGE)
    engine_messages[anchor_index]["images"] = list(vision_images)
    return engine_messages


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


def vision_unified_turn_enabled(flags: Mapping[str, bool] | None) -> bool:
    if not isinstance(flags, Mapping):
        return True
    return flags.get(FEATURE_VISION_UNIFIED_TURN, True)
