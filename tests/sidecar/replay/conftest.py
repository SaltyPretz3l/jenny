"""Test-scoped helpers for the replay-corpus harness.

The corpus runner imports :class:`RecordingLoopRuntime` directly. This module
exists as a conftest so pytest discovers it for the package, and to keep the
recording runtime co-located with any future replay-only fixtures.
"""

from __future__ import annotations

from sidecar.ai.routing.loop_events import LoopEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime


class RecordingLoopRuntime(LoopRuntime):
    """LoopRuntime variant that captures every emitted event in-memory."""

    def __init__(self, *, request_id: str = "req_replay", streaming: bool = True) -> None:
        emitted: list[LoopEvent] = []

        def _emit(event: LoopEvent) -> None:
            emitted.append(event)

        super().__init__(
            emit=_emit,
            request_id=request_id,
            streaming=streaming,
            chunk_inactivity_seconds=10.0,
        )
        self.emitted: list[LoopEvent] = emitted
