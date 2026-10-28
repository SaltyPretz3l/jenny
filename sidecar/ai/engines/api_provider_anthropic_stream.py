"""Anthropic Messages SSE transport and event folding (row 78, P3a).

``run_messages_stream`` owns the HTTP exchange (initial status, cancel, bounded SSE
lines, failure mapping); ``MessageFolder`` folds the closed event vocabulary into the
engine's stream chunks and one terminal ``GenerationResult``. Provider error text is
never echoed: an in-band error surfaces only its charset-gated type.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Generator, Iterator
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from typing import Any

from sidecar.ai.engines.api_provider_http import raise_for_provider_status
from sidecar.ai.engines.http_utils import raise_if_cancelled as _raise_if_cancelled
from sidecar.ai.engines.http_utils import register_cancel_callback
from sidecar.ai.engines.provider_http import ProviderHttpError, ProviderHttpService
from sidecar.ai.error_codes import (
    CMP_CLOUD_HTTP_ERROR,
    CMP_CLOUD_NETWORK_ERROR,
    CMP_CLOUD_RATE_LIMITED,
)
from sidecar.ai.exceptions import GenerationError
from sidecar.ai.tools.models import (
    STREAMING_EVENT_KIND_TOOL_ARGUMENTS_PROGRESS,
    GenerationResult,
    GenerationUsage,
    StreamChunk,
    StreamingEvent,
    ToolCallRequest,
)
from sidecar.runtime.bounded_io import iter_bounded_byte_lines
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.turn_state import TURN_STATE_CANCELLED

PROVIDER_LABEL = "api-provider"
_SSE_DATA_PREFIX = "data:"
_SSE_EVENT_PREFIX = "event:"
_MAX_STREAM_LINE_BYTES = 1024 * 1024
_MAX_STREAM_TOTAL_BYTES = 32 * 1024 * 1024
_MAX_SAFE_ERROR_FIELD_CHARS = 64
_DECLINED_MESSAGE = "the provider declined this request"
_USAGE_KEYS = (
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "output_tokens",
)
# In-band error type -> (retryable, classification, error code).
_ERROR_TYPES = {
    "overloaded_error": (True, "server_overload", CMP_CLOUD_HTTP_ERROR),
    "api_error": (True, "server_error", CMP_CLOUD_HTTP_ERROR),
    "timeout_error": (True, "api_timeout", CMP_CLOUD_HTTP_ERROR),
    "rate_limit_error": (True, "rate_limit", CMP_CLOUD_RATE_LIMITED),
    "authentication_error": (False, "invalid_api_key", CMP_CLOUD_HTTP_ERROR),
    "permission_error": (False, "client_error", CMP_CLOUD_HTTP_ERROR),
    "billing_error": (False, "credit_balance_low", CMP_CLOUD_HTTP_ERROR),
}


def check_cancelled(cancel_handle: Any) -> None:
    _raise_if_cancelled(
        cancel_handle,
        make_error=lambda: TerminalChatStateError(
            status=TURN_STATE_CANCELLED, message="Request cancelled"
        ),
    )


class AnthropicHttpService(ProviderHttpService):
    """The pooled provider client plus per-request headers (the thinking beta)."""

    def stream_response(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        timeout: float | None = None,
        headers: dict[str, str] | None = None,
    ) -> AbstractContextManager[Any]:
        return self._client.stream(
            method, path, json=json, headers=headers or None, timeout=timeout
        )


# -- folding -----------------------------------------------------------------------


def _safe_error_type(value: Any) -> str:
    raw = value.strip() if isinstance(value, str) else ""
    if not raw or len(raw) > _MAX_SAFE_ERROR_FIELD_CHARS:
        return "unknown_error"
    return raw if all(ch.isalnum() or ch in "._-" for ch in raw) else "unknown_error"


def _stream_error(error: Any) -> ProviderHttpError:
    error_type = _safe_error_type(error.get("type") if isinstance(error, dict) else None)
    retryable, classification, code = _ERROR_TYPES.get(
        error_type, (False, "client_error", CMP_CLOUD_HTTP_ERROR)
    )
    return ProviderHttpError(
        provider=PROVIDER_LABEL,
        status_code=None,
        code=code,
        message=f"provider request failed: {error_type}",
        retryable=retryable,
        classification=classification,
        body={"code": error_type},
    )


@dataclass
class _Block:
    kind: str
    parts: list[str] = field(default_factory=list)
    signature: str = ""
    call_id: str = ""
    name: str = ""
    data: str = ""
    closed: bool = False


@dataclass(frozen=True)
class FoldOutcome:
    result: GenerationResult
    # Completed signed thinking blocks of this response, in wire order.
    replay_blocks: tuple[dict[str, Any], ...] = ()


def _count(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return max(0, int(value))


class MessageFolder:
    """Fold Anthropic SSE event dicts into stream chunks and one terminal result."""

    def __init__(self, *, model: str, emit_thinking: bool) -> None:
        self._model = model
        self._emit_thinking = emit_thinking
        self._blocks: dict[int, _Block] = {}
        self._content: list[str] = []
        self._thinking: list[str] = []
        self._tool_calls: list[ToolCallRequest] = []
        self._replay: list[dict[str, Any]] = []
        self._usage: dict[str, int] = {}
        self._stop_reason = ""
        self.stopped = False
        self._handlers: dict[str, Callable[[dict[str, Any]], tuple[StreamChunk, ...]]] = {
            "message_start": self._on_message_start,
            "content_block_start": self._on_block_start,
            "content_block_delta": self._on_block_delta,
            "content_block_stop": self._on_block_stop,
            "message_delta": self._on_message_delta,
            "message_stop": self._on_message_stop,
        }

    def feed(self, event: dict[str, Any]) -> tuple[StreamChunk, ...]:
        event_type = event.get("type")
        if event_type == "error":
            raise _stream_error(event.get("error"))
        handler = self._handlers.get(event_type) if isinstance(event_type, str) else None
        return handler(event) if handler is not None else ()

    # -- handlers

    def _absorb_usage(self, usage: Any) -> None:
        if not isinstance(usage, dict):
            return
        for key in _USAGE_KEYS:
            value = _count(usage.get(key))
            if value is not None:
                self._usage[key] = value

    def _on_message_start(self, event: dict[str, Any]) -> tuple[StreamChunk, ...]:
        message = event.get("message")
        self._absorb_usage(message.get("usage") if isinstance(message, dict) else None)
        return ()

    def _on_block_start(self, event: dict[str, Any]) -> tuple[StreamChunk, ...]:
        index = event.get("index")
        block = event.get("content_block")
        if not isinstance(index, int) or not isinstance(block, dict):
            return ()
        kind = str(block.get("type") or "")
        state = _Block(kind=kind)
        if kind == "tool_use":
            state.call_id = str(block.get("id") or "")
            state.name = str(block.get("name") or "")
        elif kind == "redacted_thinking":
            state.data = str(block.get("data") or "")
        self._blocks[index] = state
        initial = block.get("text") if kind == "text" else block.get("thinking")
        if kind in {"text", "thinking"} and isinstance(initial, str) and initial:
            return self._text_chunks(state, kind, initial)
        return ()

    def _text_chunks(self, state: _Block, kind: str, text: str) -> tuple[StreamChunk, ...]:
        state.parts.append(text)
        if kind == "text":
            self._content.append(text)
            return (StreamingEvent(kind="content", text=text),)
        if not self._emit_thinking:
            return ()
        self._thinking.append(text)
        return (StreamingEvent(kind="thinking", text=text),)

    def _on_block_delta(self, event: dict[str, Any]) -> tuple[StreamChunk, ...]:
        index = event.get("index")
        state = self._blocks.get(index) if isinstance(index, int) else None
        delta = event.get("delta")
        if state is None or not isinstance(delta, dict):
            return ()
        delta_type = delta.get("type")
        if delta_type == "text_delta" and isinstance(delta.get("text"), str):
            text = delta["text"]
            return self._text_chunks(state, "text", text) if text else ()
        if delta_type == "thinking_delta" and isinstance(delta.get("thinking"), str):
            text = delta["thinking"]
            return self._text_chunks(state, "thinking", text) if text else ()
        if delta_type == "signature_delta" and isinstance(delta.get("signature"), str):
            state.signature += delta["signature"]
        elif delta_type == "input_json_delta" and isinstance(delta.get("partial_json"), str):
            state.parts.append(delta["partial_json"])
            # Text-free liveness: a large call streams arguments for a long while.
            return (StreamingEvent(kind=STREAMING_EVENT_KIND_TOOL_ARGUMENTS_PROGRESS),)
        return ()

    def _on_block_stop(self, event: dict[str, Any]) -> tuple[StreamChunk, ...]:
        index = event.get("index")
        state = self._blocks.get(index) if isinstance(index, int) else None
        if state is None or state.closed:
            return ()
        state.closed = True
        if state.kind == "thinking" and state.signature:
            self._replay.append(
                {"type": "thinking", "thinking": "".join(state.parts), "signature": state.signature}
            )
        elif state.kind == "redacted_thinking" and state.data:
            self._replay.append({"type": "redacted_thinking", "data": state.data})
        elif state.kind == "tool_use" and state.call_id and state.name:
            call = self._tool_call(state)
            self._tool_calls.append(call)
            return (call,)
        return ()

    @staticmethod
    def _tool_call(state: _Block) -> ToolCallRequest:
        raw = "".join(state.parts).strip()
        try:
            arguments = json.loads(raw) if raw else {}
        except ValueError:
            arguments = None
        if not isinstance(arguments, dict):
            return ToolCallRequest(
                tool_id=state.name,
                arguments={},
                call_id=state.call_id,
                coerced=True,
                malformed_arguments=True,
            )
        return ToolCallRequest(tool_id=state.name, arguments=arguments, call_id=state.call_id)

    def _on_message_delta(self, event: dict[str, Any]) -> tuple[StreamChunk, ...]:
        delta = event.get("delta")
        if isinstance(delta, dict) and isinstance(delta.get("stop_reason"), str):
            self._stop_reason = delta["stop_reason"]
        self._absorb_usage(event.get("usage"))
        return ()

    def _on_message_stop(self, _event: dict[str, Any]) -> tuple[StreamChunk, ...]:
        self.stopped = True
        return ()

    # -- terminal

    def _finish_reason(self) -> str:
        if not self.stopped or self._stop_reason == "pause_turn":
            return "incomplete"
        if self._stop_reason == "max_tokens":
            return "length"
        return "tool_calls" if self._tool_calls else "stop"

    def _result_usage(self) -> GenerationUsage | None:
        if not self._usage:
            return None
        usage = self._usage
        prompt = (
            usage.get("input_tokens", 0)
            + usage.get("cache_creation_input_tokens", 0)
            + usage.get("cache_read_input_tokens", 0)
        )
        output = usage.get("output_tokens", 0)
        return GenerationUsage(
            input_tokens=prompt,
            output_tokens=output,
            total_tokens=prompt + output,
            provider=PROVIDER_LABEL,
            model=self._model,
            raw_usage=dict(usage),
            last_request_input_tokens=prompt,
        )

    def outcome(self) -> FoldOutcome:
        if self._stop_reason == "refusal":
            raise ProviderHttpError(
                provider=PROVIDER_LABEL,
                status_code=None,
                code=CMP_CLOUD_HTTP_ERROR,
                message=_DECLINED_MESSAGE,
                retryable=False,
                classification="refusal",
            )
        finish = self._finish_reason()
        # A tool call cut off at the output limit is never executable.
        cut_off = any(b.kind == "tool_use" and not b.closed for b in self._blocks.values())
        result = GenerationResult(
            content="".join(self._content).strip(),
            tool_calls=tuple(self._tool_calls),
            finish_reason=finish,
            usage=self._result_usage(),
            thinking_text="".join(self._thinking).strip(),
            tool_call_truncated=cut_off and finish == "length",
        )
        replay = tuple(self._replay) if finish == "tool_calls" else ()
        return FoldOutcome(result=result, replay_blocks=replay)


# -- transport ---------------------------------------------------------------------


def _iter_events(
    response: Any, cancel_handle: Any, on_first_chunk: Callable[[], None] | None
) -> Iterator[dict[str, Any]]:
    iter_raw = getattr(response, "iter_raw", None)
    chunks = (
        iter_raw(chunk_size=None)
        if callable(iter_raw)
        else (f"{line}\n".encode() for line in response.iter_lines())
    )
    first = True
    pending_name = ""
    try:
        for raw in iter_bounded_byte_lines(
            chunks,
            max_line_bytes=_MAX_STREAM_LINE_BYTES,
            max_total_bytes=_MAX_STREAM_TOTAL_BYTES,
        ):
            check_cancelled(cancel_handle)
            if first:
                first = False
                if on_first_chunk is not None:
                    on_first_chunk()
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            if line.startswith(_SSE_EVENT_PREFIX):
                pending_name = line[len(_SSE_EVENT_PREFIX) :].strip()
            elif line.startswith(_SSE_DATA_PREFIX):
                event = _decode_event(line[len(_SSE_DATA_PREFIX) :], pending_name)
                pending_name = ""
                if event is not None:
                    yield event
    finally:
        close = getattr(chunks, "close", None)
        if callable(close):
            close()
    check_cancelled(cancel_handle)


def _decode_event(raw: str, event_name: str) -> dict[str, Any] | None:
    try:
        event = json.loads(raw.strip())
    except ValueError:
        return None
    if not isinstance(event, dict):
        return None
    if event_name:
        event.setdefault("type", event_name)
    return event


def run_messages_stream(  # noqa: PLR0913 - transport and diagnostic callback contract.
    service: AnthropicHttpService,
    *,
    payload: dict[str, Any],
    headers: dict[str, str],
    timeout: float,
    label: str,
    model: str,
    emit_thinking: bool,
    cancel_handle: Any,
    on_first_chunk: Callable[[], None] | None = None,
) -> Generator[StreamChunk, None, FoldOutcome]:
    """POST ``/messages`` and fold the SSE reply; typed errors, never the provider body."""
    import httpx  # Lazy: keeps httpx off the sidecar startup graph.

    check_cancelled(cancel_handle)
    try:
        with service.stream_response(
            "POST", "/messages", json=payload, timeout=timeout, headers=headers
        ) as response:
            unregister = register_cancel_callback(cancel_handle, response.close)
            try:
                check_cancelled(cancel_handle)
                raise_for_provider_status(response, label=label)
                folder = MessageFolder(model=model, emit_thinking=emit_thinking)
                for event in _iter_events(response, cancel_handle, on_first_chunk):
                    yield from folder.feed(event)
                    if folder.stopped:
                        break
                return folder.outcome()
            finally:
                unregister()
    except (TerminalChatStateError, ProviderHttpError, GenerationError):
        raise
    except (httpx.TimeoutException, httpx.TransportError) as error:
        check_cancelled(cancel_handle)
        raise ProviderHttpError(
            provider=PROVIDER_LABEL,
            status_code=None,
            code=CMP_CLOUD_NETWORK_ERROR,
            message=f"{label} transport failed: {type(error).__name__}",
            retryable=True,
            classification=(
                "api_timeout" if isinstance(error, httpx.TimeoutException) else "connection_error"
            ),
        ) from error
    except Exception as error:
        check_cancelled(cancel_handle)
        raise GenerationError(f"{label} streaming failed: {type(error).__name__}") from error


__all__ = [
    "PROVIDER_LABEL",
    "AnthropicHttpService",
    "FoldOutcome",
    "MessageFolder",
    "check_cancelled",
    "run_messages_stream",
]
