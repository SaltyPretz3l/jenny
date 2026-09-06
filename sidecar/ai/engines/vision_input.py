"""Typed, bounded image ingestion shared by vision-capable engines."""

from __future__ import annotations

import base64
import binascii
import io
import os
import stat
import warnings
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from typing import Any, Sequence, TypeAlias

MAX_VISION_ATTACHMENTS = 4
MAX_VISION_IMAGE_BYTES = 10_000_000
MAX_VISION_AGGREGATE_BYTES = 20_000_000
MAX_VISION_PIXELS = 40_000_000
MAX_VISION_FRAMES = 16
_WEBP_HEADER_BYTES = 12

_MIME_ALIASES = {"image/jpg": "image/jpeg"}
_FORMAT_TO_MIME = {
    "BMP": "image/bmp",
    "GIF": "image/gif",
    "JPEG": "image/jpeg",
    "PNG": "image/png",
    "WEBP": "image/webp",
}


class VisionInputError(ValueError):
    """A bounded, user-safe refusal raised at the image trust boundary."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


@dataclass(frozen=True)
class VisionImage:
    """Validated image bytes; raw data is deliberately absent from repr/logs."""

    mime_type: str
    width: int
    height: int
    frame_count: int
    data: bytes = field(repr=False)

    @property
    def decoded_bytes(self) -> int:
        return len(self.data)

    @cached_property
    def _base64(self) -> str:
        return base64.b64encode(self.data).decode("ascii")

    def as_base64(self) -> str:
        return self._base64

    def as_data_uri(self) -> str:
        return f"data:{self.mime_type};base64,{self.as_base64()}"


VisionInput: TypeAlias = str | VisionImage


def _normalized_mime_type(value: Any) -> str:
    if not isinstance(value, str):
        raise VisionInputError("mime_type", "Image attachment mimeType must be a string.")
    normalized = value.strip().lower()
    return _MIME_ALIASES.get(normalized, normalized)


def _signature_mime_type(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if (
        len(data) >= _WEBP_HEADER_BYTES
        and data[:4] == b"RIFF"
        and data[8:12] == b"WEBP"
    ):
        return "image/webp"
    if data.startswith(b"BM"):
        return "image/bmp"
    return None


def _load_pil():
    # Pillow ships in the optional `media` extra and is absent from the locked
    # packaged-artifact profile, so this import must stay lazy: a module-level
    # import puts PIL on the sidecar boot path (ollama_generation ->
    # vision_input) and crashes the packaged sidecar at startup.
    try:
        from PIL import Image, UnidentifiedImageError
    except Exception as exc:  # noqa: BLE001
        raise VisionInputError(
            "dependency_missing",
            "Vision attachments require the optional Pillow dependency (media extra).",
        ) from exc
    return Image, UnidentifiedImageError


def vision_image_from_bytes(data: bytes, *, declared_mime_type: str = "") -> VisionImage:
    """Validate signature, declared MIME, dimensions, frames, and bytes."""

    if not isinstance(data, bytes) or not data:
        raise VisionInputError("empty", "Image attachment is empty.")
    if len(data) > MAX_VISION_IMAGE_BYTES:
        raise VisionInputError(
            "image_bytes",
            f"Image attachment exceeds the {MAX_VISION_IMAGE_BYTES}-byte limit.",
        )
    signature_mime = _signature_mime_type(data)
    if signature_mime is None:
        raise VisionInputError("signature", "Image attachment has an unsupported signature.")
    declared_mime = _normalized_mime_type(declared_mime_type)
    if declared_mime and declared_mime != signature_mime:
        raise VisionInputError(
            "mime_mismatch",
            "Image attachment mimeType does not match its file signature.",
        )
    Image, UnidentifiedImageError = _load_pil()
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                format_mime = _FORMAT_TO_MIME.get(str(image.format or "").upper())
                width, height = image.size
                frame_count = int(getattr(image, "n_frames", 1) or 1)
                if format_mime != signature_mime:
                    raise VisionInputError(
                        "format_mismatch",
                        "Image attachment decoder format does not match its signature.",
                    )
                if width <= 0 or height <= 0:
                    raise VisionInputError("dimensions", "Image attachment dimensions are invalid.")
                if frame_count > MAX_VISION_FRAMES:
                    raise VisionInputError(
                        "frame_count",
                        f"Image attachment exceeds the {MAX_VISION_FRAMES}-frame limit.",
                    )
                if width * height * frame_count > MAX_VISION_PIXELS:
                    raise VisionInputError(
                        "pixels",
                        f"Image attachment exceeds the {MAX_VISION_PIXELS}-pixel limit.",
                    )
                image.verify()
    except VisionInputError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise VisionInputError(
            "pixels",
            f"Image attachment exceeds the {MAX_VISION_PIXELS}-pixel limit.",
        ) from error
    except (OSError, SyntaxError, UnidentifiedImageError, ValueError) as error:
        raise VisionInputError("decode", "Image attachment could not be decoded safely.") from error
    return VisionImage(
        mime_type=signature_mime,
        width=width,
        height=height,
        frame_count=frame_count,
        data=data,
    )


def _path_identity(value: os.stat_result) -> tuple[int, int, int, int]:
    return (
        int(value.st_dev),
        int(value.st_ino),
        int(value.st_size),
        int(value.st_mtime_ns),
    )


def _is_reparse_point(value: os.stat_result) -> bool:
    reparse_flag = int(getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0) or 0)
    attributes = int(getattr(value, "st_file_attributes", 0) or 0)
    return bool(reparse_flag and attributes & reparse_flag)


def _is_within_root(candidate: Path, root: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def _resolve_image_path(path: str, managed_root: str | Path | None) -> Path:
    if not isinstance(path, str) or not path.strip() or not os.path.isabs(path):
        raise VisionInputError(
            "path", "chat.send image attachments require an absolute assetPath"
        )
    candidate = Path(path).expanduser()
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as error:
        raise VisionInputError(
            "path", "Image attachment must reference an existing file."
        ) from error
    if managed_root is not None:
        try:
            resolved_root = Path(managed_root).expanduser().resolve(strict=True)
        except OSError as error:
            raise VisionInputError(
                "managed_root",
                "Image attachments require a valid managed attachment root.",
            ) from error
        if not resolved_root.is_dir() or not _is_within_root(resolved, resolved_root):
            raise VisionInputError(
                "path_escape",
                "Image attachments must come from the app-managed image asset store.",
            )
    return resolved


def _read_image_path(path: Path) -> bytes:
    try:
        before = path.stat()
    except OSError as error:
        raise VisionInputError(
            "path", "Image attachment must reference an existing file."
        ) from error
    if not stat.S_ISREG(before.st_mode) or _is_reparse_point(before):
        raise VisionInputError(
            "path_type", "Image attachment must reference an existing file."
        )
    if before.st_size > MAX_VISION_IMAGE_BYTES:
        raise VisionInputError(
            "image_bytes",
            f"Image attachment exceeds the {MAX_VISION_IMAGE_BYTES}-byte limit.",
        )
    flags = os.O_RDONLY | int(getattr(os, "O_BINARY", 0))
    flags |= int(getattr(os, "O_NOFOLLOW", 0))
    try:
        fd = os.open(path, flags)
    except OSError as error:
        raise VisionInputError(
            "path_open", "Image attachment could not be opened safely."
        ) from error
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or _path_identity(opened) != _path_identity(before):
            raise VisionInputError("path_changed", "Image attachment changed before it was read.")
        chunks: list[bytes] = []
        remaining = MAX_VISION_IMAGE_BYTES + 1
        while remaining > 0:
            chunk = os.read(fd, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        after = os.fstat(fd)
    finally:
        os.close(fd)
    if len(data) > MAX_VISION_IMAGE_BYTES:
        raise VisionInputError(
            "image_bytes",
            f"Image attachment exceeds the {MAX_VISION_IMAGE_BYTES}-byte limit.",
        )
    try:
        current_path = path.resolve(strict=True)
        current = path.stat()
    except OSError as error:
        raise VisionInputError(
            "path_changed", "Image attachment changed while it was read."
        ) from error
    if current_path != path or _path_identity(after) != _path_identity(current):
        raise VisionInputError("path_changed", "Image attachment changed while it was read.")
    return data


def load_vision_image_path(
    path: str,
    *,
    declared_mime_type: str = "",
    managed_root: str | Path | None = None,
) -> tuple[Path, VisionImage]:
    """Resolve, identity-check, bounded-read, and validate one image path."""

    resolved = _resolve_image_path(path, managed_root)
    return resolved, vision_image_from_bytes(
        _read_image_path(resolved),
        declared_mime_type=declared_mime_type,
    )


def _vision_image_from_encoded(value: str) -> VisionImage:
    token = value.strip()
    declared_mime = ""
    encoded = token
    if token.startswith("data:"):
        header, separator, encoded = token.partition(",")
        if not separator or not header.endswith(";base64"):
            raise VisionInputError("data_uri", "Vision image data URI is malformed.")
        declared_mime = header[5:-7]
    max_encoded_chars = ((MAX_VISION_IMAGE_BYTES + 2) // 3) * 4 + 4
    if len(encoded) > max_encoded_chars:
        raise VisionInputError(
            "image_bytes",
            f"Image attachment exceeds the {MAX_VISION_IMAGE_BYTES}-byte limit.",
        )
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise VisionInputError("base64", "Vision image base64 is malformed.") from error
    return vision_image_from_bytes(data, declared_mime_type=declared_mime)


def normalize_vision_inputs(images: Sequence[VisionInput]) -> tuple[VisionImage, ...]:
    """Normalize legacy path/base64 inputs and enforce count/aggregate budgets."""

    if len(images) > MAX_VISION_ATTACHMENTS:
        raise VisionInputError(
            "attachment_count",
            f"Vision requests support at most {MAX_VISION_ATTACHMENTS} image attachments.",
        )
    normalized: list[VisionImage] = []
    aggregate_bytes = 0
    for value in images:
        if isinstance(value, VisionImage):
            image = value
        elif isinstance(value, str) and (value.startswith("data:") or not os.path.isabs(value)):
            image = _vision_image_from_encoded(value)
        elif isinstance(value, str):
            _resolved, image = load_vision_image_path(value)
        else:
            raise VisionInputError(
                "type", "Vision image inputs must be validated images or strings."
            )
        aggregate_bytes += image.decoded_bytes
        if aggregate_bytes > MAX_VISION_AGGREGATE_BYTES:
            raise VisionInputError(
                "aggregate_bytes",
                "Vision image attachments exceed the aggregate decoded-byte limit.",
            )
        normalized.append(image)
    return tuple(normalized)


__all__ = [
    "MAX_VISION_AGGREGATE_BYTES",
    "MAX_VISION_ATTACHMENTS",
    "MAX_VISION_FRAMES",
    "MAX_VISION_IMAGE_BYTES",
    "MAX_VISION_PIXELS",
    "VisionImage",
    "VisionInput",
    "VisionInputError",
    "load_vision_image_path",
    "normalize_vision_inputs",
    "vision_image_from_bytes",
]
