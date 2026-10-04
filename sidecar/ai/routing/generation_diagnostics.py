"""Diagnostic helpers for generation runtime bookkeeping."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Mapping, Sequence

from sidecar.ai.context.request_fingerprint import compute_request_fingerprint
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.local_engine.request_context import current_diagnostics_store

if TYPE_CHECKING:
    from sidecar.ai.context.prefix_stability import PrefixObservation

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


def observe_prefix(
    *,
    source_key: str,
    system_prompt: Any,
    tool_schemas: Sequence[Mapping[str, Any]] | None,
    prompt_messages: Sequence[Mapping[str, Any]],
) -> PrefixObservation | None:
    """Compare this request's layout with the source's previous one (diagnostic only)."""

    # Imported per request so the meter stays out of the sidecar startup import graph.
    from sidecar.ai.context.prefix_stability import prefix_meter_enabled, shared_prefix_meter

    if not prefix_meter_enabled():
        return None
    try:
        return shared_prefix_meter().observe(
            source_key,
            system_prompt=system_prompt,
            tool_schemas=tool_schemas,
            messages=prompt_messages,
        )
    except Exception as error:  # noqa: BLE001
        log_event(
            logger,
            logging.WARNING,
            component="ai.routing.generation_diagnostics",
            event="ai.routing.generation_diagnostics.prefix_meter_failed",
            message="Prefix meter failed closed.",
            status="error",
            data={"error": str(error)},
        )
        return None


def _count(value: Any) -> int | None:
    return value if type(value) is int and value >= 0 else None


def server_prefix_reading(
    snapshot: Mapping[str, Any] | None,
    *,
    client_total_chars: int = 0,
) -> dict[str, Any]:
    """Read the latest provider call's prefix-cache split from a turn snapshot.

    ``reused`` and ``prompt_tokens`` are provider truth when the server reports
    a cached count (llama-server ``timings.cache_n``, OpenAI-style
    ``cached_tokens``). Ollama reports only the evaluated (missed) tokens, so
    its ratio is an estimate against the client's chars/4 prompt size.
    """

    turn = snapshot if isinstance(snapshot, Mapping) else {}
    calls = turn.get("provider_calls")
    call: Mapping[str, Any] = {}
    if isinstance(calls, list) and calls and isinstance(calls[-1], Mapping):
        call = calls[-1]
    raw_usage = call.get("usage")
    usage: Mapping[str, Any] = raw_usage if isinstance(raw_usage, Mapping) else {}
    source = str(turn.get("provider_usage_source") or "").strip() or "none"
    prompt_tokens = _count(usage.get("prompt_eval_count"))
    reused = _count(usage.get("cached_tokens"))
    evaluated = _count(usage.get("prompt_tokens_evaluated"))
    reading: dict[str, Any] = {
        "source": source,
        "purpose": call.get("purpose"),
        "prefill_ms": _count(turn.get("provider_prompt_eval_duration_ms")),
        "prompt_tokens": None,
        "reused_tokens": None,
        "evaluated_tokens": evaluated,
        "reuse_ratio": None,
        "ratio_basis": "unreported",
    }
    reading["usage_prompt_tokens"] = prompt_tokens
    if reused is not None:
        # The evaluated/reused split is self-consistent; ``usage.prompt_tokens``
        # stays a cross-check because its meaning varies across server builds.
        if evaluated is not None:
            prompt_tokens = evaluated + reused
        elif prompt_tokens is not None:
            evaluated = max(prompt_tokens - reused, 0)
        reading.update(
            reused_tokens=reused, evaluated_tokens=evaluated, prompt_tokens=prompt_tokens
        )
        if prompt_tokens:
            reading["reuse_ratio"] = round(min(reused / prompt_tokens, 1.0), 4)
            reading["ratio_basis"] = "provider"
    elif evaluated is not None and client_total_chars > 0:
        estimated_total = max((client_total_chars + 3) // 4, evaluated, 1)
        reading["prompt_tokens"] = estimated_total
        reading["reuse_ratio"] = round(max(1.0 - evaluated / estimated_total, 0.0), 4)
        reading["ratio_basis"] = "client_estimate"
    return reading


@dataclass(frozen=True)
class PrefixReuseRecord:
    request_id: str
    observation: PrefixObservation | None
    engine_type: str = ""
    model: str = ""
    iteration: int | None = None


def record_prefix_reuse(store: Any, record: PrefixReuseRecord) -> None:
    """Pair the client divergence verdict with the server's reuse and log it once per call."""

    normalized_request_id = str(record.request_id or "").strip()
    observation = record.observation
    if observation is None or not normalized_request_id:
        return
    try:
        snapshot = (
            store.get_snapshot_for_request(normalized_request_id)
            if store is not None and hasattr(store, "get_snapshot_for_request")
            else None
        )
        client = observation.to_dict()
        server = server_prefix_reading(snapshot, client_total_chars=observation.total_chars)
        payload = {
            "engine": str(record.engine_type or ""),
            "model": str(record.model or ""),
            "iteration": _count(record.iteration),
            "client": client,
            "server": server,
        }
        if store is not None and hasattr(store, "record_prefix_reuse"):
            store.record_prefix_reuse(request_id=normalized_request_id, prefix_reuse=payload)
        reused, total = server["reused_tokens"], server["prompt_tokens"]
        if reused is not None and total is not None:
            summary = f"prefix reused {reused} of {total} tokens"
        elif server["evaluated_tokens"] is not None:
            summary = f"prefix evaluated {server['evaluated_tokens']} tokens (reuse not reported)"
        else:
            summary = "prefix reuse not reported"
        log_event(
            logger,
            logging.INFO,
            component="ai.router",
            event="ai.router.prefix_reuse",
            message=f"{summary}; client {client['divergence']}"
            + (f" at {client['first_changed']}" if client["first_changed"] else ""),
            status="ok",
            request_id=normalized_request_id,
            data=payload,
        )
    except Exception as error:  # noqa: BLE001
        # Diagnostic-only path: generation must not fail when the meter does.
        log_event(
            logger,
            logging.WARNING,
            component="ai.routing.generation_diagnostics",
            event="ai.routing.generation_diagnostics.prefix_meter_failed",
            message="Prefix meter failed closed.",
            status="error",
            request_id=normalized_request_id,
            data={"error": str(error)},
        )
