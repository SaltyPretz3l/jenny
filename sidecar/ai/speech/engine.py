"""Process-wide CPU speech engine: Parakeet TDT through ``onnx-asr``.

One engine per sidecar process, created lazily. The model loads on the first
``prepare``/``transcribe``, is reused for the same model directory, and is
dropped after ``IDLE_UNLOAD_SECONDS`` without use. Loading is offline only:
``onnx_asr`` is pointed at the local ``asr/`` and ``vad/`` directories that
Electron installed and never reaches for the network.
"""

from __future__ import annotations

import logging
import os
import re
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from time import monotonic
from typing import Any

from sidecar.ai.speech.audio import SAMPLE_RATE, validate_model_dir
from sidecar.ai.speech.errors import engine_failed, package_unavailable

MODEL_NAME = "nemo-parakeet-tdt-0.6b-v3"
IDLE_UNLOAD_SECONDS = 600.0
# Parakeet takes roughly 20-30 s per call; longer clips are cut at pauses by VAD.
MAX_PLAIN_SECONDS = 20.0
# Silero splits at every pause by default (100 ms), and Parakeet punctuates each
# segment as a sentence; merge pauses under 1.5 s so long clips read as prose.
VAD_OPTIONS: dict[str, float] = {"min_silence_duration_ms": 1500, "speech_pad_ms": 100}
CPU_PROVIDERS: tuple[str, ...] = ("CPUExecutionProvider",)
_WHITESPACE_RE = re.compile(r"\s+")

_LOGGER = logging.getLogger(__name__)

# ``loader(asr_dir, vad_dir, intra_op_threads=..., providers=...)`` -> ``(asr, vad)``.
Loader = Callable[..., tuple[Any, Any]]


def intra_op_threads() -> int:
    return max(1, min(4, os.cpu_count() or 1))


def load_onnx_asr(
    asr_dir: Path,
    vad_dir: Path,
    *,
    intra_op_threads: int,
    providers: Sequence[str],
) -> tuple[Any, Any]:
    """Load the local Parakeet model and Silero VAD (raises ``ImportError`` if absent)."""
    import onnx_asr  # optional media-site dependency.
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.intra_op_num_threads = intra_op_threads
    asr = onnx_asr.load_model(
        MODEL_NAME,
        path=asr_dir,
        quantization="int8",
        sess_options=options,
        providers=list(providers),
    )
    vad = onnx_asr.load_vad(
        "silero",
        path=vad_dir,
        sess_options=options,
        providers=list(providers),
    )
    return asr, vad


@dataclass
class _Loaded:
    key: tuple[Path, Path]
    asr: Any
    vad: Any


class SpeechEngine:
    """Lock-protected, lazily loaded speech recogniser with idle unload."""

    def __init__(
        self,
        *,
        loader: Loader = load_onnx_asr,
        clock: Callable[[], float] = monotonic,
        idle_seconds: float = IDLE_UNLOAD_SECONDS,
        timer_factory: Callable[..., Any] = threading.Timer,
    ) -> None:
        self._loader = loader
        self._clock = clock
        self._idle_seconds = idle_seconds
        self._timer_factory = timer_factory
        self._lock = threading.RLock()
        self._loaded: _Loaded | None = None
        self._package_missing = False
        self._last_used = 0.0
        self._timer: Any | None = None

    @property
    def loaded(self) -> bool:
        with self._lock:
            return self._loaded is not None

    def prepare(self, model_dir: Any) -> int:
        """Load (or reuse) the model for ``model_dir``; return the load time in ms."""
        with self._lock:
            try:
                started = self._clock()
                self._ensure_loaded(model_dir)
                return int(max(0.0, self._clock() - started) * 1000)
            finally:
                self._touch()

    def transcribe(self, model_dir: Any, samples: Any) -> tuple[str, int]:
        """Return ``(text, engine_ms)`` for mono 16 kHz float32 ``samples``."""
        with self._lock:
            try:
                loaded = self._ensure_loaded(model_dir)
                started = self._clock()
                raw = self._recognize(loaded, samples)
                engine_ms = int(max(0.0, self._clock() - started) * 1000)
                return _WHITESPACE_RE.sub(" ", raw).strip(), engine_ms
            finally:
                self._touch()

    def unload(self) -> None:
        with self._lock:
            self._loaded = None
            self._cancel_timer()

    def unload_if_idle(self) -> bool:
        """Drop the model when it has been idle for the full window."""
        with self._lock:
            if self._loaded is None:
                return False
            if self._clock() - self._last_used < self._idle_seconds:
                return False
            self.unload()
            return True

    def _recognize(self, loaded: _Loaded, samples: Any) -> str:
        try:
            if len(samples) <= int(MAX_PLAIN_SECONDS * SAMPLE_RATE):
                return str(loaded.asr.recognize(samples, sample_rate=SAMPLE_RATE) or "")
            adapter = loaded.asr.with_vad(loaded.vad, **VAD_OPTIONS)
            # The VAD adapter yields segments lazily; consume them inside this guard.
            segments = adapter.recognize(samples, sample_rate=SAMPLE_RATE)
            return " ".join(str(getattr(segment, "text", "") or "") for segment in segments)
        except Exception as error:  # noqa: BLE001 - reported as one typed failure.
            _log_failure("sidecar.speech.recognize_failed", "Speech recognition failed", error)
            raise engine_failed(
                "recognize_failed", "The speech engine could not transcribe the audio."
            ) from error

    def _ensure_loaded(self, model_dir: Any) -> _Loaded:
        key = validate_model_dir(model_dir)
        if self._loaded is not None and self._loaded.key == key:
            return self._loaded
        if self._package_missing:
            raise package_unavailable()
        # A different directory replaces the model; free the old one before loading.
        self._loaded = None
        try:
            asr, vad = self._loader(
                key[0], key[1], intra_op_threads=intra_op_threads(), providers=CPU_PROVIDERS
            )
        except ImportError as error:
            # Kept for the process: a missing package does not come back until a restart.
            self._package_missing = True
            raise package_unavailable() from error
        except Exception as error:  # noqa: BLE001 - reported as one typed failure.
            _log_failure("sidecar.speech.load_failed", "Speech model load failed", error)
            raise engine_failed(
                "load_failed", "The speech engine could not load its model."
            ) from error
        self._loaded = _Loaded(key, asr, vad)
        return self._loaded

    def _touch(self) -> None:
        self._last_used = self._clock()
        self._arm_timer(self._idle_seconds)

    def _arm_timer(self, delay: float) -> None:
        self._cancel_timer()
        if self._loaded is None:
            return
        timer = self._timer_factory(delay, self._on_idle_timer)
        timer.daemon = True
        self._timer = timer
        timer.start()

    def _on_idle_timer(self) -> None:
        with self._lock:
            if self.unload_if_idle() or self._loaded is None:
                return
            # A timer can wake marginally early; wait out the rest of the window.
            self._arm_timer(max(0.01, self._idle_seconds - (self._clock() - self._last_used)))

    def _cancel_timer(self) -> None:
        timer, self._timer = self._timer, None
        if timer is not None:
            timer.cancel()


def _log_failure(event: str, message: str, error: Exception) -> None:
    # Type name only: an engine exception can quote paths or audio-derived values.
    _LOGGER.warning(
        message,
        extra={
            "layer": "sidecar",
            "component": "ai.speech.engine",
            "event": event,
            "status": "failure",
            "data": {"error_type": type(error).__name__},
        },
    )


_ENGINE: SpeechEngine | None = None
_ENGINE_LOCK = threading.Lock()


def get_speech_engine() -> SpeechEngine:
    """The process-wide engine (created on first use)."""
    global _ENGINE  # noqa: PLW0603 - module-level singleton.
    with _ENGINE_LOCK:
        if _ENGINE is None:
            _ENGINE = SpeechEngine()
        return _ENGINE


def reset_speech_engine(engine: SpeechEngine | None = None) -> None:
    """Replace (or clear) the process-wide engine; used by tests."""
    global _ENGINE
    with _ENGINE_LOCK:
        previous, _ENGINE = _ENGINE, engine
    if previous is not None:
        previous.unload()
