"""Audio and model-directory validation for dictation requests."""

from __future__ import annotations

import base64
import binascii
import os
from pathlib import Path
from typing import Any

from sidecar.ai.speech.errors import (
    invalid_audio,
    model_invalid,
    package_unavailable,
)

SAMPLE_RATE = 16_000
AUDIO_FORMAT = "pcm_s16le"
BYTES_PER_SAMPLE = 2
MIN_AUDIO_SECONDS = 0.2
MAX_AUDIO_SECONDS = 120.0
MAX_AUDIO_BYTES = int(MAX_AUDIO_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE)
# Base64 spends 4 characters per 3 bytes; checked before any decoding so an
# oversized string is rejected without allocating its decoded copy.
MAX_AUDIO_B64_CHARS = 4 * ((MAX_AUDIO_BYTES + 2) // 3)
_MIN_AUDIO_BYTES = int(MIN_AUDIO_SECONDS * SAMPLE_RATE) * BYTES_PER_SAMPLE

ASR_SUBDIR = "asr"
VAD_SUBDIR = "vad"
REQUIRED_MODEL_FILES: dict[str, tuple[str, ...]] = {
    ASR_SUBDIR: (
        "encoder-model.int8.onnx",
        "decoder_joint-model.int8.onnx",
        "nemo128.onnx",
        "vocab.txt",
        "config.json",
    ),
    VAD_SUBDIR: ("silero_vad.onnx", "config.json"),
}


def decode_pcm16(audio_b64: Any, sample_rate: Any, fmt: Any) -> Any:
    """Return mono float32 samples in [-1, 1] from base64 PCM16 little-endian."""
    rate_ok = type(sample_rate) is int and sample_rate == SAMPLE_RATE
    if not rate_ok:
        raise invalid_audio("sample_rate", "Audio must be 16 kHz.")
    if fmt != AUDIO_FORMAT:
        raise invalid_audio("format", "Audio must be mono PCM16 little-endian.")
    if not isinstance(audio_b64, str) or not audio_b64:
        raise invalid_audio("audio_type", "Audio payload must be a non-empty base64 string.")
    if len(audio_b64) > MAX_AUDIO_B64_CHARS:
        raise invalid_audio("too_long", "Audio is longer than 2 minutes.")
    try:
        raw = base64.b64decode(audio_b64, validate=True)
    except (binascii.Error, ValueError) as error:
        raise invalid_audio("base64", "Audio payload is not valid base64.") from error
    if len(raw) % BYTES_PER_SAMPLE:
        raise invalid_audio("odd_length", "Audio payload is not whole 16-bit samples.")
    if len(raw) > MAX_AUDIO_BYTES:
        raise invalid_audio("too_long", "Audio is longer than 2 minutes.")
    if len(raw) < _MIN_AUDIO_BYTES:
        raise invalid_audio("too_short", "Audio is shorter than 0.2 seconds.")
    try:
        import numpy as np  # media-site dependency, loaded on first use.
    except ImportError as error:
        raise package_unavailable() from error
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def _inside(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
    except ValueError:
        return False
    return True


def validate_model_dir(model_dir: Any) -> tuple[Path, Path]:
    """Return the resolved ``(asr_dir, vad_dir)`` of a complete model directory.

    The path must be absolute, name a real directory, and hold every required
    file as a regular file whose real path stays inside the resolved root, so a
    link cannot point the engine at files elsewhere.
    """
    if not isinstance(model_dir, str) or not model_dir or "\x00" in model_dir:
        raise model_invalid("model_dir_type", "The speech model location is invalid.")
    if not os.path.isabs(model_dir):
        raise model_invalid("model_dir_relative", "The speech model location must be absolute.")
    root = Path(os.path.realpath(model_dir))
    if not root.is_dir():
        raise model_invalid("model_dir_missing", "The speech model files are missing.")
    resolved: dict[str, Path] = {}
    for subdir, names in REQUIRED_MODEL_FILES.items():
        directory = Path(os.path.realpath(root / subdir))
        if not directory.is_dir() or not _inside(root, directory):
            raise model_invalid(
                "model_files_missing", f"The speech model is missing its {subdir} folder."
            )
        for name in names:
            target = Path(os.path.realpath(directory / name))
            if not target.is_file() or not _inside(root, target):
                raise model_invalid(
                    "model_files_missing", f"The speech model is missing {subdir}/{name}."
                )
        resolved[subdir] = directory
    return resolved[ASR_SUBDIR], resolved[VAD_SUBDIR]
