"""Bounded Ollama model acquisition with monotonic progress reporting."""

from __future__ import annotations

import json
import threading
import urllib.request
from collections.abc import Callable
from math import isfinite
from time import monotonic
from typing import Any

from sidecar.ai.engines.ollama_stream_transport import iter_bounded_response_lines

ProgressCallback = Callable[[dict[str, Any]], None]

_MAX_STATUS_CHARS = 160
_MAX_SAFE_BYTES = (2**53) - 1
# Verification gaps require a 300-second per-``recv`` ceiling. Chunked reads
# must not resume after an I/O exception; the absolute deadline closes stalled
# responses.
_MAX_PULL_SOCKET_TIMEOUT_SECONDS = 300.0


class _PullDeadline:
    """Own the total pull deadline and unblock one stalled HTTP response."""

    def __init__(self, timeout_seconds: float) -> None:
        try:
            parsed_timeout = float(timeout_seconds)
        except (TypeError, ValueError, OverflowError):
            parsed_timeout = 0.05
        self.timeout_seconds = (
            max(parsed_timeout, 0.05) if isfinite(parsed_timeout) else 0.05
        )
        self.socket_timeout_seconds = min(
            self.timeout_seconds,
            _MAX_PULL_SOCKET_TIMEOUT_SECONDS,
        )
        self._deadline = monotonic() + self.timeout_seconds
        self._expired = threading.Event()
        self._response: Any = None
        self._timer: threading.Timer | None = None

    def remaining_seconds(self) -> float:
        """Seconds left on the ABSOLUTE deadline fixed at construction.

        Clamped at zero. Exposed so callers can bound their own blocking waits
        against the same deadline instead of starting a fresh full budget --
        nothing outside this class should read ``_deadline``.
        """
        return max(0.0, self._deadline - monotonic())

    def start(self, response: Any) -> None:
        self._response = response
        # Schedule only the remaining absolute-deadline budget.
        self._timer = threading.Timer(self.remaining_seconds(), self._expire)
        self._timer.daemon = True
        self._timer.start()

    def _expire(self) -> None:
        self._expired.set()
        close = getattr(self._response, "close", None)
        if callable(close):
            try:
                close()
            except Exception:  # noqa: BLE001
                pass

    def expired(self) -> bool:
        return self._expired.is_set() or monotonic() >= self._deadline

    def raise_if_expired(self) -> None:
        if self.expired():
            self._expired.set()
            raise RuntimeError("Ollama model pull exceeded its total timeout")

    def close(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
        self._response = None


def _bounded_nonnegative_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed < 0:
        return None
    return min(parsed, _MAX_SAFE_BYTES)


def _bounded_status(value: Any) -> str:
    return str(value or "").strip()[:_MAX_STATUS_CHARS]


def _parse_progress_record(raw_line: bytes) -> tuple[str, int | None, int | None]:
    try:
        record = json.loads(raw_line)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Ollama pull returned malformed NDJSON") from exc
    if not isinstance(record, dict):
        raise RuntimeError("Ollama pull returned a non-object record")
    error_text = _bounded_status(record.get("error"))
    if error_text:
        raise RuntimeError(f"Ollama pull failed: {error_text}")

    status = _bounded_status(record.get("status"))
    completed = _bounded_nonnegative_int(record.get("completed"))
    total = _bounded_nonnegative_int(record.get("total"))
    if "completed" in record and completed is None:
        raise RuntimeError("Ollama pull returned invalid completed bytes")
    if "total" in record and total is None:
        raise RuntimeError("Ollama pull returned invalid total bytes")
    if not status and completed is None and total is None:
        raise RuntimeError("Ollama pull returned an empty progress record")
    return status, completed, total


def _merge_progress(
    completed_bytes: int,
    total_bytes: int,
    percent: float,
    raw_completed: int | None,
    raw_total: int | None,
) -> tuple[int, int, float]:
    if raw_completed is not None:
        completed_bytes = max(completed_bytes, raw_completed)
    if raw_total is not None:
        total_bytes = max(total_bytes, raw_total)
    if raw_completed is not None and raw_total:
        percent = max(percent, min(100.0, (raw_completed / raw_total) * 100.0))
    return completed_bytes, total_bytes, percent


def report_model_state(
    callback: ProgressCallback | None,
    *,
    state: str,
    model: str,
    status: str,
) -> None:
    if callback is not None:
        callback(
            {
                "state": state,
                "engine": "ollama",
                "model": model,
                "status": status,
                "percent": 100.0,
                "completed_bytes": 0,
                "total_bytes": 0,
            }
        )


def pull_ollama_model(
    *,
    host: str,
    model: str,
    timeout_seconds: float,
    progress_callback: ProgressCallback | None = None,
) -> None:
    """Pull ``model`` through Ollama's bounded streaming endpoint."""

    callback = progress_callback if callable(progress_callback) else None
    last_status = ""
    completed_bytes = 0
    total_bytes = 0
    percent = 0.0

    def emit(status: str, *, force: bool = False) -> None:
        nonlocal last_status
        normalized_status = _bounded_status(status) or "Acquiring model"
        if callback is None or (not force and normalized_status == last_status):
            last_status = normalized_status
            return
        callback(
            {
                "state": "model_acquiring",
                "engine": "ollama",
                "model": model,
                "status": normalized_status,
                "percent": round(percent, 2),
                "completed_bytes": completed_bytes,
                "total_bytes": total_bytes,
            }
        )
        last_status = normalized_status

    pull_deadline = _PullDeadline(timeout_seconds)
    emit("Starting model download", force=True)
    request = urllib.request.Request(
        f"{host}/api/pull",
        data=json.dumps({"name": model, "stream": True}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(
            request,
            # Bounded by the TOTAL deadline as well as the socket ceiling: a
            # stalled connect is the one window the per-line deadline checks
            # below cannot observe, because nothing has been read yet.
            timeout=min(
                pull_deadline.socket_timeout_seconds,
                max(pull_deadline.remaining_seconds(), 0.05),
            ),
        ) as response:
            pull_deadline.start(response)
            saw_success = False
            for raw_line in iter_bounded_response_lines(response):
                pull_deadline.raise_if_expired()
                if not raw_line.strip():
                    continue
                status, raw_completed, raw_total = _parse_progress_record(raw_line)
                previous_completed = completed_bytes
                previous_percent = percent
                completed_bytes, total_bytes, percent = _merge_progress(
                    completed_bytes,
                    total_bytes,
                    percent,
                    raw_completed,
                    raw_total,
                )

                if status == "success":
                    percent = 100.0
                    saw_success = True
                    emit("Model download complete", force=True)
                    break
                forward = completed_bytes > previous_completed or percent > previous_percent
                if status != last_status or forward:
                    emit(status or last_status or "Downloading model", force=True)

            if not saw_success:
                pull_deadline.raise_if_expired()
                raise RuntimeError("Ollama pull stream ended before success")
    except RuntimeError:
        raise
    except Exception as exc:
        if pull_deadline.expired():
            raise RuntimeError("Ollama model pull exceeded its total timeout") from exc
        raise RuntimeError(f"Failed to pull model '{model}': {exc}") from exc
    finally:
        pull_deadline.close()


__all__ = ["ProgressCallback", "pull_ollama_model", "report_model_state"]
