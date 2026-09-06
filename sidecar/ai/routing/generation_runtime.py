"""Generation/runtime helpers extracted from the router facade."""

from __future__ import annotations

import importlib
import logging
from contextlib import nullcontext
from dataclasses import replace as _dataclass_replace
from types import SimpleNamespace
from typing import Any

from sidecar.ai import config as _ai_config
from sidecar.ai import error_codes as _error_codes
from sidecar.ai.engines import provider_http as _provider_http
from sidecar.ai.routing import generation_diagnostics as _generation_diagnostics
from sidecar.ai.routing import generation_runtime_stream as _grs
from sidecar.ai.routing import generation_support as _generation_support
from sidecar.ai.routing import loop_events as _loop_events
from sidecar.ai.routing import retry as _retry
from sidecar.ai.routing import vision_turn as _vision_turn
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools import contracts as _tool_contracts
from sidecar.ai.tools import models as _tool_models
from sidecar.exceptions import CompanionError
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.local_engine.request_context import (
    current_diagnostics_store,
    scoped_chat_request_context,
)

logger = logging.getLogger(__name__)

LOCAL_FIRST_FALLBACK_ENGINES = _ai_config.LOCAL_FIRST_FALLBACK_ENGINES
ProviderHttpError = _provider_http.ProviderHttpError
CMP_CACHE_BREAK_DETECTED = _error_codes.CMP_CACHE_BREAK_DETECTED
CMP_LOOP_GENERATION_FAILED = _error_codes.CMP_LOOP_GENERATION_FAILED
FallbackTriggeredEvent = _loop_events.FallbackTriggeredEvent
QUERY_SOURCE_CHAT_SEND = _retry.QUERY_SOURCE_CHAT_SEND
execute_with_provider_retry = _retry.execute_with_provider_retry
ToolExecutionFailure = _tool_contracts.ToolExecutionFailure
GenerationResult = _tool_models.GenerationResult
resolve_effective_max_tokens = _generation_support.resolve_effective_max_tokens
strip_thinking_from_all_messages = _generation_support.strip_thinking_from_all_messages
# Re-export the moved streamed-generation entrypoint so
# ``generation_runtime.stream_generate_with_tools`` stays a hub global that
# router.py imports, ``generate_step`` calls by bare name, and the test suite
# monkeypatches.
stream_generate_with_tools = _grs.stream_generate_with_tools

_FALLBACK_ELIGIBLE_CLASSIFICATIONS = frozenset(
    {"api_timeout", "connection_error", "rate_limit", "server_error", "server_overload"}
)
_VISIBLE_STREAM_EVENT_TYPES = frozenset({"chat.token", "chat.thinking"})


def _vision_context(runtime: Any) -> tuple[Any, str]:
    """Current-turn images and their anchor text from the request context."""

    request_context = getattr(runtime, "request_context", None)
    return (
        getattr(request_context, "vision_images", ()),
        getattr(request_context, "vision_anchor_text", ""),
    )


def _log_vision_anchor_lost(iteration: int, image_count: int) -> None:
    log_event(
        logger, logging.WARNING, component="ai.router", event="ai.router.vision_anchor_lost",
        message="Vision anchor was lost after generation; continuing without images.",
        status="degraded", data={"iteration": iteration, "image_count": image_count},
    )


def build_compaction_generate_fn(
    kernel: Any,
    *,
    request_id: str,
    max_tokens: int,
    prompt_cache_enabled: bool,
    runtime: Any | None = None,
) -> Any:
    """Build a deadline-aware compaction generator on the canonical stream path."""

    compaction_runtime = LoopRuntime(
        request_id=request_id,
        trace_id=getattr(runtime, "trace_id", "") if runtime is not None else "",
        session_id=getattr(runtime, "session_id", "") if runtime is not None else "",
        wall_clock_deadline=(
            getattr(runtime, "wall_clock_deadline", None) if runtime is not None else None
        ),
        chunk_inactivity_seconds=(
            getattr(runtime, "chunk_inactivity_seconds", 120.0)
            if runtime is not None
            else 120.0
        ),
        model_load_grace_seconds=(
            getattr(runtime, "model_load_grace_seconds", 300.0)
            if runtime is not None
            else 300.0
        ),
        cancel_handle=getattr(runtime, "cancel_handle", None) if runtime is not None else None,
        request_context=(
            getattr(runtime, "request_context", None) if runtime is not None else None
        ),
    )

    def generate_fn(messages: list[Any]) -> str:
        result = execute_with_provider_retry(
            operation=lambda context: stream_generate_with_tools(
                kernel,
                runtime=compaction_runtime,
                latest_user_content="",
                prompt_messages=messages,
                max_tokens=context.max_tokens,
                reasoning_effort="low",
                prompt_cache_enabled=prompt_cache_enabled,
                system_prompt="",
                tool_schemas=[],
            )[0],
            logger=logger,
            component="ai.router",
            event_prefix="ai.router.compaction.retry",
            request_source=_retry.QUERY_SOURCE_BACKGROUND_SUMMARY,
            provider=kernel._config.engine_type,
            model=kernel._config.model,
            initial_max_tokens=max_tokens,
            feature_flags=kernel._config.feature_flags,
            cancel_handle=compaction_runtime.cancel_handle,
            runtime=compaction_runtime,
        )
        return str(result.content or "")

    return generate_fn


def _create_engine(runtime_config: Any) -> Any:
    factory_module = importlib.import_module("sidecar.ai.engines.factory")
    return factory_module.create_engine(runtime_config)


def _reset_stream_before_provider_retry(
    runtime: Any,
    attempt_event_types: set[str],
    retry_event_types: set[str],
) -> None:
    """Discard output from a failed streamed attempt before provider replay."""

    runtime.last_iteration_unflushed = []
    if not _VISIBLE_STREAM_EVENT_TYPES.intersection(attempt_event_types):
        return
    runtime.emit(_loop_events.StreamResetEvent(reason="provider_retry"))
    retry_event_types.add("chat.stream_reset")


def _system_prompt_for_generation(
    kernel: Any,
    system_prompt: Any,
    *,
    prompt_cache_enabled: bool,
) -> str:
    _ = prompt_cache_enabled
    return kernel._system_prompt_for_engine(system_prompt)


def _to_generation_result(candidate: Any) -> GenerationResult:
    if isinstance(candidate, GenerationResult):
        return candidate
    return GenerationResult(content=str(candidate or "").strip(), finish_reason="stop")


def _is_fallback_eligible(error: ProviderHttpError | Exception) -> bool:
    if isinstance(error, ProviderHttpError):
        return (
            error.retryable
            and error.classification in _FALLBACK_ELIGIBLE_CLASSIFICATIONS
        )
    return isinstance(error, (TimeoutError, ConnectionError, OSError))


def _is_retryable_generation_error(error: Exception) -> bool:
    if isinstance(error, CompanionError):
        return error.retryable is True
    return isinstance(error, (TimeoutError, ConnectionError, OSError))


def _generation_failure_metadata(error: Exception) -> dict[str, str]:
    error_code = str(getattr(error, "code", "") or "").strip()
    is_ai_error = error_code.startswith("CMP-AI-")
    category = "provider" if is_ai_error else "runtime"
    if isinstance(error, (TimeoutError, ConnectionError, OSError)) and not is_ai_error:
        category = "transport"
    return {
        "category": category,
        "error_type": type(error).__name__,
        "provider_code": error_code if is_ai_error else "",
        "error_message": str(getattr(error, "message", "") or error),
    }


def _fallback_reason(error: ProviderHttpError | Exception) -> str:
    if isinstance(error, ProviderHttpError):
        return f"{error.classification}: {error}"
    return f"{type(error).__name__}: {error}"


def _close_fallback_engine(
    engine: Any,
    *,
    fallback_label: str,
    runtime: Any | None,
) -> None:
    request_id = str(getattr(runtime, "request_id", "") or "")
    for action_name in ("unload_model", "close"):
        action = getattr(engine, action_name, None)
        if not callable(action):
            continue
        try:
            action()
        except Exception as error:  # noqa: BLE001 - cleanup steps remain isolated.
            log_event(
                logger,
                logging.WARNING,
                component="ai.router",
                event=f"ai.router.fallback_engine_{action_name}_failed",
                message=f"Fallback engine {action_name} failed during cleanup.",
                status="failure",
                data={
                    "fallback_model": fallback_label,
                    "error_type": type(error).__name__,
                },
                request_id=request_id,
            )


def _try_fallback(
    kernel: Any,
    error: ProviderHttpError | Exception,
    *,
    latest_user_content: str,
    working_messages: list[dict[str, object]],
    reasoning_effort: str | None,
    prompt_cache_enabled: bool,
    system_prompt: Any,
    tool_schemas: list[dict[str, Any]],
    runtime: Any | None,
) -> tuple[GenerationResult, set[str]] | None:
    if not kernel._config.fallback_models or not _is_fallback_eligible(error):
        return None
    return attempt_fallback_generation(
        kernel,
        original_error=error,
        latest_user_content=latest_user_content,
        working_messages=working_messages,
        reasoning_effort=reasoning_effort,
        prompt_cache_enabled=prompt_cache_enabled,
        system_prompt=system_prompt,
        tool_schemas=tool_schemas,
        runtime=runtime,
    )


def generate_step(
    kernel: Any,
    *,
    latest_user_content: str,
    working_messages: list[dict[str, object]],
    reasoning_effort: str | None,
    prompt_cache_enabled: bool,
    source_key: str,
    system_prompt: Any,
    tool_schemas: list[dict[str, Any]],
    cache_break_detector: Any | None,
    runtime: Any | None = None,
    response_format: Any | None = None,
) -> tuple[GenerationResult, set[str]]:
    images, anchor = _vision_context(runtime)
    prompt_messages = _vision_turn.engine_messages_with_vision_degradation(
        kernel._engine_messages,
        working_messages,
        primary_system_text=str(system_prompt),
        vision_images=images, vision_anchor_text=anchor, runtime=runtime,
        on_anchor_lost=_log_vision_anchor_lost,
    )
    max_tokens = resolve_effective_max_tokens(
        kernel._config.max_tokens,
        kernel._engine.get_model_max_output_tokens(),
        user_override=getattr(kernel._config, "resolved_user_max_output_tokens", None),
    )
    if cache_break_detector is not None:
        cache_break_detector.record_prompt_state(
            source_key,
            system_prompt,
            tool_schemas,
    )
    request_id = getattr(runtime, "request_id", "") if runtime is not None else ""
    _generation_diagnostics.record_request_fingerprint_if_available(
        kernel,
        request_id=request_id,
        system_prompt=system_prompt,
        tool_schemas=tool_schemas,
    )
    attempt_stream_event_types: set[str] = set()
    retry_stream_event_types: set[str] = set()

    def _before_retry(_context: Any, _error: ProviderHttpError) -> None:
        if runtime is None or not runtime.streaming:
            return
        _reset_stream_before_provider_retry(
            runtime,
            attempt_stream_event_types,
            retry_stream_event_types,
        )
    try:
        generated, streamed_event_types = execute_with_provider_retry(
            operation=(
                lambda context: (
                    stream_generate_with_tools(
                        kernel,
                        runtime=runtime,
                        latest_user_content=latest_user_content,
                        prompt_messages=prompt_messages,
                        max_tokens=context.max_tokens,
                        reasoning_effort=reasoning_effort,
                        prompt_cache_enabled=prompt_cache_enabled,
                        system_prompt=system_prompt,
                        tool_schemas=tool_schemas,
                        response_format=response_format,
                        event_types_sink=attempt_stream_event_types,
                    )
                    if runtime is not None and runtime.streaming
                    else (
                        kernel._engine.generate_with_tools(
                            prompt=latest_user_content,
                            tools=tool_schemas,
                            max_tokens=context.max_tokens,
                            temperature=kernel._config.temperature,
                            reasoning_effort=(
                                reasoning_effort or kernel._config.reasoning_effort or None
                            ),
                            prompt_cache_enabled=prompt_cache_enabled,
                            system=kernel._system_prompt_for_engine(system_prompt),
                            messages=prompt_messages,
                            response_format=response_format,
                        ),
                        set(),
                    )
                )
            ),
            logger=logger,
            component="ai.router",
            event_prefix="ai.router.retry",
            request_source=QUERY_SOURCE_CHAT_SEND,
            provider=kernel._config.engine_type,
            model=kernel._config.model,
            initial_max_tokens=max_tokens,
            feature_flags=kernel._config.feature_flags,
            cancel_handle=runtime.cancel_handle if runtime is not None else None,
            runtime=runtime,
            before_retry=(
                _before_retry if runtime is not None and runtime.streaming else None
            ),
        )
    except ProviderHttpError as error:
        log_event(
            logger,
            logging.ERROR,
            component="ai.router",
            event="ai.router.generation_failed",
            message=f"model generation failed: {error}",
            status="failure",
            data={
                "error_type": type(error).__name__,
                "classification": error.classification,
                "status_code": error.status_code,
                "code": CMP_LOOP_GENERATION_FAILED,
                "provider_code": error.code,
                "retryable": error.retryable,
            },
        )
        fallback_result = _try_fallback(
            kernel,
            error,
            latest_user_content=latest_user_content,
            working_messages=working_messages,
            reasoning_effort=reasoning_effort,
            prompt_cache_enabled=prompt_cache_enabled,
            system_prompt=system_prompt,
            tool_schemas=tool_schemas,
            runtime=runtime,
        )
        if fallback_result is not None:
            return fallback_result
        raise ToolExecutionFailure(
            code=CMP_LOOP_GENERATION_FAILED,
            message=f"model generation failed: {error}",
            retryable=error.retryable,
            error_details={
                "category": "provider",
                # provider_code alone cannot identify a 401: CMP-CLOUD-1003 also covers
                # 5xx and context_overflow. Electron's one-shot auth retry keys on this.
                "classification": error.classification,
                "error_type": type(error).__name__,
                "provider_code": error.code,
                "error_message": str(error),
            },
        ) from error
    except (TerminalChatStateError, ToolExecutionFailure):
        raise
    except Exception as error:  # noqa: BLE001
        retryable = _is_retryable_generation_error(error)
        failure_metadata = _generation_failure_metadata(error)
        log_event(
            logger,
            logging.ERROR,
            component="ai.router",
            event="ai.router.generation_failed",
            message=f"model generation failed: {error}",
            status="failure",
            data={
                "error_type": type(error).__name__,
                "code": CMP_LOOP_GENERATION_FAILED,
                "provider_code": failure_metadata["provider_code"],
                "category": failure_metadata["category"],
                "retryable": retryable,
            },
        )
        fallback_result = _try_fallback(
            kernel,
            error,
            latest_user_content=latest_user_content,
            working_messages=working_messages,
            reasoning_effort=reasoning_effort,
            prompt_cache_enabled=prompt_cache_enabled,
            system_prompt=system_prompt,
            tool_schemas=tool_schemas,
            runtime=runtime,
        )
        if fallback_result is not None:
            return fallback_result
        raise ToolExecutionFailure(
            code=CMP_LOOP_GENERATION_FAILED,
            message=f"model generation failed: {error}",
            retryable=retryable,
            error_details=failure_metadata,
        ) from error
    streamed_event_types.update(retry_stream_event_types)
    result = _to_generation_result(generated)
    raw_usage = result.usage.raw_usage if result.usage is not None else {}
    if cache_break_detector is not None and isinstance(raw_usage, dict) and raw_usage:
        cache_read_tokens = kernel._cache_usage_tokens(
            raw_usage,
            "cache_read_input_tokens",
            "cache_read_tokens",
        )
        cache_creation_tokens = kernel._cache_usage_tokens(
            raw_usage,
            "cache_creation_input_tokens",
            "cache_write_tokens",
        )
        cache_break = cache_break_detector.check_response_for_cache_break(
            source_key,
            cache_read_tokens,
        )
        if cache_break.detected:
            log_event(
                logger,
                logging.WARNING,
                component="ai.router",
                event="ai.router.prompt_cache_break_detected",
                message="Prompt cache break detected",
                status="degraded",
                data={
                    "code": CMP_CACHE_BREAK_DETECTED,
                    "cache_read_tokens": cache_read_tokens,
                    "cache_creation_tokens": cache_creation_tokens,
                    "reason": cache_break.reason,
                    "changed_categories": list(cache_break.changed_categories),
                },
                request_id=source_key,
            )
    return result, streamed_event_types


def attempt_fallback_generation(
    kernel: Any,
    *,
    original_error: ProviderHttpError | Exception,
    latest_user_content: str,
    working_messages: list[dict[str, object]],
    reasoning_effort: str | None,
    prompt_cache_enabled: bool,
    system_prompt: Any,
    tool_schemas: list[dict[str, Any]],
    runtime: Any | None,
) -> tuple[GenerationResult, set[str]] | None:
    for fallback_model in kernel._config.fallback_models:
        normalized_engine_type = str(fallback_model.engine_type or "").strip().lower()
        fallback_label = f"{normalized_engine_type}/{fallback_model.model}"
        if normalized_engine_type not in LOCAL_FIRST_FALLBACK_ENGINES:
            log_event(
                logger,
                logging.WARNING,
                component="ai.router",
                event="ai.router.fallback_non_local_skipped",
                message="Skipped unsupported fallback engine per local-first policy.",
                status="skipped",
                data={"fallback_model": fallback_label},
            )
            continue
        fallback_engine: Any | None = None
        try:
            primary_engine_type = str(kernel._config.engine_type or "").strip().lower()
            overrides: dict[str, Any] = {
                "engine_type": normalized_engine_type,
                "model": fallback_model.model,
                "fallback_models": (),
            }
            if normalized_engine_type != primary_engine_type:
                # A primary custom endpoint belongs to that engine protocol.
                # Clearing it lets the destination factory resolve its own
                # canonical default; same-engine fallbacks retain the endpoint.
                overrides["api_url"] = None
            if fallback_model.max_context_tokens is not None:
                overrides["context_length"] = fallback_model.max_context_tokens
            fallback_config = _dataclass_replace(kernel._config, **overrides)

            selection = _create_engine(fallback_config)
            fallback_engine = selection.engine
            if selection.fallback_from is not None:
                log_event(
                    logger,
                    logging.WARNING,
                    component="ai.router",
                    event="ai.router.fallback_engine_init_failed",
                    message=f"Fallback engine {fallback_label} could not be created, skipping",
                    status="skipped",
                    data={
                        "fallback_from": selection.fallback_from,
                        "reason": selection.fallback_reason,
                    },
                )
                continue

            images, anchor = _vision_context(runtime)
            if images and not _vision_turn.engine_supports_vision(fallback_engine):
                log_event(
                    logger,
                    logging.WARNING,
                    component="ai.router",
                    event="ai.router.vision_fallback_skipped",
                    message="Skipped fallback engine without vision support.",
                    status="skipped",
                    data={"fallback_model": fallback_label},
                )
                continue
            fallback_messages = strip_thinking_from_all_messages(working_messages)
            prompt_messages = _vision_turn.engine_messages_with_vision_degradation(
                kernel._engine_messages,
                fallback_messages,
                primary_system_text=str(system_prompt),
                vision_images=images, vision_anchor_text=anchor, runtime=runtime,
                on_anchor_lost=_log_vision_anchor_lost,
            )
            max_tokens = resolve_effective_max_tokens(
                fallback_config.max_tokens,
                fallback_engine.get_model_max_output_tokens(),
                user_override=getattr(fallback_config, "resolved_user_max_output_tokens", None),
            )

            fallback_runtime = LoopRuntime(
                request_id=str(getattr(runtime, "request_id", "") or ""),
                trace_id=str(getattr(runtime, "trace_id", "") or ""),
                session_id=str(getattr(runtime, "session_id", "") or ""),
                wall_clock_deadline=getattr(runtime, "wall_clock_deadline", None),
                chunk_inactivity_seconds=float(
                    getattr(runtime, "chunk_inactivity_seconds", 120.0) or 120.0
                ),
                model_load_grace_seconds=float(
                    getattr(runtime, "model_load_grace_seconds", 300.0) or 300.0
                ),
                cancel_handle=getattr(runtime, "cancel_handle", None),
                request_context=getattr(runtime, "request_context", None),
            )
            fallback_kernel = SimpleNamespace(
                _engine=fallback_engine,
                _config=fallback_config,
                _system_prompt_for_engine=kernel._system_prompt_for_engine,
            )
            request_context = getattr(runtime, "request_context", None)
            context_scope = (
                scoped_chat_request_context(
                    fallback_engine,
                    request_context=request_context,
                    runtime_config=fallback_config,
                    diagnostics_store=current_diagnostics_store(kernel._engine),
                )
                if request_context is not None
                else nullcontext()
            )
            with context_scope:
                generated, _fallback_events = stream_generate_with_tools(
                    fallback_kernel,
                    runtime=fallback_runtime,
                    latest_user_content=latest_user_content,
                    prompt_messages=prompt_messages,
                    max_tokens=max_tokens,
                    reasoning_effort=reasoning_effort,
                    prompt_cache_enabled=prompt_cache_enabled,
                    system_prompt=system_prompt,
                    tool_schemas=tool_schemas,
                )

            if runtime is not None:
                runtime.emit(
                    FallbackTriggeredEvent(
                        original_model=f"{kernel._config.engine_type}/{kernel._config.model}",
                        fallback_model=fallback_label,
                        reason=_fallback_reason(original_error),
                    )
                )

            log_event(
                logger,
                logging.INFO,
                component="ai.router",
                event="ai.router.fallback_succeeded",
                message=f"Fallback to {fallback_label} succeeded",
                status="success",
                data={"original_error": str(original_error), "fallback_model": fallback_label},
            )
            return _to_generation_result(generated), set()

        except TerminalChatStateError:
            raise
        except Exception as fallback_error:  # noqa: BLE001
            log_event(
                logger,
                logging.WARNING,
                component="ai.router",
                event="ai.router.fallback_failed",
                message=f"Fallback to {fallback_label} also failed: {fallback_error}",
                status="failure",
                data={"fallback_model": fallback_label, "error": str(fallback_error)},
            )
            continue
        finally:
            if fallback_engine is not None:
                _close_fallback_engine(
                    fallback_engine,
                    fallback_label=fallback_label,
                    runtime=runtime,
                )

    return None
