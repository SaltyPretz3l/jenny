"""``speech.prepare`` / ``speech.transcribe`` dispatch for local dictation.

Both methods run on the auxiliary ``speech`` workers (the engine lock runs one
at a time). Request params carry the recorded audio as base64, so this module never logs or echoes
params: events carry sizes and timings only, and failures carry a fixed
sentence plus the ``CMP-SPEECH-NNNN`` code on ``error.data.error_code``.
"""

from __future__ import annotations

import logging
from typing import Any

from sidecar.ai.error_codes import (
    CMP_PROTO_VERSION_MISMATCH,
    CMP_SPEECH_ENGINE_FAILED,
    CMP_SPEECH_INVALID_AUDIO,
    CMP_SPEECH_MODEL_INVALID,
)
from sidecar.ai.speech.audio import SAMPLE_RATE, decode_pcm16
from sidecar.ai.speech.engine import get_speech_engine
from sidecar.ai.speech.errors import SpeechError
from sidecar.protocol import SPEECH_PREPARE_METHOD, SPEECH_TRANSCRIBE_METHOD
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.rpc import error_response, result_response, validate_accept_version

INVALID_PARAMS_CODE = -32602
INTERNAL_ERROR_CODE = -32000
PROTOCOL_VERSION_MISMATCH = CMP_PROTO_VERSION_MISMATCH
_INVALID_PARAMS_SPEECH_CODES = frozenset({CMP_SPEECH_MODEL_INVALID, CMP_SPEECH_INVALID_AUDIO})
_COMPONENT = "runtime.request_dispatch_speech"


def _outcome(initialized: bool, response: dict[str, Any] | None) -> ProcessOutcome:
    return ProcessOutcome(
        initialized=initialized, shutdown_requested=False, response=response, notifications=[]
    )


def _speech_error_outcome(
    *, message_id: Any, initialized: bool, error: SpeechError, method: str, logger: logging.Logger
) -> ProcessOutcome:
    log_event(
        logger,
        logging.INFO,
        component=_COMPONENT,
        event="sidecar.runtime.speech_failed",
        message=f"{method} failed",
        status="failure",
        data={"error_code": error.code, "reason": error.reason},
    )
    invalid = error.code in _INVALID_PARAMS_SPEECH_CODES
    code = INVALID_PARAMS_CODE if invalid else INTERNAL_ERROR_CODE
    return _outcome(
        initialized,
        error_response(
            message_id,
            code=code,
            message=error.message,
            data={"error_code": error.code, "reason": error.reason},
        ),
    )


def _run(method: str, params: dict[str, Any], logger: logging.Logger) -> dict[str, Any]:
    model_dir = params.get("model_dir")
    engine = get_speech_engine()
    if method == SPEECH_PREPARE_METHOD:
        return {"ready": True, "load_ms": engine.prepare(model_dir)}
    samples = decode_pcm16(params.get("audio_b64"), params.get("sample_rate"), params.get("format"))
    text, engine_ms = engine.transcribe(model_dir, samples)
    duration_ms = len(samples) * 1000 // SAMPLE_RATE
    log_event(
        logger,
        logging.DEBUG,
        component=_COMPONENT,
        event="sidecar.runtime.speech_transcribed",
        message="Transcribed dictation audio",
        status="ok",
        duration_ms=engine_ms,
        data={"audio_ms": duration_ms, "text_chars": len(text)},
    )
    return {"text": text, "duration_ms": duration_ms, "engine_ms": engine_ms}


def process_speech_method(
    method: str,
    message_id: Any,
    params: Any,
    initialized: bool,
    logger: logging.Logger,
) -> ProcessOutcome | None:
    if method not in (SPEECH_PREPARE_METHOD, SPEECH_TRANSCRIBE_METHOD):
        return None
    version_error = validate_accept_version(
        method=method,
        message_id=message_id,
        params=params,
        invalid_params_code=INVALID_PARAMS_CODE,
        version_mismatch_code=PROTOCOL_VERSION_MISMATCH,
    )
    if version_error is not None:
        return _outcome(initialized, version_error)
    if message_id is None:
        return _outcome(initialized, None)
    try:
        return _outcome(initialized, result_response(message_id, _run(method, params, logger)))
    except SpeechError as error:
        return _speech_error_outcome(
            message_id=message_id,
            initialized=initialized,
            error=error,
            method=method,
            logger=logger,
        )
    except Exception:  # noqa: BLE001 - never let a dictation bug escape the dispatcher.
        # No exception text or traceback: it could quote request content.
        return _speech_error_outcome(
            message_id=message_id,
            initialized=initialized,
            error=SpeechError(
                CMP_SPEECH_ENGINE_FAILED,
                "internal_error",
                "The speech engine could not process the request.",
            ),
            method=method,
            logger=logger,
        )
