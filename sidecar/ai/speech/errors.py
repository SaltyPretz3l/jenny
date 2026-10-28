"""Typed failure for the dictation speech package."""

from __future__ import annotations

from sidecar.ai.error_codes import (
    CMP_SPEECH_ENGINE_FAILED,
    CMP_SPEECH_INVALID_AUDIO,
    CMP_SPEECH_MODEL_INVALID,
    CMP_SPEECH_PACKAGE_UNAVAILABLE,
)


class SpeechError(Exception):
    """A dictation failure carrying its ``CMP-SPEECH-NNNN`` code.

    ``reason`` is a short machine token and ``message`` a fixed, path-free
    sentence; neither ever quotes audio or a user directory.
    """

    def __init__(self, code: str, reason: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.reason = reason
        self.message = message


def model_invalid(reason: str, message: str) -> SpeechError:
    return SpeechError(CMP_SPEECH_MODEL_INVALID, reason, message)


def invalid_audio(reason: str, message: str) -> SpeechError:
    return SpeechError(CMP_SPEECH_INVALID_AUDIO, reason, message)


def engine_failed(reason: str, message: str) -> SpeechError:
    return SpeechError(CMP_SPEECH_ENGINE_FAILED, reason, message)


def package_unavailable() -> SpeechError:
    return SpeechError(
        CMP_SPEECH_PACKAGE_UNAVAILABLE,
        "package_unavailable",
        "The speech engine package is not available in this build.",
    )
