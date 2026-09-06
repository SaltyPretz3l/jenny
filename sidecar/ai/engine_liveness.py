"""Process-wide engine-activity clock fed by the shell's managed-engine capture.

The stream-inactivity watchdog (``generation_runtime_stream``) cannot tell a
hung engine from one that is silently busy: Ollama buffers a tool call until it
is fully parsed, so a model composing a multi-thousand-token ``write_file``
streams NOTHING for minutes while decoding healthily (2026-07-11 RCA — a turn
was killed 3 seconds before its buffered tool call completed). The shell,
however, watches the managed engine's stderr and sees decode telemetry every
few seconds; it forwards that liveness as throttled ``engine.activity``
notifications, which the multiplexer stamps here.

The clock is process-wide, so it can only ATTRIBUTE activity when exactly one
generation is in flight: with concurrent generations (a foreground turn plus a
``background.run`` worker), a healthy sibling's telemetry would mask a wedged
request's stall for up to the silence ceiling. The active-generation counter
below records how many streamed generations are running; the watchdog defers a
stall verdict only when its own generation is the SOLE active one, and falls
back to the plain fixed-window behavior whenever attribution is ambiguous.

Unmanaged engines (external tray Ollama, remote endpoints) never stamp this
clock; ``seconds_since_engine_activity`` stays ``None`` and the watchdog
behaves exactly as before.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field


@dataclass
class _EngineActivityState:
    """Lock-protected process state without module-global rebinding."""

    lock: threading.Lock = field(default_factory=threading.Lock)
    last_activity_monotonic: float | None = None
    active_generations: int = 0


_state = _EngineActivityState()


def record_engine_activity() -> None:
    """Stamp "the engine produced observable work just now"."""
    with _state.lock:
        _state.last_activity_monotonic = time.monotonic()


def seconds_since_engine_activity() -> float | None:
    """Age of the newest stamp in seconds; ``None`` if never stamped."""
    with _state.lock:
        if _state.last_activity_monotonic is None:
            return None
        return max(0.0, time.monotonic() - _state.last_activity_monotonic)


def begin_generation() -> None:
    """Record that a streamed generation entered flight."""
    with _state.lock:
        _state.active_generations += 1


def end_generation() -> None:
    """Record that a streamed generation left flight (floored at zero)."""
    with _state.lock:
        _state.active_generations = max(0, _state.active_generations - 1)


def active_generation_count() -> int:
    """How many streamed generations are currently in flight."""
    with _state.lock:
        return _state.active_generations
