"""Exactly-once, best-effort provider-call finalization at the transport edge."""

from __future__ import annotations

import logging
import sys
from collections.abc import Callable
from typing import Any

from sidecar.ai.routing.provider_stream_normalizer import (
    ProviderStreamNormalizer,
    record_counters_to_diagnostics,
)
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)


def provider_call_outcome(finish_reason: str | None) -> str:
    if finish_reason == "incomplete":
        return "incomplete"
    if finish_reason == "thinking_budget":
        return "cancelled"
    # reasoning_only is a clean provider stop; finish_reason keeps the verdict.
    if finish_reason in {"stop", "length", "tool_calls", "reasoning_only"}:
        return "completed"
    return "failed"


class ProviderCallFinalizer:
    """Keep terminal evidence local to one call; never mask a transport exception."""

    def __init__(self, engine: Any) -> None:
        self.engine = engine
        self.finish_reason: str | None = None
        self.normalizer: ProviderStreamNormalizer | None = None
        self.recording_error_count = 0
        self._finalized = False

    def _record(self, operation: Callable[[], None]) -> None:
        try:
            operation()
        except Exception:  # noqa: BLE001 - only diagnostic operations run here.
            self.recording_error_count += 1

    def finalize(self, *, cancel_handle: Any = None) -> None:
        if self._finalized:
            return
        self._finalized = True
        error = sys.exception()
        cancelled = isinstance(error, (GeneratorExit, KeyboardInterrupt)) or (
            getattr(error, "status", None) == "cancelled"
            or getattr(cancel_handle, "cancelled", False) is True
        )
        # A cancel can end the transport as a clean EOF; that is not "incomplete".
        cancelled_eof = cancelled and self.finish_reason == "incomplete"
        if self.finish_reason is not None and not cancelled_eof:
            outcome = provider_call_outcome(self.finish_reason)
        elif cancelled:
            outcome = "cancelled"
        else:
            outcome = "failed"
        if self.normalizer is not None:
            self._record(self.normalizer.finalize_for_counters)
            normalizer = self.normalizer
            self._record(lambda: record_counters_to_diagnostics(self.engine, normalizer))
        kwargs: dict[str, Any] = {"outcome": outcome}
        if self.finish_reason is not None:
            kwargs["finish_reason"] = self.finish_reason
        self._record(lambda: self.engine._complete_provider_request(**kwargs))
        if self.recording_error_count:
            self._record(lambda: log_event(
                logger, logging.WARNING,
                component="ai.engines.provider_call",
                event="ai.engines.provider_call.finalization_recording_failed",
                message="Provider-call diagnostic recording failed.",
                data={"diagnostic_recording_error_count": self.recording_error_count},
            ))
