"""vision_input must not require Pillow at import time.

Pillow lives in the optional `media` extra and is absent from the locked
packaged-artifact profile (requirements-lock.txt). A module-level PIL import
here puts Pillow on the sidecar boot path (ollama_generation -> vision_input)
and crashes the packaged sidecar at startup - the exact failure the packaged
initialize probe caught on the first dist-clone release build (2026-07-22).

The no-Pillow legs run in a subprocess: blocking PIL in-process requires
reloading vision_input, and importlib.reload re-executes the module in place,
minting a new VisionInputError class that breaks exception identity for every
consumer that captured the original class (`from vision_input import
VisionInputError`).
"""

from __future__ import annotations

import base64
import io
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]

_NO_PIL_PROBE = r"""
import sys

class BlockPil:
    def find_spec(self, fullname, path=None, target=None):
        if fullname == "PIL" or fullname.startswith("PIL."):
            raise ImportError("PIL blocked for optional-dependency probe")
        return None

sys.meta_path.insert(0, BlockPil())

import sidecar.ai.engines.vision_input as vision_input
print("IMPORT_VISION_INPUT_OK")

import sidecar.ai.engines.ollama_generation  # noqa: F401  (boot-path consumer)
print("IMPORT_BOOT_CONSUMER_OK")

png_signature_only = bytes.fromhex("89504e470d0a1a0a") + b"x" * 32
try:
    vision_input.vision_image_from_bytes(png_signature_only, declared_mime_type="image/png")
except vision_input.VisionInputError as error:
    print(f"DECODE_REFUSAL_REASON={error.reason}")

try:
    vision_input.vision_image_from_bytes(b"", declared_mime_type="")
except vision_input.VisionInputError as error:
    print(f"EMPTY_REFUSAL_REASON={error.reason}")
"""


def test_boot_and_refusals_without_pil():
    result = subprocess.run(
        [sys.executable, "-c", _NO_PIL_PROBE],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, f"probe failed:\n{result.stdout}\n{result.stderr}"
    assert "IMPORT_VISION_INPUT_OK" in result.stdout
    assert "IMPORT_BOOT_CONSUMER_OK" in result.stdout
    assert "DECODE_REFUSAL_REASON=dependency_missing" in result.stdout
    assert "EMPTY_REFUSAL_REASON=empty" in result.stdout


def test_decode_still_works_with_pil():
    pil_image = pytest.importorskip("PIL.Image")
    from sidecar.ai.engines import vision_input

    buffer = io.BytesIO()
    pil_image.new("RGB", (1, 1)).save(buffer, format="PNG")
    image = vision_input.vision_image_from_bytes(
        buffer.getvalue(), declared_mime_type="image/png"
    )
    assert (image.mime_type, image.width, image.height) == ("image/png", 1, 1)


def test_base64_encoding_is_memoized():
    from sidecar.ai.engines.vision_input import VisionImage  # noqa: PLC0415

    image = VisionImage("image/png", 1, 1, 1, b"memoized image")
    first = image.as_base64()

    assert image.as_base64() is first
    assert first == base64.b64encode(image.data).decode("ascii")
