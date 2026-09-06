"""Provider/network retry helpers for non-streaming paths; turn-semantic retries
are owned by sidecar.runtime.turn_retry.
"""

from __future__ import annotations

import logging
import random
import re
import time
from dataclasses import dataclass
from typing import Any, Callable, TypeVar

from sidecar.ai.engines.provider_http import ProviderHttpError
from sidecar.ai.feature_flags import FEATURE_API_RETRY, is_feature_flag_enabled
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.multiplexer import TurnCancellationHandle

T = TypeVar("T")

MAX_PROVIDER_RETRY_ATTEMPTS = 10
MAX_PROVIDER_OVERLOAD_RETRIES = 3
BASE_DELAY_SECONDS = 0.5
MAX_DELAY_SECONDS = 32.0
MAX_RETRY_AFTER_SECONDS = 32.0
MAX_TOKENS_FLOOR = 3_000
CONTEXT_OVERFLOW_SAFETY_BUFFER = 1_000

QUERY_SOURCE_CHAT_SEND = "chat_send"
QUERY_SOURCE_VISION = "vision"
QUERY_SOURCE_BACKGROUND_SUMMARY = "background_summary"
QUERY_SOURCE_BACKGROUND_CLASSIFIER = "background_classifier"

_BACKGROUND_OVERLOAD_BAIL_SOURCES = frozenset(
    {
        QUERY_SOURCE_BACKGROUND_SUMMARY,
        QUERY_SOURCE_BACKGROUND_CLASSIFIER,
    }
)
_CONTEXT_OVERFLOW_RE = re.compile(
    r"input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class RetryExecutionContext:
    attempt: int
    max_tokens: int


def execute_with_provider_retry(
    *,
    operation: Callable[[RetryExecutionContext], T],
    logger: logging.Logger,
    component: str,
    event_prefix: str,
    request_source: str | None,
    provider: str,
    model: str,
    initial_max_tokens: int,
    feature_flags: dict[str, bool] | None,
    cancel_handle: TurnCancellationHandle | None = None,
    runtime: Any | None = None,
    before_retry: Callable[[RetryExecutionContext, ProviderHttpError], None] | None = None,
) -> T:
    max_tokens = max(1, int(initial_max_tokens))
    _raise_if_interrupted(runtime=runtime, cancel_handle=cancel_handle)
    if not is_feature_flag_enabled(feature_flags or {}, FEATURE_API_RETRY):
        return operation(RetryExecutionContext(attempt=1, max_tokens=max_tokens))

    consecutive_overload_errors = 0
    attempt = 1
    while True:
        _raise_if_interrupted(runtime=runtime, cancel_handle=cancel_handle)
        context = RetryExecutionContext(attempt=attempt, max_tokens=max_tokens)
        try:
            return operation(context)
        except ProviderHttpError as error:
            if error.classification == "server_overload":
                consecutive_overload_errors += 1
            else:
                consecutive_overload_errors = 0

            adjusted_max_tokens = _adjust_max_tokens_for_retry(error=error, current=max_tokens)
            if adjusted_max_tokens is not None:
                log_event(
                    logger,
                    logging.INFO,
                    component=component,
                    event=f"{event_prefix}.max_tokens_adjusted",
                    message="Retrying provider call with reduced max_tokens after context overflow.",
                    status="retrying",
                    data={
                        "attempt": attempt,
                        "provider": provider,
                        "model": model,
                        "source": request_source or "",
                        "classification": error.classification,
                        "previous_max_tokens": max_tokens,
                        "adjusted_max_tokens": adjusted_max_tokens,
                    },
                )
                if attempt >= MAX_PROVIDER_RETRY_ATTEMPTS:
                    raise
                if before_retry is not None:
                    before_retry(context, error)
                max_tokens = adjusted_max_tokens
                attempt += 1
                continue
            if error.classification == "context_overflow":
                raise

            if not _should_retry_error(
                error=error,
                attempt=attempt,
                consecutive_overload_errors=consecutive_overload_errors,
                request_source=request_source,
            ):
                raise

            delay_seconds = _compute_delay_seconds(
                attempt=attempt,
                retry_after_seconds=error.retry_after_seconds,
            )
            log_event(
                logger,
                logging.WARNING,
                component=component,
                event=f"{event_prefix}.attempt_failed",
                message="Provider call failed; retrying.",
                status="retrying",
                data={
                    "attempt": attempt,
                    "max_attempts": MAX_PROVIDER_RETRY_ATTEMPTS,
                    "delay_seconds": round(delay_seconds, 3),
                    "provider": provider,
                    "model": model,
                    "source": request_source or "",
                    "classification": error.classification,
                    "retryable": error.retryable,
                    "status_code": error.status_code,
                    "code": error.code,
                },
            )
            if before_retry is not None:
                before_retry(context, error)
            _wait_retry_delay(
                delay_seconds,
                cancel_handle=cancel_handle,
                runtime=runtime,
            )
            attempt += 1


def _raise_if_cancelled(cancel_handle: TurnCancellationHandle | None) -> None:
    if cancel_handle is not None:
        cancel_handle.raise_if_cancelled()


def _raise_if_interrupted(
    *,
    runtime: Any | None,
    cancel_handle: TurnCancellationHandle | None,
) -> None:
    if runtime is not None:
        runtime.raise_if_interrupted(
            message="turn working-time limit exceeded during provider retry",
        )
        return
    _raise_if_cancelled(cancel_handle)


def _wait_retry_delay(
    delay_seconds: float,
    *,
    cancel_handle: TurnCancellationHandle | None,
    runtime: Any | None = None,
) -> None:
    if runtime is not None:
        runtime.wait_interruptibly(
            delay_seconds,
            message="turn working-time limit exceeded during provider retry",
        )
        return
    if cancel_handle is None:
        time.sleep(delay_seconds)
        return
    cancel_handle.wait(delay_seconds)
    cancel_handle.raise_if_cancelled()


def _should_retry_error(
    *,
    error: ProviderHttpError,
    attempt: int,
    consecutive_overload_errors: int,
    request_source: str | None,
) -> bool:
    if not error.retryable:
        return False
    if error.classification == "server_overload":
        if request_source in _BACKGROUND_OVERLOAD_BAIL_SOURCES:
            return False
        if consecutive_overload_errors >= MAX_PROVIDER_OVERLOAD_RETRIES:
            return False
    return attempt < MAX_PROVIDER_RETRY_ATTEMPTS


def _compute_delay_seconds(*, attempt: int, retry_after_seconds: float | None) -> float:
    if retry_after_seconds is not None:
        return max(0.0, min(float(retry_after_seconds), MAX_RETRY_AFTER_SECONDS))
    base_delay = min(BASE_DELAY_SECONDS * (2 ** (attempt - 1)), MAX_DELAY_SECONDS)
    return base_delay + (random.random() * 0.25 * base_delay)  # noqa: S311


def _adjust_max_tokens_for_retry(
    *,
    error: ProviderHttpError,
    current: int,
) -> int | None:
    if error.classification != "context_overflow":
        return None
    message = str(error.body) if error.body is not None else str(error)
    parsed = _parse_context_overflow_details(message)
    if parsed is None:
        return None
    input_tokens, _max_tokens, context_limit = parsed
    available_context = max(0, context_limit - input_tokens - CONTEXT_OVERFLOW_SAFETY_BUFFER)
    if available_context < MAX_TOKENS_FLOOR:
        return None
    adjusted = max(MAX_TOKENS_FLOOR, available_context)
    if adjusted >= current:
        return None
    return adjusted


def _parse_context_overflow_details(message: str) -> tuple[int, int, int] | None:
    match = _CONTEXT_OVERFLOW_RE.search(message)
    if match is None:
        return None
    try:
        input_tokens = int(match.group(1))
        max_tokens = int(match.group(2))
        context_limit = int(match.group(3))
    except (TypeError, ValueError):
        return None
    return (input_tokens, max_tokens, context_limit)
