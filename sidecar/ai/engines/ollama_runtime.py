"""Ollama request/stream runtime helpers."""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from http import HTTPStatus
from typing import Any

from sidecar.ai.engines.base import clamp_timeout_to_deadline
from sidecar.ai.engines.ollama_stream_thinking import (
    _emit_thinking,
    _note_malformed_stream_line,
    _thinking_delta,
    _thinking_stop_reason,  # noqa: F401 - compatibility re-export
    _thinking_suppressed,
)
from sidecar.ai.engines.ollama_stream_transport import (
    iter_bounded_response_lines as _iter_bounded_response_lines,  # noqa: F401
)
from sidecar.ai.engines.ollama_stream_transport import (
    iter_cancel_aware_response_lines,
    raise_if_cancelled,
)
from sidecar.ai.engines.ollama_stream_transport import (
    register_response_cancel_callback as _register_response_cancel_callback,  # noqa: F401
)
from sidecar.ai.engines.ollama_telemetry import (
    build_usage_from_done_chunk,
    current_time_to_first_token_ms,
    log_ollama_stream_terminal_gap,
    ollama_stream_inband_error,
    resolve_ollama_stream_finish_reason,
)
from sidecar.ai.engines.ollama_telemetry import (
    ollama_thinking_enabled as _ollama_thinking_enabled,
)
from sidecar.ai.engines.ollama_telemetry import (
    record_ollama_chat_request as _record_chat_request,
)
from sidecar.ai.engines.ollama_tool_call_announce import build_tool_call_announcement
from sidecar.ai.routing.provider_stream_normalizer import (
    FINISH_REASON_PROVIDER_ERROR,
    FINISH_REASON_THINKING_BUDGET,
    ProviderStreamNormalizer,
    record_counters_to_diagnostics,
)
from sidecar.ai.thinking_guard import (
    budget_trip_check,
    resolve_thinking_budget_chars,
    thinking_budget_abort_enabled,
)
from sidecar.ai.tools.models import ensure_tool_call_id
from sidecar.ai.tools.tool_call_healing import (
    coerce_arguments,
    is_healing_enabled,
    record_repair,
)
from sidecar.runtime.local_engine.reasoning import (
    sanitize_visible_text,
)
from sidecar.runtime.ollama_support import (
    EngineConnectionError,
    GenerationError,
    GenerationResult,
    ModelNotLoadedError,
    ResponseFormat,
    StreamingEvent,
    ThinkingRepetitionGuard,
    ToolCallRequest,
    extract_inband_tool_calls_detailed,
)

logger = logging.getLogger(__name__)
_ABORT_EVENT = "ai.engines.ollama.thinking_budget_abort"


def _resolve_stream_terminal(
    engine: Any,
    *,
    thinking_budget_aborted: bool,
    saw_terminal: bool,
    terminal_done_reason: str,
    inband_error: str,
    has_tool_calls: bool,
) -> str:
    if thinking_budget_aborted:
        finish_reason = FINISH_REASON_THINKING_BUDGET
        logger.info(
            "Thinking budget aborted.",
            extra={"event": _ABORT_EVENT, "model": engine.model_name, "reason": "char_limit"},
        )
        return finish_reason
    finish_reason = resolve_ollama_stream_finish_reason(
        saw_terminal=saw_terminal,
        done_reason=terminal_done_reason,
        has_tool_calls=has_tool_calls,
    )
    log_ollama_stream_terminal_gap(
        engine,
        finish_reason=finish_reason,
        inband_error=inband_error,
    )
    return finish_reason


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _tool_call_arguments(raw: Any) -> dict[str, Any]:
    """Resolve a native tool-call's ``arguments`` field to a ``dict``."""
    return _tool_call_arguments_with_repairs(raw)[0]


def _tool_call_arguments_with_repairs(
    raw: Any,
) -> tuple[dict[str, Any], tuple[str, ...]]:
    """Resolve native arguments and return the healing tags used.

    Flag OFF: exactly ``_as_dict(raw)`` — a string-typed ``arguments`` value
    drops to ``{}`` (today's shipped behavior, pinned as a contract). Flag ON:
    ``coerce_arguments`` handles dict passthrough, string-JSON parsing, and
    conservative healing; only its dict result is used, else fall back to
    ``_as_dict(raw)``.
    """
    if not is_healing_enabled():
        return _as_dict(raw), ()
    coerced = coerce_arguments(raw)
    if coerced is not None:
        arguments, repair_tags = coerced
        record_repair(repair_tags)
        return arguments, repair_tags
    return _as_dict(raw), ()


def _native_tool_call_request(
    tc: dict[str, Any], position: int, request_id: str | None
) -> ToolCallRequest:
    function = _as_dict(tc.get("function"))
    tool_name = str(function.get("name", ""))
    arguments, argument_repairs = _tool_call_arguments_with_repairs(
        function.get("arguments")
    )
    return ToolCallRequest(
        tool_id=tool_name,
        arguments=arguments,
        call_id=ensure_tool_call_id(
            tc.get("id"),
            provider="ollama",
            tool_name=tool_name,
            request_id=request_id,
            position=position,
        ),
        argument_repairs=argument_repairs,
    )


def _format_field_value(
    response_format: ResponseFormat | None,
    tools_payload: list[Any] | None = None,
) -> str | dict[str, Any]:
    """Resolve the ``format`` field value for an Ollama ``/api/chat`` payload.

    ``response_format.json_schema`` (Ollama >=0.5 structured output) is passed
    through as-is so the server can compile it into a grammar. But a non-empty
    ``tools_payload`` in the same request keeps ``"json"`` — Ollama's behavior
    for tools + schema-dict ``format`` together is undefined, so a request must
    never carry both a non-empty ``tools`` payload and a schema-dict ``format``.
    Callers with no tools payload of their own may omit ``tools_payload``.
    """
    if tools_payload:
        return "json"
    if response_format is not None:
        schema = getattr(response_format, "json_schema", None)
        if schema:
            return schema
    return "json"


def _is_retryable_transport_error(error: BaseException) -> bool:
    if isinstance(error, (BrokenPipeError, ConnectionAbortedError, ConnectionResetError)):
        return True
    if isinstance(error, OSError):
        error_number = getattr(error, "winerror", None) or getattr(error, "errno", None)
        if error_number in {54, 104, 10053, 10054}:
            return True
    text = str(error).lower()
    return (
        "connection reset" in text
        or "forcibly closed" in text
        or "remote end closed connection" in text
        or "connection aborted" in text
    )


def _raise_stream_transport_error(engine: Any, error: BaseException) -> None:
    raise EngineConnectionError(
        f"Connection to Ollama at {engine.host} was interrupted during streaming: {error}",
        retryable=True,
    ) from error


def _raise_reasoning_effort_rejection(
    error: urllib.error.URLError,
    data: dict[str, Any],
) -> None:
    think_value = data.get("think")
    if (
        isinstance(error, urllib.error.HTTPError)
        and error.code == HTTPStatus.BAD_REQUEST
        and isinstance(think_value, str)
        and "tools" not in data
    ):
        raise GenerationError(
            "Ollama rejected the requested reasoning effort. Update Ollama to a version "
            "that supports string-valued think levels for this model."
        ) from error


def _build_chat_request(
    engine: Any,
    *,
    msgs: list[Any],
    max_tokens: int,
    temperature: float,
    reasoning_effort: str | None,
    stream: bool,
    tools: list[dict[str, Any]] | None = None,
    response_format: ResponseFormat | None = None,
) -> dict[str, Any]:
    think_value = engine._build_think_value(reasoning_effort)
    think_enabled = _ollama_thinking_enabled(think_value)
    sampler_builder = getattr(engine, "_effective_sampler", None)
    sampler = (
        sampler_builder(temperature, thinking=think_enabled)
        if callable(sampler_builder)
        else {
            "temperature": engine._effective_temperature(temperature),
            "top_k": engine._effective_top_k(),
            "top_p": engine._effective_top_p(),
            "min_p": engine._effective_min_p(),
            "presence_penalty": None,
            "repeat_penalty": engine._effective_repeat_penalty(),
        }
    )
    effective_temperature = float(sampler["temperature"])
    data: dict[str, Any] = {
        "model": engine.model_name,
        "messages": msgs,
        "stream": stream,
    }
    tools_payload = None
    if tools is not None:
        tools_payload = engine._build_tools_payload_cached(tools)
        data["tools"] = tools_payload
    data["options"] = engine._build_options(
        max_tokens,
        effective_temperature,
        thinking=think_enabled,
        top_k=sampler.get("top_k"),
        top_p=sampler.get("top_p"),
        min_p=sampler.get("min_p"),
        presence_penalty=sampler.get("presence_penalty"),
        repeat_penalty=sampler.get("repeat_penalty"),
        # Stub engines in tests lack the estimator; they get no remaining-context cap.
        prompt_tokens_estimate=getattr(
            engine, "_estimate_request_prompt_tokens", lambda _data: None
        )(data),
    )
    if think_value is not None:
        data["think"] = think_value
    if response_format and response_format.is_json:
        data["format"] = _format_field_value(response_format, tools_payload)
    return data


def sanitize_output(text: str) -> str:
    if not text:
        return ""
    lower = text.lower()
    closing = "</think>"
    if closing in lower:
        idx = lower.rfind(closing)
        tail = text[idx + len(closing) :]
        if tail.strip():
            text = tail
    else:
        # Strip bare "thought " prefix — model emitted reasoning without markers
        stripped = text.lstrip()
        slower = stripped.lower()
        if slower.startswith("thought ") or slower.startswith("thought\n"):
            para_break = stripped.find("\n\n")
            if para_break != -1:
                tail = stripped[para_break:].strip()
                if tail:
                    text = tail
    return sanitize_visible_text(text)


def _extract_content_and_thinking(
    engine: Any,
    message: dict[str, Any],
) -> tuple[str, str]:
    raw_content = str(message.get("content") or "")
    content = sanitize_output(raw_content).strip()
    thinking = engine._sanitize_thinking(str(message.get("thinking") or "")).strip()
    if not thinking:
        extracted = engine._extract_request_reasoning(
            raw_content,
            parser_mode="content_fallback",
        )
        if extracted is not None:
            content = sanitize_output(extracted.visible_text).strip()
            thinking = engine._sanitize_thinking(extracted.reasoning_text).strip()
    return content, thinking


def generate(
    engine: Any,
    *,
    prompt: str,
    max_tokens: int = 16384,
    temperature: float = 0.7,
    reasoning_effort: str | None = None,
    prompt_cache_enabled: bool = False,
    system: str = "",
    messages: list[Any] | None = None,
    response_format: ResponseFormat | None = None,
    request_timeout_seconds: float | None = None,
) -> str:
    _ = prompt_cache_enabled
    engine._assert_ready()
    msgs = engine._build_messages(prompt, system, messages)
    data = _build_chat_request(
        engine,
        msgs=msgs,
        max_tokens=max_tokens,
        temperature=temperature,
        reasoning_effort=reasoning_effort,
        stream=False,
        response_format=response_format,
    )
    _record_chat_request(engine, data, msgs, max_tokens)

    try:
        response = (
            engine._post("/api/chat", data)
            if request_timeout_seconds is None
            else engine._post(
                "/api/chat",
                data,
                timeout=request_timeout_seconds,
            )
        )
        message = _as_dict(response.get("message"))
        content, _ = _extract_content_and_thinking(engine, message)
        engine._record_first_chunk()
        if content:
            engine._record_visible_output(content)
        engine._complete_provider_request()
        return content
    except urllib.error.URLError as error:
        engine._complete_provider_request()
        _raise_reasoning_effort_rejection(error, data)
        if engine._is_timeout_url_error(error):
            raise GenerationError(engine._timeout_message("Generation")) from error
        raise EngineConnectionError(engine._describe_url_error(error, "generation")) from error
    except (EngineConnectionError, ModelNotLoadedError):
        engine._complete_provider_request()
        raise
    except Exception as error:  # noqa: BLE001
        engine._complete_provider_request()
        if engine._is_timeout_error(error):
            raise GenerationError(engine._timeout_message("Generation")) from error
        raise GenerationError(f"Generation failed: {error}") from error


def stream(
    engine: Any,
    *,
    prompt: str,
    max_tokens: int = 16384,
    temperature: float = 0.7,
    reasoning_effort: str | None = None,
    prompt_cache_enabled: bool = False,
    system: str = "",
    messages: list[Any] | None = None,
    response_format: ResponseFormat | None = None,
    cancel_handle: Any = None,
    wall_clock_deadline: float | None = None,
):
    _ = prompt_cache_enabled
    engine._assert_ready()
    msgs = engine._build_messages(prompt, system, messages)
    data = _build_chat_request(
        engine,
        msgs=msgs,
        max_tokens=max_tokens,
        temperature=temperature,
        reasoning_effort=reasoning_effort,
        stream=True,
        response_format=response_format,
    )
    _record_chat_request(engine, data, msgs, max_tokens)
    think_value = data.get("think")

    try:
        reasoning_parser = engine._create_request_reasoning_parser()
        thinking_guard = (
            ThinkingRepetitionGuard(
                max_chars=resolve_thinking_budget_chars(engine, max_tokens)
            )
            if _ollama_thinking_enabled(think_value) or reasoning_parser is not None
            else None
        )
        budget_tripped = budget_trip_check(thinking_guard)
        thinking_suppression_state = [False]
        native_thinking_seen = False
        thinking_accumulated = ""
        malformed_line_count = 0
        first_chunk_logged = False
        done_usage = None
        # Track whether the provider emitted explicit terminal evidence.
        thinking_budget_aborted = False
        saw_terminal = False
        terminal_done_reason = ""
        inband_error = ""
        url = f"{engine.host}/api/chat"
        req = urllib.request.Request(
            url,
            data=json.dumps(data).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        raise_if_cancelled(cancel_handle)
        request_timeout = clamp_timeout_to_deadline(
            engine._request_timeout_seconds,
            wall_clock_deadline,
        )
        with urllib.request.urlopen(req, timeout=request_timeout) as response:
            for line in iter_cancel_aware_response_lines(response, cancel_handle):
                if not line:
                    continue
                if not first_chunk_logged:
                    engine._record_first_chunk()
                    first_chunk_logged = True
                try:
                    chunk = json.loads(line)
                except json.JSONDecodeError:
                    malformed_line_count = _note_malformed_stream_line(
                        engine, malformed_line_count, line
                    )
                    continue
                inband_error = ollama_stream_inband_error(chunk)
                if inband_error:
                    # An in-band error frame IS terminal evidence -- just not
                    # of success. Stop reading and classify it as such.
                    saw_terminal = True
                    terminal_done_reason = FINISH_REASON_PROVIDER_ERROR
                    break
                message = _as_dict(chunk.get("message"))
                thinking = engine._sanitize_thinking(str(message.get("thinking") or ""))
                if thinking:
                    native_thinking_seen = True
                    new_tail, thinking_accumulated = _thinking_delta(thinking_accumulated, thinking)
                    if new_tail:
                        yield from _emit_thinking(
                            engine,
                            thinking_guard,
                            new_tail,
                            suppression_state=thinking_suppression_state,
                        )
                content = str(message.get("content") or "")
                if content:
                    visible_text = sanitize_output(content)
                    reasoning_text = ""
                    if reasoning_parser is not None and not native_thinking_seen:
                        parsed_reasoning, parsed_visible = reasoning_parser.feed(content)
                        reasoning_text = engine._sanitize_thinking(parsed_reasoning)
                        visible_text = sanitize_output(parsed_visible)
                        if reasoning_text and reasoning_parser.used_markers:
                            engine._log_reasoning_parser_fallback(
                                parser_mode="stream_fallback",
                                reasoning_chars=len(reasoning_text),
                                visible_chars=len(visible_text),
                            )
                    if reasoning_text:
                        yield from _emit_thinking(
                            engine,
                            thinking_guard,
                            reasoning_text,
                            suppression_state=thinking_suppression_state,
                        )
                    if visible_text:
                        engine._record_visible_output(visible_text)
                        yield StreamingEvent(kind="content", text=visible_text)
                chunk_done = bool(chunk.get("done", False))
                if chunk_done and reasoning_parser is not None and not native_thinking_seen:
                    tail_reasoning, tail_visible = reasoning_parser.flush()
                    sanitized_reasoning = engine._sanitize_thinking(tail_reasoning)
                    sanitized_visible = sanitize_output(tail_visible)
                    if sanitized_reasoning and reasoning_parser.used_markers:
                        engine._log_reasoning_parser_fallback(
                            parser_mode="stream_fallback",
                            reasoning_chars=len(sanitized_reasoning),
                            visible_chars=len(sanitized_visible),
                        )
                    if sanitized_reasoning:
                        yield from _emit_thinking(
                            engine,
                            thinking_guard,
                            sanitized_reasoning,
                        )
                    if sanitized_visible:
                        engine._record_visible_output(sanitized_visible)
                        yield StreamingEvent(kind="content", text=sanitized_visible)
                if not chunk_done and budget_tripped() and thinking_budget_abort_enabled():
                    thinking_budget_aborted = True
                    break
                if chunk_done:
                    engine._record_provider_usage(chunk)
                    chunk["_jenny_ttft_ms"] = current_time_to_first_token_ms(engine)
                    done_usage = build_usage_from_done_chunk(chunk, model_name=engine.model_name)
                    saw_terminal = True
                    terminal_done_reason = str(chunk.get("done_reason") or "stop")
                    break
        engine._complete_provider_request()
        finish_reason = _resolve_stream_terminal(
            engine,
            thinking_budget_aborted=thinking_budget_aborted,
            saw_terminal=saw_terminal,
            terminal_done_reason=terminal_done_reason,
            inband_error=inband_error,
            has_tool_calls=False,
        )
        yield StreamingEvent(kind="done", finish_reason=finish_reason, usage=done_usage)
    except urllib.error.URLError as error:
        engine._complete_provider_request()
        _raise_reasoning_effort_rejection(error, data)
        if engine._is_timeout_url_error(error):
            raise GenerationError(engine._timeout_message("Streaming generation")) from error
        raise EngineConnectionError(
            engine._describe_url_error(error, "streaming generation"),
            retryable=not isinstance(error, urllib.error.HTTPError),
        ) from error
    except (EngineConnectionError, ModelNotLoadedError):
        engine._complete_provider_request()
        raise
    except Exception as error:  # noqa: BLE001
        engine._complete_provider_request()
        raise_if_cancelled(cancel_handle)
        if engine._is_timeout_error(error):
            raise GenerationError(engine._timeout_message("Streaming generation")) from error
        if _is_retryable_transport_error(error):
            _raise_stream_transport_error(engine, error)
        raise GenerationError(f"Streaming generation failed: {error}") from error


def _engine_request_id(engine: Any) -> str | None:
    """Best-effort resolve the active request id so synthesized tool-call ids are
    deterministic across replays."""
    getter = getattr(engine, "_request_id", None)
    if not callable(getter):
        return None
    try:
        value = getter()
    except Exception:  # noqa: BLE001 — diagnostic-only.
        return None
    text = str(value or "").strip()
    return text or None


def stream_with_tools(
    engine: Any,
    *,
    prompt: str,
    tools: list[dict[str, Any]],
    max_tokens: int = 16384,
    temperature: float = 0.7,
    reasoning_effort: str | None = None,
    prompt_cache_enabled: bool = False,
    system: str = "",
    messages: list[Any] | None = None,
    response_format: ResponseFormat | None = None,
    cancel_handle: Any = None,
    wall_clock_deadline: float | None = None,
):
    """Yield streaming chunks progressively, then return GenerationResult with tool calls."""
    _ = prompt_cache_enabled
    engine._assert_ready()
    msgs = engine._build_messages(prompt, system, messages)
    data = _build_chat_request(
        engine,
        msgs=msgs,
        max_tokens=max_tokens,
        temperature=temperature,
        reasoning_effort=reasoning_effort,
        stream=True,
        tools=tools,
        response_format=response_format,
    )
    tools_payload = _as_list(data.get("tools"))
    _record_chat_request(engine, data, msgs, max_tokens, tools_payload)
    think_value = data.get("think")

    try:
        reasoning_parser = engine._create_request_reasoning_parser()
        thinking_guard = (
            ThinkingRepetitionGuard(
                max_chars=resolve_thinking_budget_chars(engine, max_tokens)
            )
            if _ollama_thinking_enabled(think_value) or reasoning_parser is not None
            else None
        )
        budget_tripped = budget_trip_check(thinking_guard)
        thinking_suppression_state = [False]
        native_thinking_seen = False
        thinking_accumulated = ""
        content_parts: list[str] = []
        thinking_parts: list[str] = []
        raw_tool_calls: list[dict[str, Any]] = []
        malformed_line_count = 0
        first_chunk_logged = False
        done_usage = None
        # Track whether the provider emitted explicit terminal evidence.
        thinking_budget_aborted = False
        saw_terminal = False
        terminal_done_reason = ""
        inband_error = ""
        _bare_thought_mode = False  # True while collecting bare thought prefix
        _bare_thought_done = False  # True after \n\n separator found
        _bare_thought_buf = ""  # accumulated content in bare thought mode
        # The normalizer is layered alongside the existing parser pipeline:
        # the parser produces the engine's actual yields; the normalizer
        # tracks classification counters and detects reasoning-only
        # completions for the chat-streaming fail-closed path.
        normalizer = ProviderStreamNormalizer(provider="ollama")
        url = f"{engine.host}/api/chat"
        req = urllib.request.Request(
            url,
            data=json.dumps(data).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        request_timeout = clamp_timeout_to_deadline(
            engine._request_timeout_seconds,
            wall_clock_deadline,
        )
        raise_if_cancelled(cancel_handle)
        # urllib does not expose an in-flight request handle until urlopen()
        # returns. Cancellation before response acquisition therefore relies
        # on this bounded socket timeout; once acquired, the response-close
        # callback below makes cancellation prompt.
        with urllib.request.urlopen(req, timeout=request_timeout) as response:
            for line in iter_cancel_aware_response_lines(response, cancel_handle):
                if not line:
                    continue
                if not first_chunk_logged:
                    engine._record_first_chunk()
                    first_chunk_logged = True
                try:
                    chunk = json.loads(line)
                except json.JSONDecodeError:
                    malformed_line_count = _note_malformed_stream_line(
                        engine, malformed_line_count, line
                    )
                    continue
                try:
                    normalizer.feed(chunk)
                except Exception:  # noqa: BLE001 — diagnostic-only.
                    pass
                inband_error = ollama_stream_inband_error(chunk)
                if inband_error:
                    saw_terminal = True
                    terminal_done_reason = FINISH_REASON_PROVIDER_ERROR
                    break
                message = _as_dict(chunk.get("message"))
                chunk_done = bool(chunk.get("done", False))
                thinking = engine._sanitize_thinking(str(message.get("thinking") or ""))
                if thinking:
                    native_thinking_seen = True
                    new_tail, thinking_accumulated = _thinking_delta(thinking_accumulated, thinking)
                    if new_tail:
                        yield from _emit_thinking(
                            engine,
                            thinking_guard,
                            new_tail,
                            suppression_state=thinking_suppression_state,
                            thinking_parts=thinking_parts,
                        )
                content = str(message.get("content") or "")
                if content:
                    # Detect bare "thought " prefix (model skipped <|channel>thought markers)
                    if (
                        not native_thinking_seen
                        and reasoning_parser is not None
                        and not _bare_thought_done
                        and (not content_parts or _bare_thought_mode)
                    ):
                        combined = _bare_thought_buf + content
                        combined_stripped = combined.lstrip()
                        starts_as_thought = combined_stripped.lower().startswith(
                            ("thought ", "thought\n")
                        )
                        if starts_as_thought or _bare_thought_mode:
                            _bare_thought_mode = True
                            _bare_thought_buf = combined
                            para_break = combined_stripped.find("\n\n")
                            if para_break != -1:
                                thinking_raw = combined_stripped[:para_break]
                                if thinking_raw.lower().startswith("thought "):
                                    thinking_raw = thinking_raw[len("thought ") :].strip()
                                remaining = combined_stripped[para_break + 2 :].strip()
                                if thinking_raw:
                                    suppressed = _thinking_suppressed(
                                        thinking_guard,
                                        thinking_raw,
                                    )
                                    if not suppressed:
                                        thinking_parts.append(thinking_raw)
                                        yield StreamingEvent(kind="thinking", text=thinking_raw)
                                if remaining:
                                    vis = sanitize_output(remaining)
                                    if vis:
                                        engine._record_visible_output(vis)
                                        content_parts.append(vis)
                                        yield StreamingEvent(kind="content", text=vis)
                                _bare_thought_mode = False
                                _bare_thought_done = True
                                _bare_thought_buf = ""
                            if (
                                not chunk_done
                                and budget_tripped()
                                and thinking_budget_abort_enabled()
                            ):
                                thinking_budget_aborted = True
                                break
                            if not chunk_done:
                                continue  # bypass normal path — still buffering or just processed
                            # Terminal chunk: this content was consumed by the
                            # bare-thought buffer above, but the done block below
                            # must still run (saw_terminal + buffer flush) — a
                            # bare `continue` here turned complete turns into
                            # finish_reason="incomplete" and dropped the buffer.
                            content = ""
                    visible_text = sanitize_output(content)
                    reasoning_text = ""
                    if reasoning_parser is not None and not native_thinking_seen:
                        parsed_reasoning, parsed_visible = reasoning_parser.feed(content)
                        reasoning_text = engine._sanitize_thinking(parsed_reasoning)
                        visible_text = sanitize_output(parsed_visible)
                        if reasoning_text and reasoning_parser.used_markers:
                            engine._log_reasoning_parser_fallback(
                                parser_mode="stream_fallback",
                                reasoning_chars=len(reasoning_text),
                                visible_chars=len(visible_text),
                            )
                    if reasoning_text:
                        yield from _emit_thinking(
                            engine,
                            thinking_guard,
                            reasoning_text,
                            suppression_state=thinking_suppression_state,
                            thinking_parts=thinking_parts,
                        )
                    if visible_text:
                        engine._record_visible_output(visible_text)
                        content_parts.append(visible_text)
                        yield StreamingEvent(kind="content", text=visible_text)
                # Collect native tool calls from streaming chunks; each is
                # also announced mid-stream (see ollama_tool_call_announce).
                # This runs BEFORE the budget-abort check so a complete tool
                # call arriving on the same chunk that trips the guard is
                # never dropped.
                chunk_tool_calls = _as_list(message.get("tool_calls"))
                for tc in chunk_tool_calls:
                    if isinstance(tc, dict):
                        announcement = build_tool_call_announcement(
                            tc,
                            position=len(raw_tool_calls),
                            request_id=_engine_request_id(engine),
                        )
                        raw_tool_calls.append(tc)
                        if announcement is not None:
                            yield announcement
                if not chunk_done and budget_tripped() and thinking_budget_abort_enabled():
                    thinking_budget_aborted = True
                    break
                if chunk_done:
                    # Flush any bare thought buffer that never saw a \n\n separator
                    if _bare_thought_mode and _bare_thought_buf:
                        thinking_raw = _bare_thought_buf.lstrip()
                        if thinking_raw.lower().startswith("thought "):
                            thinking_raw = thinking_raw[len("thought ") :].strip()
                        if thinking_raw:
                            suppressed = _thinking_suppressed(thinking_guard, thinking_raw)
                            if not suppressed:
                                thinking_parts.append(thinking_raw)
                                yield StreamingEvent(kind="thinking", text=thinking_raw)
                        _bare_thought_mode = False
                        _bare_thought_buf = ""
                    if reasoning_parser is not None and not native_thinking_seen:
                        tail_reasoning, tail_visible = reasoning_parser.flush()
                        sanitized_reasoning = engine._sanitize_thinking(tail_reasoning)
                        sanitized_visible = sanitize_output(tail_visible)
                        if sanitized_reasoning and reasoning_parser.used_markers:
                            engine._log_reasoning_parser_fallback(
                                parser_mode="stream_fallback",
                                reasoning_chars=len(sanitized_reasoning),
                                visible_chars=len(sanitized_visible),
                            )
                        if sanitized_reasoning:
                            yield from _emit_thinking(
                                engine,
                                thinking_guard,
                                sanitized_reasoning,
                                thinking_parts=thinking_parts,
                            )
                        if sanitized_visible:
                            engine._record_visible_output(sanitized_visible)
                            content_parts.append(sanitized_visible)
                            yield StreamingEvent(kind="content", text=sanitized_visible)
                    engine._record_provider_usage(chunk)
                    chunk["_jenny_ttft_ms"] = current_time_to_first_token_ms(engine)
                    done_usage = build_usage_from_done_chunk(chunk, model_name=engine.model_name)
                    saw_terminal = True
                    terminal_done_reason = str(chunk.get("done_reason") or "stop")
                    break
        engine._complete_provider_request()
        try:
            normalizer.finalize_for_counters()
        except Exception:  # noqa: BLE001 — diagnostic-only.
            pass
        record_counters_to_diagnostics(engine, normalizer)
        # Build final result with tool calls
        final_content = "".join(content_parts).strip()
        final_thinking = "".join(thinking_parts).strip()
        _request_id = _engine_request_id(engine)
        tool_calls = tuple(
            _native_tool_call_request(tc, i, _request_id)
            for i, tc in enumerate(item for item in raw_tool_calls if isinstance(item, dict))
        )
        inband_parse_failed = False
        if not tool_calls and final_content:
            known_names = frozenset(
                str((tool.get("function") or tool).get("name", "")) for tool in (tools or [])
            )
            extraction = extract_inband_tool_calls_detailed(final_content, known_names)
            inband_parse_failed = extraction.failed_attempt
            if extraction.calls:
                tool_calls = extraction.calls
                final_content = extraction.remaining_text
        finish_reason = _resolve_stream_terminal(
            engine,
            thinking_budget_aborted=thinking_budget_aborted,
            saw_terminal=saw_terminal,
            terminal_done_reason=terminal_done_reason,
            inband_error=inband_error,
            has_tool_calls=bool(tool_calls),
        )
        # Do not cache finish reason on the engine; cross-request state can
        # contaminate later streams, and consumers must use the current result
        # or terminal chunk.
        return GenerationResult(
            content=final_content,
            tool_calls=tool_calls,
            finish_reason=finish_reason,
            thinking_text=final_thinking or "",
            usage=done_usage,
            inband_tool_call_parse_failed=inband_parse_failed,
        )
    except urllib.error.URLError as error:
        engine._complete_provider_request()
        _raise_reasoning_effort_rejection(error, data)
        if engine._is_timeout_url_error(error):
            raise GenerationError(engine._timeout_message("Streaming generation")) from error
        raise EngineConnectionError(
            engine._describe_url_error(error, "streaming generation"),
            retryable=not isinstance(error, urllib.error.HTTPError),
        ) from error
    except (EngineConnectionError, ModelNotLoadedError):
        engine._complete_provider_request()
        raise
    except Exception as error:  # noqa: BLE001
        engine._complete_provider_request()
        raise_if_cancelled(cancel_handle)
        if engine._is_timeout_error(error):
            raise GenerationError(engine._timeout_message("Streaming generation")) from error
        if _is_retryable_transport_error(error):
            _raise_stream_transport_error(engine, error)
        raise GenerationError(f"Streaming generation failed: {error}") from error


def generate_with_tools_impl(
    engine: Any,
    *,
    prompt: str,
    tools: list[dict[str, Any]],
    max_tokens: int,
    temperature: float,
    reasoning_effort: str | None,
    prompt_cache_enabled: bool,
    system: str,
    messages: list[Any] | None,
    response_format: ResponseFormat | None,
) -> GenerationResult:
    _ = prompt_cache_enabled
    engine._assert_ready()
    msgs = engine._build_messages(prompt, system, messages)
    data = _build_chat_request(
        engine,
        msgs=msgs,
        max_tokens=max_tokens,
        temperature=temperature,
        reasoning_effort=reasoning_effort,
        stream=False,
        tools=tools,
        response_format=response_format,
    )
    tools_payload = _as_list(data.get("tools"))
    _record_chat_request(engine, data, msgs, max_tokens, tools_payload)

    try:
        response = engine._post("/api/chat", data)
        message = _as_dict(response.get("message"))
        content, thinking_text = _extract_content_and_thinking(engine, message)
        raw_calls = _as_list(message.get("tool_calls"))
        _request_id = _engine_request_id(engine)
        tool_calls = tuple(
            _native_tool_call_request(tc, i, _request_id)
            for i, tc in enumerate(item for item in raw_calls if isinstance(item, dict))
        )
        inband_parse_failed = False
        if not tool_calls and content:
            known_names = frozenset(
                str((tool.get("function") or tool).get("name", "")) for tool in (tools or [])
            )
            extraction = extract_inband_tool_calls_detailed(content, known_names)
            inband_parse_failed = extraction.failed_attempt
            if extraction.calls:
                tool_calls = extraction.calls
                content = extraction.remaining_text
        finish_reason = "tool_calls" if tool_calls else "stop"
        engine._record_first_chunk()
        if content:
            engine._record_visible_output(content)
        response["_jenny_ttft_ms"] = current_time_to_first_token_ms(engine)
        engine._complete_provider_request()
        # The non-streaming response body carries the same usage fields as the
        # streaming done-chunk (prompt_eval_count / eval_count).
        return GenerationResult(
            content=content,
            tool_calls=tool_calls,
            finish_reason=finish_reason,
            thinking_text=thinking_text,
            usage=build_usage_from_done_chunk(response, model_name=engine.model_name),
            inband_tool_call_parse_failed=inband_parse_failed,
        )
    except urllib.error.URLError as error:
        engine._complete_provider_request()
        _raise_reasoning_effort_rejection(error, data)
        if engine._is_timeout_url_error(error):
            raise GenerationError(engine._timeout_message("Generation")) from error
        raise EngineConnectionError(engine._describe_url_error(error, "generation")) from error
    except (EngineConnectionError, ModelNotLoadedError):
        engine._complete_provider_request()
        raise
    except Exception as error:  # noqa: BLE001
        engine._complete_provider_request()
        if engine._is_timeout_error(error):
            raise GenerationError(engine._timeout_message("Generation")) from error
        raise GenerationError(f"Generation failed: {error}") from error


def plain_generate_result(
    engine: Any,
    *,
    prompt: str,
    max_tokens: int,
    temperature: float,
    reasoning_effort: str | None,
    prompt_cache_enabled: bool,
    system: str,
    messages: list[Any] | None,
    response_format: ResponseFormat | None,
) -> GenerationResult:
    try:
        content = generate(
            engine,
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            prompt_cache_enabled=prompt_cache_enabled,
            system=system,
            messages=messages,
            response_format=response_format,
        )
    except EngineConnectionError as error:
        status = engine._extract_http_status(error)
        if status is None:
            raise
        raise GenerationError(
            f"Ollama request failed with HTTP {status} without tool-calling: {error}"
        ) from error
    return GenerationResult(content=str(content or "").strip(), finish_reason="stop")
