"""Mid-turn steering (row 180): take the person's parked messages at the top of a loop iteration.

``session.user_steer_arrived`` parks items on the turn's queue (``turn_steers``). Each iteration,
after the preflight stop check (so a stopped turn never acknowledges a message no generation reads;
the item stays parked and Electron releases it as the next turn), the tool loop appends every
parked item, in arrival order, as a ``role:"user"`` working message, then emits the ephemeral
``session.user_steer_consumed``
acknowledgement before the generation that sees the items. Images ride the same vision seam as
the turn prompt (``normalize_vision_attachments`` against the managed attachment root); a model
without vision, or an image that cannot be loaded, gets one ``[image: <name>]`` line instead,
never a silent drop. A sub-agent never drains its parent's items. Logs carry counts, never text
or an image name.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from typing import TYPE_CHECKING, Any

from sidecar.ai.routing.loop_events import UserSteerConsumedEvent
from sidecar.ai.routing.vision_turn import engine_supports_vision
from sidecar.runtime.turn_steers import SteerItem, current_pending_steers

if TYPE_CHECKING:
    from sidecar.ai.routing.tool_loop_run import _ToolLoopRun

logger = logging.getLogger(__name__)

_MAX_IMAGE_NAME_CHARS = 80
_DEFAULT_IMAGE_NAME = "image"
_UNSAFE_CATEGORIES = frozenset({"Cc", "Cf", "Zl", "Zp"})
_WHITESPACE_RE = re.compile(r"\s+")


def _image_name(image: dict[str, Any]) -> str:
    """A one-line, bracket-free label for an image attachment (names are untrusted)."""
    raw = image.get("display_name", image.get("displayName"))
    text = raw if isinstance(raw, str) else ""
    spaced = "".join(
        " " if ch in "[]`" or unicodedata.category(ch) in _UNSAFE_CATEGORIES else ch for ch in text
    )
    clean = _WHITESPACE_RE.sub(" ", spaced).strip()
    if len(clean) > _MAX_IMAGE_NAME_CHARS:
        clean = f"{clean[: _MAX_IMAGE_NAME_CHARS - 1]}…"
    return clean or _DEFAULT_IMAGE_NAME


def _name_lines(images: tuple[dict[str, Any], ...]) -> str:
    return "\n".join(f"[image: {_image_name(image)}]" for image in images)


def _vision_images(item: SteerItem, loop: "_ToolLoopRun") -> list[Any] | None:
    """The item's images as provider-ready ``VisionImage`` values, or None when any cannot load."""
    from sidecar.runtime.vision_attachments import (
        managed_image_attachment_root,
        normalize_vision_attachments,
    )

    root = managed_image_attachment_root(getattr(loop.kernel, "_config", None))
    try:
        normalized = normalize_vision_attachments(list(item.images), managed_root=root)
    except ValueError:
        return None
    images = [entry.get("_vision_image") for entry in normalized]
    return images if all(image is not None for image in images) else None


def _working_message(item: SteerItem, loop: "_ToolLoopRun", *, vision: bool) -> dict[str, Any]:
    # ``steer`` keeps the row out of the turn-prompt searches (vision anchor, compaction task).
    message: dict[str, Any] = {"role": "user", "content": item.content, "steer": True}
    if not item.images:
        return message
    images = _vision_images(item, loop) if vision else None
    if images:
        return {**message, "images": images}
    return {**message, "content": f"{item.content}\n{_name_lines(item.images)}"}


def drain_user_steers(loop: "_ToolLoopRun", iteration: int) -> None:
    """Append parked steer items before the next generation, then acknowledge them all."""
    import sidecar.ai.routing.tool_loop as _tl_hub

    if loop.is_sub_agent_request:
        return
    pending = current_pending_steers()
    if pending is None:
        return
    items = pending.drain()
    if not items:
        return
    vision = engine_supports_vision(getattr(loop.kernel, "_engine", None))
    for item in items:
        loop.working_messages.append(_working_message(item, loop, vision=vision))
    item_ids = [item.item_id for item in items]
    loop.runtime.emit(UserSteerConsumedEvent(item_ids=item_ids, iteration=iteration))
    _tl_hub.log_event(
        logger,
        logging.INFO,
        component="ai.router",
        event="ai.router.user_steers_consumed",
        message="Mid-turn user steers joined the working messages.",
        status="active",
        data={
            "count": len(item_ids),
            "images": sum(len(item.images) for item in items),
            "iteration": iteration,
        },
        request_id=loop.request_id,
        session_id=loop.session_id,
    )
