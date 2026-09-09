"""Bounded native-PNG wire validation, without optional imaging dependencies.

Only the live built-in Electron preview bridge may call this admission path.
It is not a general image reader. Native PNGs are non-interlaced; validate chunk
integrity and bounded scanline decompression before constructing a VisionImage.
"""

from __future__ import annotations

import base64
import binascii
import struct
import zlib
from typing import Any

from sidecar.ai.engines.vision_input import MAX_VISION_PIXELS, VisionImage
from sidecar.ai.tools.trusted_attachments import TRUSTED_ATTACHMENTS_MAX_TOTAL_BYTES

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MIN_PNG_BYTES = 45
NATIVE_BIT_DEPTH = 8


def _png_dimensions(data: bytes) -> tuple[int, int, int]:
    if (
        len(data) < MIN_PNG_BYTES
        or data[:8] != PNG_SIGNATURE
        or data[8:16] != b"\x00\x00\x00\rIHDR"
    ):
        raise ValueError("Invalid screenshot PNG header.")
    width, height, depth, color, compression, filtering, interlace = struct.unpack(
        ">IIBBBBB",
        data[16:29],
    )
    channels = {0: 1, 2: 3, 4: 2, 6: 4}.get(color)
    if (
        not width
        or not height
        or width * height > MAX_VISION_PIXELS
        or depth != NATIVE_BIT_DEPTH
        or channels is None
        or compression
        or filtering
        or interlace
    ):
        raise ValueError("Unsupported native screenshot dimensions or encoding.")
    return width, height, height * (1 + width * channels)


def _validate_png_chunks(data: bytes, decoded_limit: int) -> None:
    offset = 8
    decoder = zlib.decompressobj()
    decoded = 0
    ended = False
    while offset + 12 <= len(data):
        length = int.from_bytes(data[offset : offset + 4], "big")
        end = offset + 12 + length
        if end > len(data):
            raise ValueError("Truncated screenshot PNG.")
        kind = data[offset + 4 : offset + 8]
        payload = data[offset + 8 : end - 4]
        crc = int.from_bytes(data[end - 4 : end], "big")
        if zlib.crc32(kind + payload) != crc:
            raise ValueError("Screenshot PNG checksum failed.")
        if kind == b"IDAT":
            while payload:
                block = decoder.decompress(payload, min(65_536, decoded_limit - decoded + 1))
                decoded += len(block)
                if decoded > decoded_limit or decoder.unused_data:
                    raise ValueError("Screenshot PNG exceeds its pixel budget.")
                payload = decoder.unconsumed_tail
        if kind == b"IEND":
            ended = length == 0 and end == len(data)
            break
        offset = end
    if not ended or not decoder.eof or decoded != decoded_limit:
        raise ValueError("Incomplete screenshot PNG pixels.")


def native_preview_image(value: Any, *, call_id: str) -> VisionImage:
    if not isinstance(value, dict) or not call_id or value.get("call_id") != call_id:
        raise ValueError("Screenshot does not belong to this tool call.")
    length = value.get("byte_length")
    encoded = value.get("data_base64")
    if (
        type(length) is not int
        or not 0 < length <= TRUSTED_ATTACHMENTS_MAX_TOTAL_BYTES
        or not isinstance(encoded, str)
        or len(encoded) != 4 * ((length + 2) // 3)
        or value.get("mime_type") != "image/png"
    ):
        raise ValueError("Screenshot exceeds its transport budget.")
    try:
        data = base64.b64decode(encoded, validate=True)
        width, height, decoded_limit = _png_dimensions(data)
        if (
            len(data) != length
            or type(value.get("width")) is not int
            or type(value.get("height")) is not int
            or value.get("width") != width
            or value.get("height") != height
        ):
            raise ValueError("Screenshot size does not match its pixels.")
        _validate_png_chunks(data, decoded_limit)
    except (binascii.Error, zlib.error, struct.error) as error:
        raise ValueError("Invalid screenshot encoding.") from error
    return VisionImage(mime_type="image/png", width=width, height=height, frame_count=1, data=data)
