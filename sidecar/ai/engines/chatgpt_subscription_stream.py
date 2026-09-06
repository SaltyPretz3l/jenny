"""Responses request serialization and SSE parsing for ChatGPT subscriptions."""

from __future__ import annotations

import json
import logging
from collections.abc import Generator, Iterable
from typing import Any, NoReturn

from sidecar.ai.engines.chatgpt_subscription_request import (
    build_responses_payload,
    non_empty_string,
)
from sidecar.ai.engines.http_utils import (
    raise_if_cancelled as _raise_if_cancelled_shared,
)
from sidecar.ai.engines.http_utils import register_cancel_callback
from sidecar.ai.engines.provider_http import (
    ProviderHttpError,
    classify_http_response_error,
    is_retryable_http_status,
    parse_retry_after_seconds,
)
from sidecar.ai.error_codes import CMP_CLOUD_HTTP_ERROR, CMP_CLOUD_RATE_LIMITED
from sidecar.ai.exceptions import GenerationError
from sidecar.ai.tools.models import (
    GenerationResult,
    GenerationUsage,
    StreamChunk,
    StreamingEvent,
    ToolCallRequest,
)
from sidecar.runtime.bounded_io import iter_bounded_byte_lines
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.turn_state import TURN_STATE_CANCELLED

logger = logging.getLogger(__name__)

_SSE_DATA_PREFIX = "data:"
_MAX_STREAM_LINE_BYTES = 1024 * 1024
_MAX_STREAM_TOTAL_BYTES = 32 * 1024 * 1024
_STREAM_READ_CHUNK_BYTES = 64 * 1024
_MAX_ERROR_BODY_BYTES = 64 * 1024
_RATE_LIMIT_CODES = frozenset(
    {"insufficient_quota", "usage_not_included", "rate_limit_exceeded"}
)
# Backend-side congestion, not a user-fixable fault: the same request usually
# succeeds on a retry, so these must reach the UI as retryable.
_TRANSIENT_SERVER_CODES = frozenset({"server_is_overloaded", "slow_down"})
_CONTEXT_OVERFLOW_CODE = "context_length_exceeded"
_MAX_SAFE_ERROR_FIELD_CHARS = 64
_HTTP_BAD_REQUEST = 400
_HTTP_UNAUTHORIZED = 401
_HTTP_TOO_MANY_REQUESTS = 429
# Every other initial status is classified by the shared provider policy; only a
# status whose generic message would be actively misleading gets an override.
_TERMINAL_STATUS_MESSAGES = {_HTTP_UNAUTHORIZED: "ChatGPT credentials were rejected"}
# Bounded, payload-free ignored-event diagnostics. An event type off the wire is
# attacker-influenced text, so it is charset/length gated before it is ever
# counted and the histogram itself is entry-capped.
_MAX_IGNORED_EVENT_TYPE_CHARS = 64
_MAX_IGNORED_EVENT_TYPES = 12
_IGNORED_EVENT_TYPE_UNSAFE = "unsafe"
_IGNORED_EVENT_TYPE_OTHER = "other"
_MAX_DIAGNOSTIC_EVENT_COUNT = 1_000_000_000
# Per-stream identity guard for completed function_call events. Bounded so a
# hostile or looping stream cannot grow the map without limit; on overflow new
# ids stop being tracked rather than evicting an existing one, because evicting
# would silently re-open the double-execution window for the evicted call.
_MAX_TRACKED_CALL_IDS = 1024
_CITATION_START = "\ue200"
_CITATION_END = "\ue201"
_CITATION_SEPARATOR = "\ue202"
_CITATION_BUFFER_LIMIT = 128
_REASONING_SUMMARY_PART_SEPARATOR = "\n\n"


class _CitationNormalizer:
    """Normalize bounded ChatGPT private-use citation markers across deltas."""

    def __init__(self) -> None:
        self._pending = ""

    def feed(self, delta: str) -> str:
        data = self._pending + str(delta or "")
        self._pending = ""
        output: list[str] = []
        cursor = 0
        delimiters = (_CITATION_START, _CITATION_END, _CITATION_SEPARATOR)
        while cursor < len(data):
            positions = [data.find(delimiter, cursor) for delimiter in delimiters]
            positions = [position for position in positions if position >= 0]
            if not positions:
                output.append(data[cursor:])
                break
            marker_at = min(positions)
            output.append(data[cursor:marker_at])
            marker = data[marker_at]
            if marker == _CITATION_END:
                cursor = marker_at + 1
                continue
            end_at = data.find(_CITATION_END, marker_at + 1)
            if end_at < 0:
                pending = data[marker_at:]
                if len(pending) <= _CITATION_BUFFER_LIMIT:
                    self._pending = pending
                    break
                output.append(
                    "".join(char for char in pending if char not in delimiters)
                )
                break
            if marker == _CITATION_START:
                body = data[marker_at + 1 : end_at]
                prefix = f"cite{_CITATION_SEPARATOR}web:"
                index = body[len(prefix) :] if body.startswith(prefix) else ""
                if index.isdigit():
                    output.append(f"[web:{index}]")
            cursor = end_at + 1
        return "".join(output)

    def finish(self) -> str:
        # Pending content begins with a private-use delimiter. An incomplete
        # marker is diagnostic noise, not user-visible answer text.
        self._pending = ""
        return ""


def _normalized_output_text_events(
    event: dict[str, Any],
    normalizer: _CitationNormalizer,
    content_parts: list[str],
) -> tuple[StreamingEvent, ...]:
    delta = event.get("delta")
    if not isinstance(delta, str) or not delta:
        return ()
    normalized_delta = normalizer.feed(delta)
    if not normalized_delta:
        return ()
    content_parts.append(normalized_delta)
    return (StreamingEvent(kind="content", text=normalized_delta),)


def _event_index(value: Any, fallback: int) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return fallback


def _normalized_finalized_text(parts: dict[tuple[int, int], str]) -> str:
    if not parts:
        return ""
    normalizer = _CitationNormalizer()
    normalized = normalizer.feed("".join(parts[key] for key in sorted(parts)))
    normalizer.finish()
    return normalized


def _safe_event_type(value: Any) -> str:
    """Bound an SSE event type for the ignored-event histogram.

    Deliberately a sibling of ``_safe_error_code`` rather than a reuse of it:
    that helper's sentinel is ``"unknown_error"``, which would be
    indistinguishable in the histogram from a provider event type that really is
    named ``unknown_error``.
    """
    if not isinstance(value, str):
        return _IGNORED_EVENT_TYPE_UNSAFE
    text = value.strip()
    if not text or len(text) > _MAX_IGNORED_EVENT_TYPE_CHARS:
        return _IGNORED_EVENT_TYPE_UNSAFE
    if not all(character.isalnum() or character in "._-" for character in text):
        return _IGNORED_EVENT_TYPE_UNSAFE
    return text


class _CompletionShape:
    """Track bounded aggregate text-terminal metadata for one provider call."""

    def __init__(self) -> None:
        self.finalized_text_parts: dict[tuple[int, int], str] = {}
        self.output_text_delta_count = 0
        self.output_text_delta_chars = 0
        self.output_text_done_count = 0
        self.output_text_done_chars = 0
        self.ignored_event_counts: dict[str, int] = {}
        self.ignored_event_total = 0
        self.undecodable_line_count = 0
        self.duplicate_function_call_event_count = 0

    def record_ignored_event(self, event_type: Any) -> None:
        self.ignored_event_total = min(
            self.ignored_event_total + 1, _MAX_DIAGNOSTIC_EVENT_COUNT
        )
        key = _safe_event_type(event_type)
        # Keep one slot free for the overflow bucket so folding can never be the
        # thing that drops a count: a truncated histogram reads as "nothing else
        # happened", which is the opposite of the signal.
        if key not in self.ignored_event_counts and (
            len(self.ignored_event_counts) >= _MAX_IGNORED_EVENT_TYPES - 1
        ):
            key = _IGNORED_EVENT_TYPE_OTHER
        self.ignored_event_counts[key] = min(
            self.ignored_event_counts.get(key, 0) + 1, _MAX_DIAGNOSTIC_EVENT_COUNT
        )

    def record_undecodable_line(self) -> None:
        self.undecodable_line_count = min(
            self.undecodable_line_count + 1, _MAX_DIAGNOSTIC_EVENT_COUNT
        )

    def record_duplicate_function_call(self) -> None:
        self.duplicate_function_call_event_count = min(
            self.duplicate_function_call_event_count + 1, _MAX_DIAGNOSTIC_EVENT_COUNT
        )

    def record_delta(self, event: dict[str, Any]) -> None:
        self.output_text_delta_count += 1
        delta = event.get("delta")
        if isinstance(delta, str):
            self.output_text_delta_chars += len(delta)

    def record_done(self, event: dict[str, Any]) -> None:
        self.output_text_done_count += 1
        text = event.get("text")
        if not isinstance(text, str):
            return
        self.output_text_done_chars += len(text)
        fallback_index = len(self.finalized_text_parts)
        self.finalized_text_parts[
            (
                _event_index(event.get("output_index"), fallback_index),
                _event_index(event.get("content_index"), 0),
            )
        ] = text

    def resolve_text(self, content_parts: list[str]) -> tuple[str, str]:
        delta_content = "".join(content_parts)
        if delta_content.strip():
            return delta_content, "delta"
        finalized_content = _normalized_finalized_text(self.finalized_text_parts)
        if finalized_content.strip():
            return finalized_content, "output_text_done"
        return "", "none"

    def write_diagnostics(
        self,
        sink: dict[str, Any] | None,
        *,
        tool_call_count: int,
        terminal_event_type: str,
        terminal_text_source: str,
        finish_reason: str,
    ) -> None:
        if sink is None:
            return
        sink.clear()
        sink.update(
            {
                "output_text_delta_count": self.output_text_delta_count,
                "output_text_delta_chars": self.output_text_delta_chars,
                "output_text_done_count": self.output_text_done_count,
                "output_text_done_chars": self.output_text_done_chars,
                "tool_call_count": tool_call_count,
                # Emitted unconditionally so the diagnostics schema is uniform:
                # a missing key would be indistinguishable from "not tracked".
                "ignored_event_count": self.ignored_event_total,
                "undecodable_line_count": self.undecodable_line_count,
                "duplicate_function_call_event_count": (
                    self.duplicate_function_call_event_count
                ),
                "ignored_event_types": dict(self.ignored_event_counts),
                "terminal_event_type": terminal_event_type,
                "terminal_text_source": terminal_text_source,
                "finish_reason": finish_reason,
            }
        )


def raise_if_cancelled(cancel_handle: Any) -> None:
    _raise_if_cancelled_shared(
        cancel_handle,
        make_error=lambda: TerminalChatStateError(
            status=TURN_STATE_CANCELLED,
            message="ChatGPT request cancelled",
        ),
    )


def register_close_cancel_callback(cancel_handle: Any, target: Any) -> Any:
    def _close() -> None:
        target.close()

    return register_cancel_callback(cancel_handle, _close)


def iter_cancel_aware_sse_lines(response: Any, cancel_handle: Any) -> Iterable[str]:
    iter_raw = getattr(response, "iter_raw", None)
    if callable(iter_raw):
        chunks = iter_raw(chunk_size=_STREAM_READ_CHUNK_BYTES)
    else:
        chunks = (f"{line}\n".encode() for line in response.iter_lines())
    try:
        for raw_line in iter_bounded_byte_lines(
            chunks,
            max_line_bytes=_MAX_STREAM_LINE_BYTES,
            max_total_bytes=_MAX_STREAM_TOTAL_BYTES,
        ):
            raise_if_cancelled(cancel_handle)
            yield raw_line.decode("utf-8", errors="replace").rstrip("\r")
    finally:
        close = getattr(chunks, "close", None)
        if callable(close):
            close()
    raise_if_cancelled(cancel_handle)


def _decode_event_line(line: str) -> tuple[dict[str, Any] | None, bool]:
    """Decode one SSE line into ``(event, was_undecodable)``.

    Three distinct things produce no event and only one of them is
    diagnostic-worthy: a non-``data:`` framing line (``event: ping`` keepalives),
    the ``[DONE]``/blank terminator, and a body that is not a JSON object. Only
    the last is reported, so keepalives cannot inflate the undecodable counter.
    """
    if not line.startswith(_SSE_DATA_PREFIX):
        return None, False
    raw_data = line[len(_SSE_DATA_PREFIX) :].strip()
    if not raw_data or raw_data == "[DONE]":
        return None, False
    try:
        event = json.loads(raw_data)
    except json.JSONDecodeError:
        return None, True
    if isinstance(event, dict):
        return event, False
    return None, True


def _safe_error_code(value: Any) -> str:
    raw = non_empty_string(value)
    if not raw or len(raw) > _MAX_SAFE_ERROR_FIELD_CHARS:
        return "unknown_error"
    safe = all(character.isalnum() or character in "._-" for character in raw)
    return raw if safe else "unknown_error"


def _safe_reset_value(value: Any) -> str | float | int | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    if isinstance(value, str) and 0 < len(value) <= _MAX_SAFE_ERROR_FIELD_CHARS:
        safe = all(character.isalnum() or character in ".:+-_TZ" for character in value)
        return value if safe else None
    return None


def _read_initial_error_body(response: Any) -> dict[str, Any] | None:
    iter_raw = getattr(response, "iter_raw", None)
    if callable(iter_raw):
        content = bytearray()
        try:
            for chunk in iter_raw(chunk_size=_STREAM_READ_CHUNK_BYTES):
                if len(content) + len(chunk) > _MAX_ERROR_BODY_BYTES:
                    return None
                content.extend(chunk)
            parsed = json.loads(bytes(content))
        except (json.JSONDecodeError, RuntimeError, TypeError, UnicodeDecodeError, ValueError):
            return None
        return parsed if isinstance(parsed, dict) else None
    try:
        parsed = response.json()
    except (ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _safe_rate_limit_body(response: Any) -> dict[str, Any]:
    """Scrub a 429 body down to the only two fields allowed to leave it."""
    safe_body: dict[str, Any] = {}
    body = _read_initial_error_body(response)
    if isinstance(body, dict):
        error = body.get("error")
        error = error if isinstance(error, dict) else body
        reset_value = _safe_reset_value(error.get("resets_at"))
        if reset_value is not None:
            safe_body["resets_at"] = reset_value
        safe_body["code"] = _safe_error_code(error.get("code"))
    if "resets_at" not in safe_body:
        headers = getattr(response, "headers", {})
        header_reset = getattr(headers, "get", lambda *_args: None)(
            "x-codex-primary-reset-at",
            None,
        )
        reset_value = _safe_reset_value(header_reset)
        if reset_value is not None:
            safe_body["resets_at"] = reset_value
    return safe_body


def raise_for_initial_status(response: Any) -> None:
    """Map an initial HTTP status onto the SHARED provider retry policy.

    Hand-rolling a second status table is how 408/409/425 ended up terminal here
    while ``provider_http`` considered them retryable, so classification and
    retryability both delegate.

    ``classify_http_response_error`` is deliberately called with ``body=None``:
    it greps the raw provider message for phrases, and this engine only ever lets
    ``code`` and ``resets_at`` escape a 429 body. Handing it the unscrubbed body
    would route provider text -- potentially token-bearing -- through a decision
    path. With ``None`` the classification is a pure status-code table.
    """
    status_code = int(getattr(response, "status_code", 0) or 0)
    if status_code < _HTTP_BAD_REQUEST:
        return
    classification = classify_http_response_error(status_code, None)
    retryable = is_retryable_http_status(status_code)
    retry_after = parse_retry_after_seconds(response)
    if status_code == _HTTP_TOO_MANY_REQUESTS:
        raise ProviderHttpError(
            provider="chatgpt",
            status_code=_HTTP_TOO_MANY_REQUESTS,
            code=CMP_CLOUD_RATE_LIMITED,
            message="ChatGPT request was rate limited",
            retryable=retryable,
            classification=classification,
            body=_safe_rate_limit_body(response) or None,
            retry_after_seconds=retry_after,
        )
    raise ProviderHttpError(
        provider="chatgpt",
        status_code=status_code,
        code=CMP_CLOUD_HTTP_ERROR,
        message=(
            _TERMINAL_STATUS_MESSAGES.get(status_code)
            or f"ChatGPT request failed with status {status_code}"
        ),
        retryable=retryable,
        classification=classification,
        body=None,
        retry_after_seconds=retry_after,
    )


def _raise_stream_failure(event: dict[str, Any]) -> NoReturn:
    response = event.get("response")
    response = response if isinstance(response, dict) else {}
    error = response.get("error")
    error = error if isinstance(error, dict) else {}
    safe_code = _safe_error_code(error.get("code") or error.get("type"))
    if safe_code in _RATE_LIMIT_CODES:
        safe_body: dict[str, Any] = {"code": safe_code}
        reset_value = _safe_reset_value(error.get("resets_at"))
        if reset_value is not None:
            safe_body["resets_at"] = reset_value
        raise ProviderHttpError(
            provider="chatgpt",
            status_code=None,
            code=CMP_CLOUD_RATE_LIMITED,
            message=f"ChatGPT request failed: {safe_code}",
            retryable=safe_code == "rate_limit_exceeded",
            classification="rate_limit",
            body=safe_body,
        )
    if safe_code in _TRANSIENT_SERVER_CODES:
        raise ProviderHttpError(
            provider="chatgpt",
            status_code=None,
            code=CMP_CLOUD_HTTP_ERROR,
            message=f"ChatGPT request failed: {safe_code}",
            retryable=True,
            classification="server_error",
            body={"code": safe_code},
        )
    if safe_code == _CONTEXT_OVERFLOW_CODE:
        raise ProviderHttpError(
            provider="chatgpt",
            status_code=None,
            code=CMP_CLOUD_HTTP_ERROR,
            message=f"ChatGPT request failed: {safe_code}",
            retryable=True,
            classification="context_overflow",
            body={"code": safe_code},
        )
    raise GenerationError(f"ChatGPT generation failed: {safe_code}")


def _decode_call_arguments(raw: Any) -> tuple[dict[str, Any], bool]:
    # The Responses stream may deliver arguments already decoded; re-serializing
    # a dict through ``str()`` yields a Python repr that fails JSON parsing and
    # silently discards the model's real arguments.
    if isinstance(raw, dict):
        return raw, False
    try:
        arguments = json.loads(str(raw or "{}"))
    except json.JSONDecodeError:
        return {}, True
    if not isinstance(arguments, dict):
        return {}, True
    return arguments, False


def _parse_function_call(item: Any) -> ToolCallRequest | None:
    if not isinstance(item, dict) or item.get("type") != "function_call":
        return None
    name = non_empty_string(item.get("name"))
    call_id = non_empty_string(item.get("call_id"))
    if not name or not call_id:
        # Dropping the call silently produces a text-less turn that reads as a
        # model failure; record the shape (never the payload) so it is
        # diagnosable from the sidecar log.
        logger.warning(
            "chatgpt dropped a function_call item missing required identifiers",
            extra={
                "event": "ai.engines.chatgpt.function_call_dropped",
                "provider": "chatgpt",
                "item_type": "function_call",
                "has_name": bool(name),
                "has_call_id": bool(call_id),
            },
        )
        return None
    arguments, coerced = _decode_call_arguments(item.get("arguments"))
    return ToolCallRequest(
        tool_id=name,
        arguments=arguments,
        call_id=call_id,
        coerced=coerced,
    )


def _function_call_identity(tool_call: ToolCallRequest) -> Any:
    """Identity of a completed function_call: ``(call_id, name, args, coerced)``.

    The fingerprint is computed from the ALREADY-DECODED arguments so the two
    real wire shapes -- a JSON string and an equivalent dict -- compare equal,
    and ``sort_keys`` makes key order irrelevant. ``coerced`` is part of the
    identity so an unparseable-args call (``{}``, coerced) is never conflated
    with a genuinely empty-args call (``{}``, not coerced).
    """
    try:
        fingerprint = json.dumps(
            tool_call.arguments,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
    except (RecursionError, TypeError, ValueError):
        # Fail closed: an identity we cannot compute must never compare equal to
        # anything, so the repeat lands on the conflict path instead of being
        # waved through as a duplicate (or crashing the stream).
        return object()
    return (tool_call.call_id, tool_call.tool_id, fingerprint, tool_call.coerced)


def _raise_duplicate_function_call_conflict(previous: Any, current: Any) -> NoReturn:
    # GenerationError, not ProviderHttpError: this is retryable=False and not
    # fallback-eligible, so it lands as a terminal generation failure with no
    # tool dispatched. A retryable provider error would re-run the request
    # against a backend that is deterministically emitting the conflict.
    empty: tuple[Any, ...] = (None, None, None, None)
    previous_fields = previous if isinstance(previous, tuple) else empty
    current_fields = current if isinstance(current, tuple) else empty
    logger.warning(
        "chatgpt emitted a conflicting duplicate function_call item",
        extra={
            "event": "ai.engines.chatgpt.duplicate_function_call_conflict",
            "provider": "chatgpt",
            "name_differs": bool(previous_fields[1] != current_fields[1]),
            "arguments_differ": bool(previous_fields[2] != current_fields[2]),
            "coerced_differs": bool(previous_fields[3] != current_fields[3]),
        },
    )
    raise GenerationError("ChatGPT stream emitted a conflicting duplicate function_call")


class _FunctionCallDeduper:
    """Per-stream guard against executing one function_call twice.

    Scoped to a single response on purpose: ``call_id`` is only unique within one
    response, and a per-engine set would false-positive across turns because the
    same id legitimately reappears in the request replay.
    """

    def __init__(self, completion_shape: _CompletionShape) -> None:
        self._completion_shape = completion_shape
        self._seen: dict[str, Any] = {}

    def is_duplicate(self, tool_call: ToolCallRequest) -> bool:
        identity = _function_call_identity(tool_call)
        previous = self._seen.get(tool_call.call_id)
        if previous is None:
            if len(self._seen) < _MAX_TRACKED_CALL_IDS:
                self._seen[tool_call.call_id] = identity
            return False
        if previous == identity:
            self._completion_shape.record_duplicate_function_call()
            return True
        _raise_duplicate_function_call_conflict(previous, identity)


def _parse_usage(response: Any, *, model: str) -> GenerationUsage | None:
    if not isinstance(response, dict) or not isinstance(response.get("usage"), dict):
        return None
    usage = response["usage"]

    def _token_count(key: str) -> int:
        value = usage.get(key)
        return max(0, int(value)) if isinstance(value, (int, float)) else 0

    input_tokens = _token_count("input_tokens")
    output_tokens = _token_count("output_tokens")
    total_tokens = _token_count("total_tokens") or (input_tokens + output_tokens)
    return GenerationUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
        provider="chatgpt",
        model=model,
        last_request_input_tokens=input_tokens,
    )


def _incomplete_finish_reason(event: dict[str, Any]) -> str:
    response = event.get("response")
    details = response.get("incomplete_details") if isinstance(response, dict) else None
    reason = _safe_error_code(details.get("reason")) if isinstance(details, dict) else ""
    return "length" if reason == "max_output_tokens" else "stop"


def _reasoning_delta_events(
    event: dict[str, Any],
    thinking_parts: list[str],
    *,
    separator: str = "",
) -> tuple[StreamingEvent, ...]:
    delta = event.get("delta")
    if not isinstance(delta, str) or not delta:
        return ()
    text = separator + delta
    thinking_parts.append(text)
    return (StreamingEvent(kind="thinking", text=text),)


def _completed_output_item_events(
    event: dict[str, Any],
    *,
    tool_calls: list[ToolCallRequest],
    reasoning_sink: dict[str, dict[str, Any]] | None,
    pending_reasoning_item: dict[str, Any] | None,
    deduper: _FunctionCallDeduper,
) -> tuple[dict[str, Any] | None, tuple[ToolCallRequest, ...]]:
    item = event.get("item")
    if isinstance(item, dict) and item.get("type") == "reasoning":
        return item, ()
    tool_call = _parse_function_call(item)
    if tool_call is None:
        return pending_reasoning_item, ()
    if deduper.is_duplicate(tool_call):
        # First occurrence wins in every respect. The reasoning mapping is NOT
        # overwritten (a duplicate would otherwise re-point the call_id at
        # whatever item happened to be pending, possibly another call's), and
        # pending_reasoning_item is passed through untouched so an item that
        # arrived before the duplicate can still attach to the next genuine
        # call instead of being silently consumed.
        return pending_reasoning_item, ()
    tool_calls.append(tool_call)
    if reasoning_sink is not None and pending_reasoning_item is not None:
        reasoning_sink[tool_call.call_id] = pending_reasoning_item
    return None, (tool_call,)


def _iter_decoded_events(
    response: Any,
    cancel_handle: Any,
    completion_shape: _CompletionShape,
) -> Generator[dict[str, Any], None, None]:
    for line in iter_cancel_aware_sse_lines(response, cancel_handle):
        event, undecodable = _decode_event_line(line)
        if event is None:
            if undecodable:
                completion_shape.record_undecodable_line()
            continue
        yield event


def stream_response_events(
    response: Any,
    *,
    model: str,
    cancel_handle: Any,
    reasoning_sink: dict[str, dict[str, Any]] | None = None,
    completion_diagnostics_sink: dict[str, Any] | None = None,
) -> Generator[StreamChunk, None, GenerationResult]:
    content_parts: list[str] = []
    thinking_parts: list[str] = []
    tool_calls: list[ToolCallRequest] = []
    completion_shape = _CompletionShape()
    deduper = _FunctionCallDeduper(completion_shape)
    pending_reasoning_item: dict[str, Any] | None = None
    citation_normalizer = _CitationNormalizer()
    emitted_summary_text: bool = False
    pending_summary_break: bool = False

    def _finish(finish_reason: str, event: dict[str, Any]) -> GenerationResult:
        content, terminal_text_source = completion_shape.resolve_text(content_parts)
        resolved_finish_reason = "tool_calls" if tool_calls else finish_reason
        completion_shape.write_diagnostics(
            completion_diagnostics_sink,
            tool_call_count=len(tool_calls),
            terminal_event_type=str(event.get("type") or ""),
            terminal_text_source=terminal_text_source,
            finish_reason=resolved_finish_reason,
        )
        return GenerationResult(
            content=content,
            thinking_text="".join(thinking_parts),
            tool_calls=tuple(tool_calls),
            finish_reason=resolved_finish_reason,
            usage=_parse_usage(event.get("response"), model=model),
        )

    for event in _iter_decoded_events(response, cancel_handle, completion_shape):
        event_type = event.get("type")
        if event_type == "response.output_text.delta":
            completion_shape.record_delta(event)
            yield from _normalized_output_text_events(
                event,
                citation_normalizer,
                content_parts,
            )
            continue
        if event_type == "response.output_text.done":
            completion_shape.record_done(event)
            continue
        if event_type == "response.reasoning_summary_part.added":
            pending_summary_break = emitted_summary_text
            continue
        if event_type == "response.reasoning_summary_text.delta":
            delta = event.get("delta")
            if isinstance(delta, str) and delta:
                if delta.strip():
                    separator = (
                        _REASONING_SUMMARY_PART_SEPARATOR if pending_summary_break else ""
                    )
                    pending_summary_break = False
                    emitted_summary_text = True
                    yield from _reasoning_delta_events(
                        event,
                        thinking_parts,
                        separator=separator,
                    )
                else:
                    # Whitespace-only delta: emit without consuming the pending
                    # part break — the router drops whitespace-only thinking
                    # deltas, so a separator prefixed here would vanish from the
                    # wire while surviving in the aggregate.
                    yield from _reasoning_delta_events(event, thinking_parts)
            continue
        if event_type == "response.reasoning_text.delta":
            yield from _reasoning_delta_events(event, thinking_parts)
            continue
        if event_type == "response.reasoning_summary_part.done":
            # The done marker carries nothing the adapter needs.
            completion_shape.record_ignored_event(event_type)
            continue
        if event_type == "response.output_item.done":
            # Reasoning items are held until the next function call so
            # store:false tool loops can replay them on the follow-up request.
            pending_reasoning_item, output_events = _completed_output_item_events(
                event,
                tool_calls=tool_calls,
                reasoning_sink=reasoning_sink,
                pending_reasoning_item=pending_reasoning_item,
                deduper=deduper,
            )
            yield from output_events
            continue
        if event_type == "response.failed":
            _raise_stream_failure(event)
        if event_type == "response.incomplete":
            citation_normalizer.finish()
            return _finish(_incomplete_finish_reason(event), event)
        if event_type == "response.completed":
            citation_normalizer.finish()
            return _finish("stop", event)
        # Default branch: an unrecognized event type is dropped for behavior but
        # counted for diagnostics, so a provider-side schema change is visible
        # instead of silently degrading the turn. Type string and counts only.
        completion_shape.record_ignored_event(event_type)
    raise GenerationError("ChatGPT stream ended before completion")


__all__ = [
    "build_responses_payload",
    "raise_for_initial_status",
    "raise_if_cancelled",
    "register_close_cancel_callback",
    "stream_response_events",
]
