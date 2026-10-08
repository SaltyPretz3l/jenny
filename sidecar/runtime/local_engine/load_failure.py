"""Bounded model-load failure contract and background notification hooks."""

from __future__ import annotations

import logging
import re
import threading
import urllib.error
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from sidecar.ai.tools.error_paths import redact_error_paths
from sidecar.protocol import RUNTIME_LOAD_FAILURE_METHOD
from sidecar.runtime.diagnostics import sanitize_diagnostic_text
from sidecar.runtime.rpc import notification

logger = logging.getLogger(__name__)


def classify_load_failure(
    message: str, *, timed_out: bool = False, unreachable: bool = False,
) -> str:
    if timed_out or re.search(r"timed out", message, re.IGNORECASE):
        return "timeout"
    if unreachable or re.search(
        r"connection refused|could not connect|unreachable", message, re.IGNORECASE,
    ):
        return "engine_unreachable"
    if re.search(r"memory|VRAM|failed to allocate|cudaMalloc|CUDA error", message, re.IGNORECASE):
        return "out_of_memory"
    return "other"


def build_load_failure_payload(  # noqa: PLR0913 - shared wire payload fields
    *, cause: str, message: str, context: int | None, engine: str, model: str,
    at: str | None = None,
) -> dict[str, Any]:
    return {
        "cause": cause,
        "message": sanitize_diagnostic_text(redact_error_paths(message), limit=240),
        "context": context,
        "at": at or datetime.now(timezone.utc).isoformat(),
        "engine": engine,
        "model": model,
    }


def _notify(callback: Callable[[dict[str, Any]], None], payload: dict[str, Any]) -> None:
    try:
        callback(payload)
    except Exception:  # noqa: BLE001
        logger.exception("Model load failure notification failed")


def load_failure_listener(
    writer: Callable[[dict[str, Any]], None],
) -> Callable[[dict[str, Any]], None]:
    def emit(payload: dict[str, Any]) -> None:
        _notify(lambda value: writer(notification(RUNTIME_LOAD_FAILURE_METHOD, value)), payload)

    return emit


# The failure record has its own small lock. The warmup coordination lock is
# held across the whole /api/generate call, so taking it here would make
# `initialize` wait for the model to load. Listeners are called with no
# lock held: a stalled stdout pipe must not stall a warmup or a swap.
def _failure_lock(engine: Any) -> threading.Lock:
    return engine.__dict__.setdefault("_load_failure_lock", threading.Lock())


def set_ollama_load_failure_listener(
    engine: Any, callback: Callable[[dict[str, Any]], None] | None,
) -> None:
    with _failure_lock(engine):
        engine._load_failure_listener = callback
        failure = getattr(engine, "last_load_failure", None)
    if callback is not None and failure is not None:
        _notify(callback, failure)


def clear_ollama_load_failure(engine: Any) -> None:
    with _failure_lock(engine):
        engine.last_load_failure = None


def record_ollama_load_failure(engine: Any, error: Exception, name: str, stop: Any) -> None:
    # A warmup aborted by a model swap is routine, not a failure of the new model.
    if stop.is_set() or getattr(engine, "_warmup_model", None) != name:
        return
    payload = build_load_failure_payload(
        cause=classify_load_failure(
            str(error), timed_out=engine._is_timeout_error(error),
            unreachable=isinstance(error, urllib.error.URLError)
            and not isinstance(error, urllib.error.HTTPError),
        ),
        message=str(error), context=engine.get_configured_context_length(),
        engine="ollama", model=name,
    )
    with _failure_lock(engine):
        if getattr(engine, "_warmup_model", None) != name:
            return
        engine.last_load_failure = payload
        callback = getattr(engine, "_load_failure_listener", None)
    if callback is not None:
        _notify(callback, payload)
