"""Notification construction and lightweight helpers for chat runtime."""

from __future__ import annotations

import math
import time
from typing import Any, Callable

from sidecar.ai.error_codes import CMP_APPROVAL_REJECTED, CMP_CHAT_INVALID_PARAMS
from sidecar.ai.mode_policy import normalize_mode
from sidecar.ai.routing.loop_events import StopEvent
from sidecar.ai.routing.tool_observation import (
    KIND_USER_APPROVAL_REJECTED,
    ToolObservationEvent,
    ToolObservationStore,
)
from sidecar.ai.routing.vision_turn import engine_supports_vision  # noqa: F401
from sidecar.ai.utils.coercion import coerce_positive_finite_float
from sidecar.protocol import (
    CHAT_ERROR_METHOD,
    CHAT_THINKING_KIND_STATUS,
    CHAT_THINKING_METHOD,
)
from sidecar.runtime.chat_models import (
    TOKEN_PIECE_RE,
    ChatRequestError,
    merge_error_data,
)
from sidecar.runtime.diagnostics import sanitize_diagnostic_text, sanitize_diagnostic_value
from sidecar.runtime.rpc import notification

CHAT_INVALID_PARAMS = CMP_CHAT_INVALID_PARAMS
LOCAL_ZERO_COST_PROVIDERS = frozenset(
    {"ollama", "vllm", "openai-compatible", "replay", "mock"}
)


def _attach_cost_truth(payload: dict[str, Any], provider_cost_usd: Any = None) -> None:
    provider = str(payload.get("provider") or "").strip().lower()
    if provider in LOCAL_ZERO_COST_PROVIDERS:
        payload["cost_usd"] = 0.0
        payload["cost_source"] = "local_zero"
        return
    if isinstance(provider_cost_usd, bool):
        provider_cost_usd = None
    try:
        normalized_cost = float(provider_cost_usd)
    except (TypeError, ValueError):
        normalized_cost = -1.0
    if math.isfinite(normalized_cost) and normalized_cost >= 0.0:
        payload["cost_usd"] = normalized_cost
        payload["cost_source"] = "provider"
        return
    payload["cost_usd"] = None
    payload["cost_source"] = "unavailable"


def request_id_from_params(params: Any, message_id: Any) -> str:
    if isinstance(params, dict):
        request_id = params.get("request_id")
        if isinstance(request_id, str) and request_id.strip():
            return request_id.strip()
    if message_id is not None:
        return f"req_{message_id}"
    return "req_unknown"


def trace_id_from_params(params: Any, message_id: Any) -> str:
    if isinstance(params, dict):
        trace_id = params.get("trace_id")
        if isinstance(trace_id, str) and trace_id.strip():
            return trace_id.strip()
    return request_id_from_params(params, message_id)


def session_id_from_params(params: Any) -> str | None:
    if not isinstance(params, dict):
        return None
    session_id = params.get("session_id")
    if isinstance(session_id, str) and session_id.strip():
        return session_id.strip()
    return None


def notification_context(
    request_id: str, *, trace_id: str | None, session_id: str | None
) -> dict[str, Any]:
    payload: dict[str, Any] = {"request_id": request_id}
    if trace_id:
        payload["trace_id"] = trace_id
    if session_id:
        payload["session_id"] = session_id
    return payload


def thinking_notification(
    request_id: str,
    *,
    trace_id: str | None,
    session_id: str | None,
    delta: str,
    thinking_id: str,
    kind: str = CHAT_THINKING_KIND_STATUS,
    persist: bool = False,
    tokens_per_second: float | None = None,
    thinking_budget_chars: int | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        **notification_context(request_id, trace_id=trace_id, session_id=session_id),
        "delta": delta,
        "thinking_id": thinking_id,
        "kind": kind,
        "persist": persist,
    }
    if tokens_per_second is not None:
        payload["tokens_per_second"] = float(tokens_per_second)
    if thinking_budget_chars is not None and thinking_budget_chars > 0:
        payload["thinking_budget_chars"] = int(thinking_budget_chars)
    return notification(CHAT_THINKING_METHOD, payload)


def chat_error_notification(error: ChatRequestError) -> dict[str, Any]:
    payload: dict[str, Any] = {
        **notification_context(
            error.request_id,
            trace_id=error.trace_id,
            session_id=error.session_id,
        ),
        "code": error.code,
        "message": sanitize_diagnostic_text(error.message, limit=512),
        "retryable": error.retryable,
    }
    sanitized_data = sanitize_diagnostic_value(error.data)
    merge_error_data(payload, sanitized_data if isinstance(sanitized_data, dict) else None)
    return notification(CHAT_ERROR_METHOD, payload)


def emit_approval_rejection(
    *,
    runtime: Any | None,
    request_id: str,
    trace_id: str | None,
    session_id: str | None,
    tool_name: str,
    tool_call_id: str | None = None,
    observation_store: ToolObservationStore | None = None,
) -> dict[str, Any]:
    """Emit a ``StopEvent`` on *runtime* (if provided) and return the
    ``chat.error`` notification dict for an explicit user approval rejection.

    Returns the notification dict so the production caller (the approval-
    denied branch in ``request_dispatch.py``) can append it to the
    ``ProcessOutcome.notifications`` list. The replay-corpus driver
    passes a ``RecordingLoopRuntime`` so the same call also surfaces the
    ``StopEvent`` for the loop-events corpus assertion.

    When ``observation_store`` is provided, also writes a
    ``KIND_USER_APPROVAL_REJECTED`` row so the Electron promotion bridge
    (Phase 6 Q19) can promote it into a canonical
    ``approval_resolved`` ``turn_event``.
    """
    reason = f"User rejected approval for {tool_name}"
    if runtime is not None:
        try:
            runtime.emit(
                StopEvent(reason=reason, code=CMP_APPROVAL_REJECTED, user_hint="")
            )
        except Exception:  # noqa: BLE001 — diagnostic-only emit.
            pass
    if observation_store is not None:
        try:
            observation_store.record(
                ToolObservationEvent(
                    kind=KIND_USER_APPROVAL_REJECTED,
                    request_id=request_id,
                    tool_call_id=tool_call_id or None,
                    tool_name=tool_name or None,
                    error_code=CMP_APPROVAL_REJECTED,
                    summary=reason,
                )
            )
        except Exception:  # noqa: BLE001 — audit must not break the rejection path.
            pass
    return notification(
        CHAT_ERROR_METHOD,
        {
            **notification_context(request_id, trace_id=trace_id, session_id=session_id),
            "code": CMP_APPROVAL_REJECTED,
            "message": reason,
            "retryable": False,
        },
    )


def extract_latest_user_content(messages: Any) -> str:
    if not isinstance(messages, list):
        raise ValueError("chat.send params.messages must be a list")

    for message in reversed(messages):
        if not isinstance(message, dict):
            continue
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()

    raise ValueError("chat.send requires at least one non-empty user message")


def estimate_text_tokens(text: str) -> int:
    if not text:
        return 0
    return len(TOKEN_PIECE_RE.findall(text))


def tokenize_with_whitespace(text: str) -> list[str]:
    if not text:
        return []
    words = text.split(" ")
    if len(words) == 1:
        return words
    return [f"{word} " for word in words[:-1]] + [words[-1]]


def _fallback_usage_payload(
    *, latest_user_content: str, output_tokens: int, provider: str, model: str
) -> dict[str, Any]:
    input_tokens = max(1, estimate_text_tokens(latest_user_content))
    total_tokens = max(input_tokens + max(int(output_tokens), 0), 0)
    payload = {
        "input_tokens": input_tokens,
        "output_tokens": max(int(output_tokens), 0),
        "total_tokens": total_tokens,
        "provider": provider,
        "model": model,
        "estimated": True,
    }
    _attach_cost_truth(payload)
    return payload


def attach_context_window(usage_payload: dict[str, Any], engine: Any) -> None:
    """Forward the loaded model's true context window to the renderer.

    The renderer uses ``usage.context_window`` as the denominator for the
    context-usage meter, preferring it over its hard-coded fallback table so
    the meter is accurate for every model (and appears for models the table
    does not know). A missing/unavailable window leaves the key unset so the
    renderer falls back to its own estimate; never fail a turn over a hint.

    The window reported here is the one requests are actually served with (the
    configured num_ctx clamp when the engine exposes one), not the model's
    native window -- otherwise the meter's denominator disagrees with the
    threshold the sidecar compacts against. ``resolve_context_window_hint``
    (not ``resolve_effective_context_window``) is used so an unknown window
    stays unset rather than publishing the 200K fallback as if it were truth.
    """
    if not isinstance(usage_payload, dict) or engine is None:
        return
    try:
        from sidecar.ai.context.token_budget import resolve_context_window_hint

        window = resolve_context_window_hint(engine)
    except Exception:  # noqa: BLE001 — meter hint must never break a turn
        window = None
    if isinstance(window, int) and window > 0:
        usage_payload["context_window"] = window


def attach_compact_threshold(
    usage_payload: dict[str, Any],
    engine: Any,
    config: Any,
    *,
    num_tools: int = 0,
    threshold_tokens: int | None = None,
) -> None:
    """Forward the auto-compaction trigger threshold to the renderer meter.

    The renderer renders the context ring against ``effective_context x
    auto_compact_ratio`` — the same quantity the sidecar's compaction trigger
    uses — so the ring cannot read green while compaction is imminent. When
    the caller holds the real per-request budget (the routed lane's
    ``BudgetTracker``), it passes the exact ``threshold_tokens``; otherwise
    this mirrors ``TokenBudget`` construction from engine/config best-effort.
    A missing/unavailable threshold leaves the key unset (the renderer falls
    back to a mirrored default ratio); never fail a turn over a meter hint.
    """
    if not isinstance(usage_payload, dict):
        return
    threshold = max(int(threshold_tokens or 0), 0)
    if threshold <= 0 and engine is not None:
        try:
            from sidecar.ai.context.token_budget import (
                TokenBudget,
                resolve_auto_compact_ratio,
                resolve_context_window_hint,
            )

            # Same clamped window the real budget uses, so the ring's trigger
            # line matches the threshold compaction actually fires at.
            window = resolve_context_window_hint(engine, config)
            if isinstance(window, int) and window > 0:
                max_output = (
                    engine.get_model_max_output_tokens()
                    or getattr(config, "max_tokens", 16_384)
                    or 16_384
                )
                budget = TokenBudget(
                    context_window=int(window),
                    max_output_tokens=int(max_output),
                    auto_compact_ratio=resolve_auto_compact_ratio(
                        config,
                        model_id=str(getattr(config, "model", "") or ""),
                    ),
                )
                threshold = budget.auto_compact_threshold(max(int(num_tools or 0), 0))
        except Exception:  # noqa: BLE001 — meter hint must never break a turn
            threshold = 0
    if threshold > 0:
        usage_payload["compact_threshold_tokens"] = threshold


def attach_context_used_tokens(
    usage_payload: dict[str, Any],
    *,
    context_tokens_estimate: int | None,
) -> None:
    """Publish the single authoritative "context used" figure for the meter.

    Ollama's ``prompt_eval_count`` only counts newly evaluated tokens on a
    server-side prompt-cache hit, so ``last_request_input_tokens`` can wildly
    under-report the true prompt size. The sidecar's own estimate counts the
    actually-assembled prompt, so the truthful reading is the max of the two —
    computed here, once, rather than re-derived by a renderer guard. The keys
    are omitted when neither figure is positive so a present-but-zero record
    never reads as an authoritative 0.
    """
    if not isinstance(usage_payload, dict):
        return
    estimate = max(int(context_tokens_estimate or 0), 0)
    provider_tokens = max(
        int(usage_payload.get("last_request_input_tokens", 0) or 0), 0
    )
    used = max(provider_tokens, estimate)
    if used <= 0:
        return
    usage_payload["context_used_tokens"] = used
    usage_payload["context_used_source"] = (
        "provider" if provider_tokens >= estimate else "estimate"
    )


def _decision_usage_payload(
    usage: Any,
    *,
    fallback_provider: str,
    fallback_model: str,
) -> dict[str, Any] | None:
    if usage is None:
        return None
    input_tokens = max(int(getattr(usage, "input_tokens", 0) or 0), 0)
    output_tokens = max(int(getattr(usage, "output_tokens", 0) or 0), 0)
    total_tokens = max(int(getattr(usage, "total_tokens", 0) or 0), 0)
    if total_tokens <= 0:
        total_tokens = input_tokens + output_tokens
    if total_tokens <= 0 and input_tokens <= 0 and output_tokens <= 0:
        return None
    payload: dict[str, Any] = {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "provider": str(getattr(usage, "provider", "") or fallback_provider),
        "model": str(getattr(usage, "model", "") or fallback_model),
        "estimated": False,
    }
    # Provider-truth size of the most recent request (overwrite-not-add across
    # tool-loop iterations). Omitted when zero so the renderer meter falls
    # through to estimation instead of reading a present-but-zero record as 0.
    last_request_input_tokens = max(
        int(getattr(usage, "last_request_input_tokens", 0) or 0), 0
    )
    if last_request_input_tokens > 0:
        payload["last_request_input_tokens"] = last_request_input_tokens

    positive_usage_fields = {
        "generation_tokens": max(
            int(getattr(usage, "generation_tokens", 0) or 0), 0
        ),
        "generation_duration_ms": coerce_positive_finite_float(
            getattr(usage, "generation_duration_ms", 0)
        ),
        "prompt_eval_duration_ms": coerce_positive_finite_float(
            getattr(usage, "prompt_eval_duration_ms", 0)
        ),
        "load_duration_ms": coerce_positive_finite_float(
            getattr(usage, "load_duration_ms", 0)
        ),
        "time_to_first_token_ms": coerce_positive_finite_float(
            getattr(usage, "time_to_first_token_ms", 0)
        ),
    }
    for field, value in positive_usage_fields.items():
        if value > 0:
            payload[field] = value
    _attach_cost_truth(payload, getattr(usage, "provider_cost_usd", None))
    raw_usage = getattr(usage, "raw_usage", None)
    if isinstance(raw_usage, dict) and raw_usage:
        payload["raw_usage"] = dict(raw_usage)
    return payload


def build_vision_prompt(messages: list[dict[str, object]]) -> str:
    sections: list[str] = []
    for message in messages:
        role = str(message.get("role") or "").strip().lower() or "user"
        content = str(message.get("content") or "").strip()
        if not content:
            continue
        sections.append(f"{role.upper()}:\n{content}")
    return "\n\n".join(sections).strip()


def engine_supports_live_reasoning_stream(engine: Any) -> bool:
    capabilities = getattr(engine, "capabilities", {})
    if not isinstance(capabilities, dict) or capabilities.get("thinking") is not True:
        return False
    return callable(getattr(engine, "stream", None))


def mode_from_params(params: Any, default_mode: str) -> str:
    if not isinstance(params, dict):
        return normalize_mode(default_mode, default=default_mode)
    mode = params.get("mode")
    if isinstance(mode, str) and mode.strip():
        return normalize_mode(mode, default=default_mode)
    return normalize_mode(default_mode, default=default_mode)


# ---------------------------------------------------------------------------
# IPC debouncing (H8)
# ---------------------------------------------------------------------------


class DebouncedNotificationWriter:
    """Wraps a notification writer with time-based debouncing.

    Non-debounced methods (``chat.token``, ``chat.thinking``, ``tool.*``)
    pass through immediately.  Debounced methods (``budget.update``,
    ``cost.update``) are batched and emitted at most every *interval_ms*
    milliseconds.  Call :meth:`flush` before ``chat.done`` to guarantee
    the final state is always sent.
    """

    DEBOUNCED_METHODS = frozenset({"budget.update", "cost.update"})

    def __init__(
        self,
        writer: Callable[[dict[str, Any]], None],
        interval_ms: int = 500,
    ) -> None:
        self._writer = writer
        self._interval_s = max(0.1, interval_ms / 1000.0)
        self._pending: dict[str, dict[str, Any]] = {}
        self._last_emit_time: float = 0.0

    def __call__(self, item: dict[str, Any]) -> None:
        method = str(item.get("method", ""))
        if method not in self.DEBOUNCED_METHODS:
            self._writer(item)
            return
        self._pending[method] = item
        now = time.monotonic()
        if now - self._last_emit_time >= self._interval_s:
            self._flush_pending()

    def flush(self) -> None:
        """Emit all pending debounced notifications."""
        self._flush_pending()

    def _flush_pending(self) -> None:
        for item in self._pending.values():
            self._writer(item)
        self._pending.clear()
        self._last_emit_time = time.monotonic()
