"""Diagnostic helpers for generation runtime bookkeeping."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from sidecar.ai.context.request_fingerprint import compute_request_fingerprint
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.local_engine.request_context import current_diagnostics_store

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RequestFingerprintRecord:
    request_id: str
    system_prompt: Any
    tool_schemas: list[dict[str, Any]]
    component: str = "ai.routing.generation_diagnostics"
    event: str = "ai.routing.generation_diagnostics.request_fingerprint_failed"
    message: str = "Request fingerprinting failed closed."
    session_id: str | None = None


def record_request_fingerprint_if_available(
    kernel: Any,
    *,
    request_id: str,
    system_prompt: Any,
    tool_schemas: list[dict[str, Any]],
) -> None:
    """Record request shape diagnostics without affecting generation."""

    normalized_request_id = str(request_id or "").strip()
    if not normalized_request_id:
        return
    store = current_diagnostics_store(getattr(kernel, "_engine", None))
    record_request_fingerprint_for_store(
        store,
        RequestFingerprintRecord(
            request_id=normalized_request_id,
            system_prompt=system_prompt,
            tool_schemas=tool_schemas,
        ),
    )


def record_request_fingerprint_for_store(
    store: Any,
    record: RequestFingerprintRecord,
) -> None:
    """Record request fingerprint diagnostics against a diagnostics store."""

    if store is None or not hasattr(store, "record_request_fingerprint"):
        return
    normalized_request_id = str(record.request_id or "").strip()
    if not normalized_request_id:
        return
    try:
        fingerprint = compute_request_fingerprint(
            system_prompt=record.system_prompt,
            tool_schemas=record.tool_schemas,
        )
        store.record_request_fingerprint(
            request_id=normalized_request_id,
            fingerprint=fingerprint.to_dict(),
        )
    except Exception as error:  # noqa: BLE001
        # Diagnostic-only path: generation must not fail when fingerprinting does.
        log_event(
            logger,
            logging.WARNING,
            component=record.component,
            event=record.event,
            message=record.message,
            status="error",
            request_id=normalized_request_id,
            session_id=record.session_id,
            data={"error": str(error)},
        )
        return
