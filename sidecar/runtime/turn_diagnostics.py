from __future__ import annotations

import threading
import time
from typing import Any, Mapping

from sidecar.ai.routing.turn_event_contract import CANONICAL_TURN_COUNTER_FIELDS
from sidecar.runtime.provider_sampler_diagnostics import provider_sampler_diagnostics_payload

_MAX_DIAGNOSTIC_COUNTER = 1_000_000_000
_PROVIDER_COMPLETION_COUNT_FIELDS = (
    "output_text_delta_count",
    "output_text_delta_chars",
    "output_text_done_count",
    "output_text_done_chars",
    "tool_call_count",
)
_PROVIDER_COMPLETION_ENUM_FIELDS = {
    "terminal_event_type": frozenset({"response.completed", "response.incomplete"}),
    "terminal_text_source": frozenset({"delta", "output_text_done", "none"}),
    "finish_reason": frozenset({"stop", "length", "tool_calls"}),
}
# Recorded only when reported, so a provider that does not track them keeps its shape.
_PROVIDER_COMPLETION_OPTIONAL_COUNT_FIELDS = (
    "ignored_event_count",
    "undecodable_line_count",
    "duplicate_function_call_event_count",
)
_IGNORED_EVENT_TYPES_FIELD = "ignored_event_types"
_PROVIDER_REASONING_EFFORTS = frozenset({"automatic", "none", "low", "medium", "high", "max"})
# The store -- not the engine -- is the boundary reaching the renderer, so these bounds
# are re-applied here even though the engine already sanitizes. An event-type string is
# attacker-influenced wire text: never a payload, only a type name, and anything outside
# this charset/length collapses to a sentinel.
_MAX_HISTOGRAM_ENTRIES = 12
_MAX_HISTOGRAM_KEY_CHARS = 64
_HISTOGRAM_KEY_EXTRA_CHARS = frozenset("._-")
_HISTOGRAM_UNSAFE_KEY = "unsafe"
_HISTOGRAM_OVERFLOW_KEY = "other"


def _safe_histogram_key(value: Any) -> str:
    text = value.strip() if isinstance(value, str) else ""
    if not text or len(text) > _MAX_HISTOGRAM_KEY_CHARS:
        return _HISTOGRAM_UNSAFE_KEY
    if not all(char.isalnum() or char in _HISTOGRAM_KEY_EXTRA_CHARS for char in text):
        return _HISTOGRAM_UNSAFE_KEY
    return text


def _normalize_type_histogram(value: Any) -> dict[str, int]:
    """Bound a provider-supplied type->count histogram. Never records payloads."""

    if not isinstance(value, Mapping):
        return {}
    normalized: dict[str, int] = {}
    for raw_key, raw_count in value.items():
        try:
            count = int(raw_count)
        except (TypeError, ValueError):
            continue
        if count <= 0:
            continue
        key = _safe_histogram_key(raw_key)
        # Keep one slot free for the overflow bucket so folding can never be the
        # thing that drops a count -- a silently truncated histogram reads as
        # "nothing else happened", the opposite of the signal.
        if key not in normalized and len(normalized) >= _MAX_HISTOGRAM_ENTRIES - 1:
            key = _HISTOGRAM_OVERFLOW_KEY
        normalized[key] = min(normalized.get(key, 0) + count, _MAX_DIAGNOSTIC_COUNTER)
    return normalized


def _estimate_text_tokens(text: str) -> int:
    normalized = str(text or "")
    if not normalized:
        return 0
    return _estimate_token_count_from_chars(len(normalized))


def _estimate_token_count_from_chars(character_count: int) -> int:
    return max(1, (character_count + 3) // 4) if character_count > 0 else 0


def _normalize_debug_options(value: Any) -> dict[str, bool]:
    source = value if isinstance(value, dict) else {}
    result = {
        "disable_thinking": source.get("disable_thinking") is True,
        "lean_context": source.get("lean_context") is True,
        "plain_chat_mode": source.get("plain_chat_mode") is True,
    }
    return {key: enabled for key, enabled in result.items() if enabled}


class TurnDiagnosticsStore:
    """Thread-safe store for the latest chat-turn diagnostics."""

    def __init__(self, *, max_retained_turns: int = 64) -> None:
        self._lock = threading.Lock()
        self._turns: dict[str, dict[str, Any]] = {}
        self._latest_request_id: str | None = None
        self._max_retained_turns = max(int(max_retained_turns or 64), 1)

    def begin_turn(
        self,
        *,
        request_id: str,
        session_id: str | None,
        mode: str,
        agent_id: str | None = None,
        debug_options: dict[str, Any] | None = None,
    ) -> None:
        now = time.monotonic()
        normalized_request_id = str(request_id or "").strip()
        if not normalized_request_id:
            return
        payload = {
            "request_id": normalized_request_id,
            "session_id": str(session_id or "").strip() or None,
            "mode": str(mode or "").strip() or "chat",
            "agent_id": str(agent_id or "").strip() or None,
            "debug_options": _normalize_debug_options(debug_options),
            "_turn_started_at": now,
            "_provider_started_at": None,
            "_first_chunk_at": None,
            "_first_visible_at": None,
            "_completed_at": None,
            "_visible_output_chars": 0,
            "_visible_output_tokens_estimate": 0,
            "_updated_at": now,
        }
        with self._lock:
            self._turns.pop(normalized_request_id, None)
            self._turns[normalized_request_id] = payload
            self._latest_request_id = normalized_request_id
            self._prune_locked()

    def record_request_metrics(
        self,
        *,
        request_id: str,
        mode: str | None = None,
        context_tokens_estimate: int | None = None,
        message_count: int | None = None,
        tool_schema_count: int | None = None,
    ) -> None:
        updates: dict[str, Any] = {}
        if mode is not None:
            updates["mode"] = str(mode or "").strip() or "chat"
        if context_tokens_estimate is not None:
            updates["context_tokens_estimate"] = max(int(context_tokens_estimate), 0)
        if message_count is not None:
            updates["message_count"] = max(int(message_count), 0)
        if tool_schema_count is not None:
            updates["tool_schema_count"] = max(int(tool_schema_count), 0)
        self._merge(request_id, updates)

    def record_request_fingerprint(
        self,
        *,
        request_id: str,
        fingerprint: Mapping[str, Any],
    ) -> None:
        self._merge(request_id, {"request_fingerprint": dict(fingerprint)})

    def record_stream_counters(
        self,
        *,
        request_id: str,
        counters: Mapping[str, Any],
    ) -> None:
        """Record per-turn provider-stream-normalizer counters.

        Surfaces under ``stream_counters`` in
        ``runtime.latest_turn_diagnostics``. Caller wraps in ``try/except``;
        diagnostic-side failures must not break a turn.
        """
        self._merge(request_id, {"stream_counters": dict(counters)})

    def record_provider_completion_shape(
        self,
        *,
        request_id: str,
        diagnostics: Mapping[str, Any],
    ) -> None:
        """Record allowlisted aggregate provider-completion metadata only."""
        source = diagnostics if isinstance(diagnostics, Mapping) else {}
        normalized: dict[str, Any] = {}
        optional = _PROVIDER_COMPLETION_OPTIONAL_COUNT_FIELDS
        for field in _PROVIDER_COMPLETION_COUNT_FIELDS + optional:
            if field in optional and field not in source:
                continue
            try:
                value = int(source.get(field, 0))
            except (TypeError, ValueError):
                continue
            normalized[field] = min(max(value, 0), _MAX_DIAGNOSTIC_COUNTER)
        for field, allowed_values in _PROVIDER_COMPLETION_ENUM_FIELDS.items():
            text_value = str(source.get(field) or "").strip()
            if text_value in allowed_values:
                normalized[field] = text_value
        histogram = _normalize_type_histogram(source.get(_IGNORED_EVENT_TYPES_FIELD))
        if histogram:
            normalized[_IGNORED_EVENT_TYPES_FIELD] = histogram
        if not normalized:
            return
        now = time.monotonic()
        with self._lock:
            turn = self._get_turn_locked(request_id)
            if turn is None:
                return
            if isinstance(turn.get("terminal_completion"), dict):
                ignored_count = int(
                    turn.get(
                        "post_terminal_provider_completion_shape_ignored_count",
                        0,
                    )
                    or 0
                )
                turn["post_terminal_provider_completion_shape_ignored_count"] = min(
                    ignored_count + 1,
                    _MAX_DIAGNOSTIC_COUNTER,
                )
            else:
                turn["provider_completion_shape"] = normalized
            turn["_updated_at"] = now

    def record_terminal_completion(
        self,
        *,
        request_id: str,
        completion_source: str,
        visible_response_chars: int,
        tool_result_count: int,
        successful_tool_result_count: int,
        fallback_applied: bool,
    ) -> None:
        """Record the redacted terminal visibility decision."""
        normalized_source = str(completion_source or "").strip()[:64] or "model"
        self._merge(
            request_id,
            {
                "terminal_completion": {
                    "completion_source": normalized_source,
                    "visible_response_chars": min(
                        max(int(visible_response_chars or 0), 0),
                        _MAX_DIAGNOSTIC_COUNTER,
                    ),
                    "tool_result_count": min(
                        max(int(tool_result_count or 0), 0),
                        _MAX_DIAGNOSTIC_COUNTER,
                    ),
                    "successful_tool_result_count": min(
                        max(int(successful_tool_result_count or 0), 0),
                        _MAX_DIAGNOSTIC_COUNTER,
                    ),
                    "fallback_applied": fallback_applied is True,
                }
            },
        )

    def record_canonical_turn_counters(
        self,
        *,
        request_id: str,
        counters: Mapping[str, Any],
    ) -> None:
        """Accept partial snapshots and drop unknown fields rather than arbitrary maps."""
        source = counters if isinstance(counters, Mapping) else {}
        normalized: dict[str, Any] = {}
        for field in CANONICAL_TURN_COUNTER_FIELDS:
            value = source.get(field)
            if value is None:
                continue
            try:
                numeric = float(value)
            except (TypeError, ValueError):
                continue
            if numeric < 0:
                continue
            normalized[field] = (
                int(numeric) if numeric.is_integer() and not field.endswith("_ms") else numeric
            )
        if normalized:
            self._merge(request_id, {"canonical_turn_counters": normalized})

    def record_provider_request(
        self,
        *,
        request_id: str,
        think_enabled: bool,
        num_predict: int | None,
        temperature: float | int,
        message_count: int,
        tool_count: int,
        tool_capable: bool,
        provider_reasoning_effort: str | None = None,
        final_output_tokens: int | None = None,
        thinking_headroom_tokens: int = 0,
        tool_payload_bytes: int = 0,
        provider_sampler: Mapping[str, Any] | None = None,
    ) -> None:
        started_at = time.monotonic()
        normalized_reasoning_effort = str(provider_reasoning_effort or "").strip().lower()
        if normalized_reasoning_effort not in _PROVIDER_REASONING_EFFORTS:
            normalized_reasoning_effort = ""
        turn_started_at = None
        with self._lock:
            turn = self._get_turn_locked(request_id)
            if turn is not None:
                turn_started_at = turn.get("_turn_started_at")
        self._merge(
            request_id,
            {
                "think_enabled": think_enabled is True,
                "provider_reasoning_effort": normalized_reasoning_effort or None,
                "provider_num_predict": None if num_predict is None else max(int(num_predict), 0),
                "provider_final_output_tokens": (
                    None if final_output_tokens is None else max(int(final_output_tokens), 0)
                ),
                "provider_thinking_headroom_tokens": max(
                    int(thinking_headroom_tokens),
                    0,
                ),
                "provider_temperature": float(temperature),
                "provider_message_count": max(int(message_count), 0),
                "provider_tool_count": max(int(tool_count), 0),
                "provider_tool_capable": tool_capable is True,
                "provider_tool_payload_bytes": max(int(tool_payload_bytes), 0),
                **provider_sampler_diagnostics_payload(provider_sampler),
                **(
                    {
                        "time_to_provider_request_start_ms": max(
                            int((started_at - turn_started_at) * 1000),
                            0,
                        )
                    }
                    if isinstance(turn_started_at, (int, float))
                    else {}
                ),
                "_provider_started_at": started_at,
            },
        )

    def record_first_chunk(self, *, request_id: str) -> None:
        now = time.monotonic()
        with self._lock:
            turn = self._get_turn_locked(request_id)
            if turn is None:
                return
            self._record_first_chunk_locked(turn, now)
            turn["_updated_at"] = now

    def record_visible_output(self, *, request_id: str, text: str) -> None:
        normalized = str(text or "")
        if not normalized:
            return
        now = time.monotonic()
        with self._lock:
            turn = self._get_turn_locked(request_id)
            if turn is None:
                return
            self._record_first_chunk_locked(turn, now)
            if turn.get("_first_visible_at") is None:
                turn["_first_visible_at"] = now
                started_at = turn.get("_provider_started_at")
                if isinstance(started_at, (int, float)):
                    turn["time_to_first_visible_token_ms"] = max(
                        int((now - started_at) * 1000),
                        0,
                    )
            turn["_visible_output_chars"] = int(turn.get("_visible_output_chars") or 0) + len(
                normalized
            )
            turn["_visible_output_tokens_estimate"] = _estimate_token_count_from_chars(
                int(turn["_visible_output_chars"])
            )
            turn["visible_output_chars"] = int(turn["_visible_output_chars"])
            turn["visible_output_tokens_estimate"] = int(turn["_visible_output_tokens_estimate"])
            turn["_updated_at"] = now

    def record_buffered_visible_output(
        self,
        *,
        request_id: str,
        text: str,
        reason: str,
    ) -> None:
        normalized = str(text or "")
        if not normalized:
            return
        normalized_reason = str(reason or "").strip().lower() or "unknown"
        now = time.monotonic()
        with self._lock:
            turn = self._get_turn_locked(request_id)
            if turn is None:
                return
            turn["buffered_visible_output_chars"] = int(
                turn.get("buffered_visible_output_chars") or 0
            ) + len(normalized)
            turn["buffered_visible_output_tokens_estimate"] = _estimate_token_count_from_chars(
                int(turn["buffered_visible_output_chars"])
            )
            reasons = [
                str(item)
                for item in turn.get("buffered_visible_output_reasons", [])
                if str(item).strip()
            ]
            if normalized_reason not in reasons:
                reasons.append(normalized_reason)
            turn["buffered_visible_output_reasons"] = reasons
            turn.setdefault("buffered_visible_output_disposition", "dropped")
            turn["_updated_at"] = now

    def mark_buffered_visible_output_flushed(self, *, request_id: str) -> None:
        """Promote ``buffered_visible_output_disposition`` to ``"flushed"``.

        Called after :class:`StopController` drains buffered visible content
        into ``chat.token`` events on guardrail abort. The recording from
        :meth:`record_buffered_visible_output` defaulted to ``"dropped"``; this
        flips it to ``"flushed"`` once we know the user actually saw the text.
        """
        normalized_request_id = str(request_id or "").strip()
        if not normalized_request_id:
            return
        now = time.monotonic()
        with self._lock:
            turn = self._get_turn_locked(normalized_request_id)
            if turn is None:
                return
            turn["buffered_visible_output_disposition"] = "flushed"
            turn["_updated_at"] = now

    def record_provider_usage(
        self,
        *,
        request_id: str,
        prompt_eval_count: int | None = None,
        eval_count: int | None = None,
        cached_tokens: int | None = None,
        prompt_eval_duration_ns: int | None = None,
        eval_duration_ns: int | None = None,
        total_duration_ns: int | None = None,
        load_duration_ns: int | None = None,
        provider_label: str | None = None,
    ) -> None:
        """Record provider-reported usage metrics in a provider-agnostic shape.

        Semantics of the generic fields:

        - ``prompt_eval_count`` — number of prompt tokens evaluated
          (Ollama's ``prompt_eval_count``, OpenAI's ``prompt_tokens``).
        - ``eval_count`` — number of output tokens generated
          (Ollama's ``eval_count``, OpenAI's ``completion_tokens``).
        - ``cached_tokens`` — prompt tokens served from the provider's
          prompt cache, if the provider reports that separately (OpenAI
          ``prompt_tokens_details.cached_tokens``, vLLM prefix-cache signal).
          Ollama does not surface this directly; leave as ``None``.
        - ``*_duration_ns`` — Ollama-style duration fields, nanoseconds.

        All values are optional; only keys with finite, non-negative numbers
        are merged. A ``provider_tokens_per_second`` value is derived when
        ``eval_count`` and ``eval_duration_ns`` are both positive.
        """

        updates: dict[str, Any] = {}

        def _coerce_count(value: Any) -> int | None:
            if value is None:
                return None
            try:
                coerced = int(value)
            except (TypeError, ValueError):
                return None
            return max(coerced, 0)

        def _coerce_duration_ns(value: Any) -> int | None:
            if value is None:
                return None
            try:
                coerced = int(value)
            except (TypeError, ValueError):
                return None
            return max(coerced, 0)

        normalized_prompt_eval = _coerce_count(prompt_eval_count)
        normalized_eval = _coerce_count(eval_count)
        normalized_cached = _coerce_count(cached_tokens)
        normalized_prompt_eval_ns = _coerce_duration_ns(prompt_eval_duration_ns)
        normalized_eval_ns = _coerce_duration_ns(eval_duration_ns)
        normalized_total_ns = _coerce_duration_ns(total_duration_ns)
        normalized_load_ns = _coerce_duration_ns(load_duration_ns)
        normalized_provider_label = str(provider_label or "").strip() or None

        if normalized_prompt_eval is not None:
            updates["provider_prompt_eval_count"] = normalized_prompt_eval
        if normalized_eval is not None:
            updates["provider_eval_count"] = normalized_eval
        if normalized_cached is not None:
            updates["provider_cached_tokens"] = normalized_cached
            if normalized_prompt_eval is not None and normalized_prompt_eval > 0:
                updates["provider_prompt_cache_hit_ratio"] = round(
                    min(normalized_cached / normalized_prompt_eval, 1.0),
                    4,
                )
        if normalized_prompt_eval_ns is not None:
            updates["provider_prompt_eval_duration_ns"] = normalized_prompt_eval_ns
            updates["provider_prompt_eval_duration_ms"] = normalized_prompt_eval_ns // 1_000_000
        if normalized_eval_ns is not None:
            updates["provider_eval_duration_ns"] = normalized_eval_ns
            updates["provider_eval_duration_ms"] = normalized_eval_ns // 1_000_000
        if normalized_total_ns is not None:
            updates["provider_total_duration_ns"] = normalized_total_ns
            updates["provider_total_duration_ms"] = normalized_total_ns // 1_000_000
        if normalized_load_ns is not None:
            updates["provider_load_duration_ns"] = normalized_load_ns
            updates["provider_load_duration_ms"] = normalized_load_ns // 1_000_000
        if normalized_provider_label is not None:
            updates["provider_usage_source"] = normalized_provider_label

        if (
            normalized_eval is not None
            and normalized_eval > 0
            and normalized_eval_ns is not None
            and normalized_eval_ns > 0
        ):
            seconds = normalized_eval_ns / 1_000_000_000
            if seconds > 0:
                updates["provider_tokens_per_second"] = round(normalized_eval / seconds, 2)

        if not updates:
            return
        self._merge(request_id, updates)

    def complete_provider_request(self, *, request_id: str) -> None:
        now = time.monotonic()
        with self._lock:
            turn = self._get_turn_locked(request_id)
            if turn is None:
                return
            turn["_completed_at"] = now
            visible_tokens = int(turn.get("_visible_output_tokens_estimate") or 0)
            first_visible_at = turn.get("_first_visible_at")
            if isinstance(first_visible_at, (int, float)) and visible_tokens > 0:
                visible_duration = max(now - first_visible_at, 0.0)
                if visible_duration > 0:
                    turn["visible_tokens_per_second_estimate"] = round(
                        visible_tokens / visible_duration,
                        2,
                    )
            turn["_updated_at"] = now

    def _build_public_payload(self, source: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in source.items() if not str(key).startswith("_")}

    def snapshot(self) -> dict[str, Any] | None:
        with self._lock:
            if not self._latest_request_id:
                return None
            latest = self._turns.get(self._latest_request_id)
            if latest is None:
                return None
            payload = self._build_public_payload(latest)
        return payload or None

    def get_snapshot_for_request(self, request_id: str) -> dict[str, Any] | None:
        """Return the retained snapshot for request_id if it is still available."""
        normalized = str(request_id or "").strip()
        if not normalized:
            return None
        with self._lock:
            turn = self._turns.get(normalized)
            if turn is None:
                return None
            payload = self._build_public_payload(turn)
        return payload or None

    def _merge(self, request_id: str, updates: dict[str, Any]) -> None:
        now = time.monotonic()
        with self._lock:
            turn = self._get_turn_locked(request_id)
            if turn is None:
                return
            turn.update(updates)
            turn["_updated_at"] = now

    def _get_turn_locked(self, request_id: str) -> dict[str, Any] | None:
        normalized = str(request_id or "").strip()
        if not normalized:
            return None
        return self._turns.get(normalized)

    def _record_first_chunk_locked(self, turn: dict[str, Any], now: float) -> None:
        if turn.get("_first_chunk_at") is not None:
            return
        turn["_first_chunk_at"] = now
        started_at = turn.get("_provider_started_at")
        if isinstance(started_at, (int, float)):
            turn["time_to_first_chunk_ms"] = max(
                int((now - started_at) * 1000),
                0,
            )

    def _prune_locked(self) -> None:
        while len(self._turns) > self._max_retained_turns:
            oldest_request_id = next(iter(self._turns))
            self._turns.pop(oldest_request_id, None)
            if self._latest_request_id == oldest_request_id:
                self._latest_request_id = next(reversed(self._turns), None)
