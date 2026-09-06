"""Current-turn vision attachment normalization and bounded diagnostics."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from sidecar.ai.engines.vision_input import (
    MAX_VISION_AGGREGATE_BYTES,
    MAX_VISION_ATTACHMENTS,
    VisionInputError,
    load_vision_image_path,
)
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

_MANAGED_ROOT_UNSET = object()


def _optional_string(
    attachment: dict[str, Any],
    field: str,
    *,
    legacy_field: str | None = None,
) -> str:
    selected_field = field if field in attachment or legacy_field is None else legacy_field
    value = attachment.get(selected_field)
    if value is None:
        return ""
    if not isinstance(value, str):
        raise VisionInputError("type", f"Image attachment {selected_field} must be a string.")
    return value.strip()


def _log_rejection(error: VisionInputError, *, index: int, count: int) -> None:
    log_event(
        logger,
        logging.WARNING,
        component="runtime.chat_vision",
        event="runtime.chat_vision.attachment_rejected",
        message="Rejected an image attachment at the sidecar trust boundary.",
        status="blocked",
        data={
            "reason": error.reason,
            "attachment_index": index,
            "attachment_count": count,
        },
    )


def normalize_vision_attachments(
    attachments: Any,
    *,
    managed_root: Any = _MANAGED_ROOT_UNSET,
) -> list[dict[str, object]]:
    """Validate and materialize image files once, before engine dispatch."""

    if attachments is None:
        return []
    if not isinstance(attachments, list):
        raise ValueError("chat.send params.attachments must be a list")
    if not attachments:
        return []
    count = len(attachments)
    if count > MAX_VISION_ATTACHMENTS:
        error = VisionInputError(
            "attachment_count",
            f"chat.send supports at most {MAX_VISION_ATTACHMENTS} image attachments",
        )
        _log_rejection(error, index=-1, count=count)
        raise ValueError(str(error)) from error
    if managed_root is None or (
        managed_root is not _MANAGED_ROOT_UNSET and not str(managed_root).strip()
    ):
        raise ValueError(
            "chat.send image attachments require a configured managed attachment root"
        )
    root: str | Path | None = None if managed_root is _MANAGED_ROOT_UNSET else managed_root
    normalized: list[dict[str, object]] = []
    aggregate_bytes = 0
    for index, attachment in enumerate(attachments):
        try:
            if not isinstance(attachment, dict):
                raise VisionInputError("type", "chat.send image attachments must be objects")
            kind = _optional_string(attachment, "kind").lower()
            if kind != "image":
                raise VisionInputError(
                    "kind",
                    "chat.send top-level attachments only support image entries",
                )
            # CamelCase remains accepted until the Electron sender migrates in the renderer wave.
            asset_path = _optional_string(attachment, "asset_path", legacy_field="assetPath")
            if not asset_path:
                raise VisionInputError(
                    "path",
                    "chat.send image attachments require assetPath",
                )
            declared_mime = _optional_string(attachment, "mime_type", legacy_field="mimeType")
            resolved_path, image = load_vision_image_path(
                asset_path,
                declared_mime_type=declared_mime,
                managed_root=root,
            )
            aggregate_bytes += image.decoded_bytes
            if aggregate_bytes > MAX_VISION_AGGREGATE_BYTES:
                raise VisionInputError(
                    "aggregate_bytes",
                    "chat.send image attachments exceed the aggregate decoded-byte limit",
                )
            normalized.append(
                {
                    "id": _optional_string(attachment, "id"),
                    "kind": "image",
                    "display_name": _optional_string(
                        attachment,
                        "display_name",
                        legacy_field="displayName",
                    ),
                    "mime_type": image.mime_type,
                    "asset_path": str(resolved_path),
                    "source_kind": _optional_string(
                        attachment,
                        "source_kind",
                        legacy_field="sourceKind",
                    ),
                    "size_bytes": image.decoded_bytes,
                    "width": image.width,
                    "height": image.height,
                    "_vision_image": image,
                }
            )
        except VisionInputError as error:
            _log_rejection(error, index=index, count=count)
            raise ValueError(str(error)) from error
    return normalized


__all__ = ["normalize_vision_attachments"]
