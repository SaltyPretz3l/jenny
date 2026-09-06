"""Small per-call phase timing recorder."""

from __future__ import annotations

import json
import time
from contextlib import contextmanager
from typing import Iterator, Literal

PHASE_NAMES: tuple[str, ...] = (
    "queue",
    "validate",
    "precondition",
    "acquire_lock",
    "bootstrap",
    "execute",
    "collect",
    "serialize",
)


class PhaseTrace:
    def __init__(self, *, tool: str, call_id: str, trace_id: str) -> None:
        self.tool = tool
        self.call_id = call_id
        self.trace_id = trace_id
        self.current_phase: str | None = None
        self._timings: dict[str, dict[str, object]] = {}

    def __enter__(self) -> PhaseTrace:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: object | None,
    ) -> Literal[False]:
        return False

    @contextmanager
    def phase(
        self,
        name: str,
        *,
        budget_seconds: float | None = None,
    ) -> Iterator[None]:
        if name not in PHASE_NAMES:
            raise ValueError(f"unknown tool phase: {name}")
        self.current_phase = name
        started_at = time.perf_counter()
        try:
            yield
        finally:
            elapsed_seconds = max(0.0, time.perf_counter() - started_at)
            timing: dict[str, object] = {"elapsed_ms": elapsed_seconds * 1000.0}
            if budget_seconds is not None:
                timing["budget_seconds"] = budget_seconds
                if elapsed_seconds > budget_seconds:
                    timing["over_budget"] = True
            self._timings[name] = timing

    def summary(self) -> dict[str, dict[str, object]]:
        return {name: dict(timing) for name, timing in self._timings.items()}

    def phase_timings_json(self) -> str:
        return json.dumps(self.summary(), separators=(",", ":"))
