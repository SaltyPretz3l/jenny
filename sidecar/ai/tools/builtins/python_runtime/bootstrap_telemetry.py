"""Structured phase telemetry for managed Python runtime bootstrap."""

from __future__ import annotations

import json
import logging
import re
import subprocess
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator

from sidecar.runtime.diagnostics import log_event

_COMPONENT = "ai.tools.python_runtime"
_PHASE_LABELS = {
    "interpreter_selected": "interpreter selection",
    "wheelhouse_resolved": "wheelhouse resolution",
    "venv_created": "virtual environment creation",
    "install_finished": "package installation",
    "imports_validated": "import validation",
    "published": "publication",
}
_WINDOWS_PATH_RE = re.compile(r"(?i)(?:[a-z]:[\\/]|\\\\)[^\r\n\"']+")
_UNIX_PATH_RE = re.compile(r"(?<![\w.])/(?:[^\s/]+/)+[^\s\"']+")


def _redact_paths(value: str) -> str:
    redacted = _WINDOWS_PATH_RE.sub("[redacted:path]", value)
    return _UNIX_PATH_RE.sub("[redacted:path]", redacted)


def redact_paths(value: str) -> str:
    """Public sink-side redaction for any text that leaves the runtime."""
    return _redact_paths(value)


def _safe_data(data: dict[str, object]) -> dict[str, object]:
    return {
        key: _redact_paths(value) if isinstance(value, str) else value
        for key, value in data.items()
    }


def bootstrap_phase_label(phase: str) -> str:
    return _PHASE_LABELS.get(phase, phase.replace("_", " "))


@dataclass
class BootstrapTelemetry:
    """Per-call phase timing accumulator and structured event emitter."""

    logger: logging.Logger
    phase_timings: dict[str, float] = field(default_factory=dict)

    @contextmanager
    def phase(self, name: str, *, data: dict[str, Any]) -> Iterator[dict[str, Any]]:
        started_at = time.perf_counter()
        try:
            yield data
        except Exception as error:
            self._finish(name, started_at, data, error=error)
            if not getattr(error, "failed_phase", None):
                error.failed_phase = name  # type: ignore[attr-defined]
            error.phase_timings_json = self.to_json()  # type: ignore[attr-defined]
            raise
        self._finish(name, started_at, data)

    def to_json(self) -> str:
        return json.dumps(self.phase_timings, sort_keys=True)

    @staticmethod
    def error_detail(error: BaseException) -> str:
        detail = f"{type(error).__name__}: {error}"
        current: BaseException | None = error
        while current is not None:
            if isinstance(current, subprocess.CalledProcessError):
                detail = f"{detail}; exit code {current.returncode}"
            stderr = getattr(current, "stderr", None)
            if isinstance(stderr, bytes):
                stderr = stderr.decode("utf-8", errors="replace")
            if isinstance(stderr, str) and stderr.strip():
                normalized = " ".join(stderr.split())
                # Redact before slicing: a cut that lands inside a path would
                # strip the drive anchor the redaction regex keys on and leave
                # the remainder (username included) verbatim.
                tail = _redact_paths(normalized)[-400:]
                detail = f"{detail}; stderr tail: {tail}"
                break
            current = current.__cause__
        return detail

    def _finish(
        self,
        name: str,
        started_at: float,
        data: dict[str, Any],
        *,
        error: Exception | None = None,
    ) -> None:
        duration_ms = round(max((time.perf_counter() - started_at) * 1000.0, 0.0), 3)
        self.phase_timings[name] = duration_ms
        event_data = _safe_data(data)
        if error is not None:
            event_data.setdefault("error_type", type(error).__name__)
            error.bootstrap_error_message = _redact_paths(  # type: ignore[attr-defined]
                self.error_detail(error)
            )
        log_event(
            self.logger,
            logging.WARNING if error is not None else logging.INFO,
            component=_COMPONENT,
            event=f"{_COMPONENT}.bootstrap.{name}",
            message=(
                "Python runtime bootstrap phase failed."
                if error is not None
                else "Python runtime bootstrap phase completed."
            ),
            status="failed" if error is not None else "ok",
            duration_ms=duration_ms,
            data=event_data,
        )
